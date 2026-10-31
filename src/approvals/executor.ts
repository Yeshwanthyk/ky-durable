import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import { type CallResult, type ExecutorCall, type ExecutorConfig, type ExecutorGate, type ResumeAction, resultText } from "../executor/contract";
import { callOnce } from "../executor/wiring";
import { outsideWhy } from "../outside/contract";
import { OutsideContent } from "../outside/outside";
import type { Approval, ApprovalHandler, Asker, Settle } from "./approvals";
import { type ApprovalAction, APPROVAL_TABLES, NOBODY_ANSWERED, type ToolPolicy, type ToolPolicyView } from "./contract";

const POLICIES = APPROVAL_TABLES.policies;

const INPUTS = APPROVAL_TABLES.inputs;

const Paused = Schema.Struct({
  status: Schema.Literals(["approval-required", "input-required"]),
  requestId: Schema.String,
  message: Schema.optionalKey(Schema.String),
  toolPath: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String)
});

type Paused = typeof Paused.Type;

const pausedOf = Schema.decodeUnknownOption(Schema.fromJsonString(Paused));

const PolicyRow = Schema.Struct({ tool: Schema.String, policy: Schema.Literals(["allow", "ask", "block"]) });

const policyOf = Schema.decodeUnknownOption(PolicyRow);

const unavailable = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.optionalKey(Schema.String) }))
);

const payloadOf = Schema.decodeUnknownOption(Schema.Struct({ tool: Schema.String, message: Schema.String }));

const note = (result: CallResult, text: string): CallResult => ({ output: [...result.output, { type: "text", text: `\n\n${text}` }], isError: result.isError === true });

const gone = (result: CallResult): boolean => Option.isSome(unavailable(resultText(result)));

/** The policy a tool runs on in a conversation, and where the user set it, as a note names it. */
type Governing = { readonly policy: ToolPolicy; readonly where: string };

/** Allow runs a tool by itself only for the user in their own turn, in a conversation no outside content reached (src/outside). */
function verdict(policy: ToolPolicy, present: boolean, marked: boolean): ToolPolicy {
  if (policy === "allow" && (!present || marked)) return "ask";

  return policy;
}

const BEFORE_CARDS =
  "A request from before ky's approval cards has no card, and can't be approved or cancelled any more: Executor lets it lapse. Check with a read-only program whether anything happened, tell the user, and run the program again only once they say so; then it asks with a card.";

const CHOSE: Record<ApprovalAction, string> = { accept: "approved", decline: "declined", cancel: "cancelled" };

export type ExecutorApprovalDeps = {
  readonly config: () => Promise<ExecutorConfig | null>;
  readonly present: (session: string) => boolean;
  /** Whether nobody can answer a card for the turn in `session`: an automation's run, a look, a dream or a mail's triage. */
  readonly unattended: (session: string) => boolean;
  readonly tell: (session: string, content: string, requestId: string) => Promise<void>;
  /** The policy the owner of `session` (a specialist) set for `tool`, over ky's; undefined to follow ky's. */
  readonly ownPolicy: (session: string, tool: string) => { readonly owner: string; readonly policy: ToolPolicy } | undefined;
};

class Store extends Context.Service<
  Store,
  {
    policyFor(tool: string): Effect.Effect<ToolPolicy>;
    setPolicy(tool: string, policy: ToolPolicy): Effect.Effect<void>;
    readonly policies: Effect.Effect<ReadonlyArray<ToolPolicyView>>;
    asked(tool: string): Effect.Effect<boolean>;
    input(requestId: string, conversation: string): Effect.Effect<void>;
    owns(requestId: string, conversation: string): Effect.Effect<boolean>;
    resumed(requestId: string): Effect.Effect<void>;
  }
>()("ky/approvals/ExecutorStore") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ${POLICIES} (tool TEXT PRIMARY KEY, policy TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${INPUTS} (request_id TEXT PRIMARY KEY, conversation TEXT NOT NULL, created_at INTEGER NOT NULL)`);

      return Store.of({
        policyFor: (tool) =>
          Effect.map(exec(`SELECT tool, policy FROM ${POLICIES} WHERE tool = ?`, tool), ([row]) => Option.match(policyOf(row), { onNone: () => "ask", onSome: (found) => found.policy })),
        setPolicy: Effect.fnUntraced(function* (tool, policy) {
          const now = yield* Clock.currentTimeMillis;
          yield* exec(`INSERT OR REPLACE INTO ${POLICIES} (tool, policy, updated_at) VALUES (?, ?, ?)`, tool, policy, now);
        }),
        policies: Effect.orDie(sql.rows(PolicyRow, `SELECT tool, policy FROM ${POLICIES} ORDER BY tool`)),
        asked: Effect.fnUntraced(function* (tool) {
          const now = yield* Clock.currentTimeMillis;
          const added = yield* exec(`INSERT INTO ${POLICIES} (tool, policy, updated_at) VALUES (?, 'ask', ?) ON CONFLICT (tool) DO NOTHING RETURNING tool`, tool, now);

          return added.length > 0;
        }),
        input: Effect.fnUntraced(function* (requestId, conversation) {
          const now = yield* Clock.currentTimeMillis;
          yield* exec(`INSERT OR REPLACE INTO ${INPUTS} (request_id, conversation, created_at) VALUES (?, ?, ?)`, requestId, conversation, now);
        }),
        owns: (requestId, conversation) =>
          Effect.map(exec(`SELECT request_id FROM ${INPUTS} WHERE request_id = ? AND conversation = ?`, requestId, conversation), (found) => found.length > 0),
        resumed: (requestId) => Effect.asVoid(exec(`DELETE FROM ${INPUTS} WHERE request_id = ?`, requestId))
      });
    })
  );
}

export class ExecutorApprovals implements ExecutorGate, ApprovalHandler {
  readonly #edge: Edge<Store | OutsideContent>;
  readonly #approvals: Asker;
  readonly #deps: ExecutorApprovalDeps;
  readonly #listeners = new Set<() => void>();

  constructor(storage: DurableObjectStorage, approvals: Asker, deps: ExecutorApprovalDeps) {
    this.#edge = makeEdge(Layer.mergeAll(Store.layer, OutsideContent.layer).pipe(Layer.provide(Sql.layer(storage))));
    this.#approvals = approvals;
    this.#deps = deps;
    this.#edge.run(Effect.void);
  }

  onPolicies(listener: () => void): void {
    this.#listeners.add(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  policyFor(tool: string): ToolPolicy {
    return this.#edge.run(Store.use((store) => store.policyFor(tool)));
  }

  setPolicy(tool: string, policy: ToolPolicy): void {
    this.#edge.run(Store.use((store) => store.setPolicy(tool, policy)));
    this.#changed();
  }

  policies(): ReadonlyArray<ToolPolicyView> {
    return this.#edge.run(Store.use((store) => store.policies));
  }

  replied(result: CallResult, conversation: string, call: ExecutorCall): Promise<CallResult> {
    return this.#paused(result, conversation, call, this.#deps.present(conversation));
  }

  async #paused(result: CallResult, conversation: string, call: ExecutorCall, present: boolean): Promise<CallResult> {
    const decoded = result.isError === true ? Option.none() : pausedOf(resultText(result));

    if (Option.isNone(decoded)) return result;
    const paused = decoded.value;

    if (paused.status === "input-required") {
      this.#edge.run(Store.use((store) => store.input(paused.requestId, conversation)));

      return result;
    }

    return this.#gated(result, paused, conversation, call, present);
  }

  /** An approval Executor paused on, settled by the tool's policy: declined, accepted, or asked of the user on a card. */
  async #gated(result: CallResult, paused: Paused, conversation: string, call: ExecutorCall, present: boolean): Promise<CallResult> {
    const tool = paused.toolPath ?? paused.tool ?? "";

    if (tool !== "" && this.#edge.run(Store.use((store) => store.asked(tool)))) this.#changed();
    const { policy, where } = this.#policyOf(conversation, tool);
    const why = this.#why(conversation);
    const decided = verdict(policy, present, why !== undefined);
    const decline = async () => resultText(await call("resume", { requestId: paused.requestId, response: { action: "decline" } }));

    if (decided === "block") {
      return note(result, `ky declined this request: the user set ${tool} to Block in ${where}. Executor answered: ${await decline()}\nTell the user it was blocked, and don't try it another way.`);
    }

    // A background run would sit on a card nobody is there to tap: refused now, so its report says what it needs.
    if (decided === "ask" && this.#deps.unattended(conversation)) {
      return note(
        result,
        `ky declined this request: this is a background run, and nobody is here to approve ${tool || "it"}. Executor answered: ${await decline()}\n` +
          "Don't try it another way. Say in your report that it needs the user's OK; they can ask for it from a chat."
      );
    }

    if (decided === "allow") {
      const accepted = await this.#paused(await call("resume", { requestId: paused.requestId, response: { action: "accept" } }), conversation, call, present);

      return note(accepted, `ky approved ${tool} itself: the user set it to Allow in ${where}.`);
    }

    const carded = this.#carded(paused, tool, conversation, present, why);

    return note(result, policy === "allow" && present ? `${carded}\nky asked though ${tool} is set to Allow: ${why}, outside content that may have led to it.` : carded);
  }

  /** The policy `tool` runs on in `conversation`, and where the user set it: its owner's own, else ky's; a call naming no tool asks. */
  #policyOf(conversation: string, tool: string): Governing {
    const own = tool === "" ? undefined : this.#deps.ownPolicy(conversation, tool);

    if (own !== undefined) return { policy: own.policy, where: `@${own.owner}'s settings` };

    return { policy: tool === "" ? "ask" : this.policyFor(tool), where: "Settings › Executor" };
  }

  /** What outside content `conversation` read, as a card says it (src/outside); undefined for none. */
  #why(conversation: string): string | undefined {
    const marks = this.#edge.run(OutsideContent.use((outside) => outside.marked(conversation)));

    return marks.length === 0 ? undefined : outsideWhy(marks.map((mark) => mark.source));
  }

  #carded(paused: Paused, tool: string, conversation: string, present: boolean, why: string | undefined): string {
    const message = paused.message?.trim() || "an action in your apps";

    const id = this.#approvals.requestApproval({
      kind: "executor",
      ref: paused.requestId,
      subject: tool,
      summary: why === undefined ? message : `${message} (asked because ${why})`,
      payload: { tool, message },
      conversation
    });

    return present
      ? `ky showed the user a card for this request (approval ${id}); only their tap on it approves it, and you can't. In a sentence or two, tell them what it will do: what is sent, changed or deleted, where, and to whom, decoding what they can't read. Then stop: you'll hear here what they chose.`
      : `Nobody here can approve this. It waits for the user as a card in their chat (approval ${id}), and they were notified; you can't approve it. Say it waits for the user, and finish.`;
  }

  #ownsInput(requestId: string, conversation: string): boolean {
    return this.#edge.run(Store.use((store) => store.owns(requestId, conversation)));
  }

  beforeResume(requestId: string, action: ResumeAction, conversation: string): string | undefined {
    const asked = this.#approvals.byRef("executor", requestId);

    if (asked && asked.conversation !== conversation && asked.chat !== conversation) return `Request ${requestId} belongs to another conversation.`;

    if (action === "answer") {
      if (this.#ownsInput(requestId, conversation)) return undefined;

      return asked
        ? `Request ${requestId} is an approval: only the user's tap on its card approves it. Tell them it waits there.`
        : `ky has no input request ${requestId} from this conversation. An approval is only ever approved by the user's tap on its card. ${BEFORE_CARDS}`;
    }

    if (asked) return this.#approvals.withdraw(asked.id, action) ? undefined : "The user already decided this request on its card, or it expired.";

    if (this.#ownsInput(requestId, conversation)) return undefined;

    return `ky has no request ${requestId} from this conversation, so it can't ${action} it. ${BEFORE_CARDS}`;
  }

  resumed(requestId: string): void {
    this.#edge.run(Store.use((store) => store.resumed(requestId)));
  }

  #tell(approval: Approval, action: ApprovalAction, text: string): Promise<void> {
    const payload = Option.getOrElse(payloadOf(approval.payload), () => ({ tool: approval.subject, message: approval.summary }));
    const what = `"${payload.message}"${payload.tool ? ` (${payload.tool})` : ""}`;

    return this.#deps.tell(approval.chat, `[the user ${CHOSE[action]} ${what}${text}`, `approval:${approval.id}:${crypto.randomUUID()}`);
  }

  async decide(approval: Approval, action: ApprovalAction, settle: Settle): Promise<void> {
    const tell = (text: string) => this.#tell(approval, action, text);

    try {
      await this.#carry(approval, action, settle, tell);
    } catch (error) {
      await tell(`, but carrying it out failed: ${error instanceof Error ? error.message : String(error)}. Check with a read-only program whether it happened, and tell the user]`);
    }
  }

  lost(approval: Approval, action: ApprovalAction): Promise<void> {
    return this.#tell(
      approval,
      action,
      ", but ky restarted before it finished, so the tap may not have gone through. The card is back: if they tap it again and Executor no longer has the request, check with a read-only program whether it happened]"
    );
  }

  async lapsed(approval: Approval): Promise<void> {
    const payload = Option.getOrElse(payloadOf(approval.payload), () => ({ tool: approval.subject, message: approval.summary }));
    const what = `"${payload.message}"${payload.tool ? ` (${payload.tool})` : ""}`;
    const config = await this.#deps.config().catch(() => null);

    // Executor may have let the request go already; declined either way, so no late tap can run it.
    if (config) await callOnce(config, "resume", { requestId: approval.ref, response: { action: "decline" } }).catch(() => undefined);

    return this.#deps.tell(
      approval.chat,
      `[${NOBODY_ANSWERED} to approve ${what}, so ky declined it and its card shows expired. Nothing was sent. Ask again if it still matters]`,
      `approval:${approval.id}:${crypto.randomUUID()}`
    );
  }

  async #carry(approval: Approval, action: ApprovalAction, settle: Settle, tell: (text: string) => Promise<void>): Promise<void> {
    const retry = async (why: string) => {
      settle.reopen();
      await tell(`, but ky couldn't reach Executor (${why}), so nothing was sent. The card is back: they can tap it again]`);
    };

    let config: ExecutorConfig | null;

    try {
      config = await this.#deps.config();
    } catch (error) {
      return retry(error instanceof Error ? error.message : String(error));
    }

    if (!config) {
      settle.expire();

      return tell(", but Executor isn't connected any more, so nothing was sent to it]");
    }

    const call: ExecutorCall = async (name, args) => (await callOnce(config, name, args)).result;
    const { result, neverRan } = await callOnce(config, "resume", { requestId: approval.ref, response: { action } });

    if (neverRan) return retry(resultText(result).slice(0, 300));

    if (gone(result)) {
      settle.expire();

      return tell(
        `, but Executor no longer has request ${approval.ref}: it expired. If they approved it, check with a read-only program whether the action happened anyway, for example by looking in Sent. Then tell the user, and ask again before you try anything new]`
      );
    }

    if (result.isError === true) {
      return tell(`, but Executor answered with an error: ${resultText(result).slice(0, 300)}. It may have happened anyway: check with a read-only program, and tell the user]`);
    }

    const after = await this.#paused(result, approval.chat, call, true);

    await tell(` with a tap. Executor answered:]\n${resultText(after)}`);
  }
}
