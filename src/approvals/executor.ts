import Type from "typebox";
import { decode, decodeOr, parseOr } from "../core/decode";
import { type CallResult, type ExecutorCall, type ExecutorConfig, type ExecutorGate, type ResumeAction, callOnce, resultText } from "../executor";
import type { Approval, ApprovalHandler, Asker, Settle } from "./approvals";
import { type ApprovalAction, APPROVAL_TABLES, type ToolPolicy, ToolPolicySchema, type ToolPolicyView } from "./contract";

/**
 * Executor's approvals belong to the user. A tool that needs approval pauses
 * its program (`status: "approval-required"`); ky, not the model, takes the
 * pause: by the tool's policy it declines it, accepts it, or, by default,
 * asks the user with a card. The user's tap comes over their own socket, and
 * ky resumes the program at Executor itself. The model can decline or cancel
 * a request and answer one that asked for input, but it has no way to accept
 * one: in a peer's conversation, a routine or the user's own chat alike.
 *
 * The policy: `policyFor` reads the user's setting for the tool, ask until
 * they set one, and `verdict` weighs it against whether the user is there.
 * Block declines. Allow accepts only in a turn the user started in their
 * chat; in any other turn it asks, so nothing approves itself with nobody
 * there. Ask always shows a card; with nobody there the turn can't wait for
 * it, so it goes on without, and the user is notified
 * (src/approvals/approvals.ts).
 */

const POLICIES = APPROVAL_TABLES.policies;

const INPUTS = APPROVAL_TABLES.inputs;

/** A paused program as Executor answers in model mode, by the fields ky reads. */
const Paused = Type.Object({
  status: Type.Union([Type.Literal("approval-required"), Type.Literal("input-required")]),
  requestId: Type.String(),
  message: Type.Optional(Type.String()),
  /** The app tool that asked, when Executor names it. */
  toolPath: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String())
});

const PolicyRow = Type.Object({ tool: Type.String(), policy: ToolPolicySchema });

/** Executor's answer to a resume of a request it no longer has. */
const Unavailable = Type.Object({ status: Type.Literal("unavailable"), reason: Type.Optional(Type.String()) });

/** What an approval row of kind executor keeps besides its requestId (its ref). */
const Payload = Type.Object({ tool: Type.String(), message: Type.String() });

const note = (result: CallResult, text: string): CallResult => ({ output: [...result.output, { type: "text", text: `\n\n${text}` }], isError: result.isError === true });

/** Whether a resume found the request gone: Executor answers `{"status":"unavailable"}` for a request it no longer has. */
const gone = (result: CallResult): boolean => parseOr(Unavailable, resultText(result), undefined) !== undefined;

/** The user's policy for a tool, weighed against whether the user is there to answer: Allow with nobody there asks. */
function verdict(policy: ToolPolicy, present: boolean): ToolPolicy {
  if (policy === "allow" && !present) return "ask";

  return policy;
}

const BEFORE_CARDS =
  "A request from before ky's approval cards has no card, and can't be approved or cancelled any more: Executor lets it lapse. Check with a read-only program whether anything happened, tell the user, and run the program again only once they say so; then it asks with a card.";

const CHOSE: Record<ApprovalAction, string> = { accept: "approved", decline: "declined", cancel: "cancelled" };

export type ExecutorApprovalDeps = {
  /** Executor's connection now, or null once it is gone. */
  readonly config: () => Promise<ExecutorConfig | null>;
  /** Whether the user is in the turn running in `session` (src/server.ts userHere). */
  readonly present: (session: string) => boolean;
  /** Tell a chat what came of its approval, between turns. */
  readonly tell: (session: string, content: string, requestId: string) => Promise<void>;
};

export class ExecutorApprovals implements ExecutorGate, ApprovalHandler {
  readonly #sql: SqlStorage;
  readonly #approvals: Asker;
  readonly #deps: ExecutorApprovalDeps;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage, approvals: Asker, deps: ExecutorApprovalDeps) {
    this.#sql = sql;
    this.#approvals = approvals;
    this.#deps = deps;
    // Each tool that asked, with the user's policy for it: ask until they set another.
    sql.exec(`CREATE TABLE IF NOT EXISTS ${POLICIES} (tool TEXT PRIMARY KEY, policy TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    // The requests that asked for input, which the model may answer; an approval is never among them.
    sql.exec(`CREATE TABLE IF NOT EXISTS ${INPUTS} (request_id TEXT PRIMARY KEY, conversation TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }

  /** Called when a tool's policy is set, or a tool asks for the first time. */
  onPolicies(listener: () => void): void {
    this.#listeners.add(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** The user's policy for an app tool: ask unless they set one. */
  policyFor(tool: string): ToolPolicy {
    const [row] = this.#sql.exec(`SELECT tool, policy FROM ${POLICIES} WHERE tool = ?`, tool).toArray();

    return decodeOr(PolicyRow, row, undefined)?.policy ?? "ask";
  }

  setPolicy(tool: string, policy: ToolPolicy): void {
    this.#sql.exec(`INSERT OR REPLACE INTO ${POLICIES} (tool, policy, updated_at) VALUES (?, ?, ?)`, tool, policy, Date.now());
    this.#changed();
  }

  /** Each tool that has asked for approval or has a policy, as Settings › Executor lists them. */
  policies(): ToolPolicyView[] {
    return this.#sql
      .exec(`SELECT tool, policy FROM ${POLICIES} ORDER BY tool`)
      .toArray()
      .map((row) => decode(PolicyRow, row, "A stored tool policy"));
  }

  /** A tool asked: Settings lists it from now on, at ask. */
  #asked(tool: string): void {
    if (tool === "") return;

    const added = this.#sql.exec(`INSERT INTO ${POLICIES} (tool, policy, updated_at) VALUES (?, 'ask', ?) ON CONFLICT (tool) DO NOTHING RETURNING tool`, tool, Date.now()).toArray();

    if (added.length > 0) this.#changed();
  }

  replied(result: CallResult, conversation: string, call: ExecutorCall): Promise<CallResult> {
    return this.#paused(result, conversation, call, this.#deps.present(conversation));
  }

  async #paused(result: CallResult, conversation: string, call: ExecutorCall, present: boolean): Promise<CallResult> {
    const paused = result.isError === true ? undefined : parseOr(Paused, resultText(result), undefined);

    if (paused === undefined) return result;

    if (paused.status === "input-required") {
      this.#sql.exec(`INSERT OR REPLACE INTO ${INPUTS} (request_id, conversation, created_at) VALUES (?, ?, ?)`, paused.requestId, conversation, Date.now());

      return result;
    }

    const tool = paused.toolPath ?? paused.tool ?? "";
    const message = paused.message?.trim() || "an action in your apps";

    this.#asked(tool);
    const decided = verdict(tool === "" ? "ask" : this.policyFor(tool), present);

    if (decided === "block") {
      const declined = await call("resume", { requestId: paused.requestId, response: { action: "decline" } });

      return note(result, `ky declined this request: the user set ${tool} to Block in Settings › Executor. Executor answered: ${resultText(declined)}\nTell the user it was blocked, and don't try it another way.`);
    }

    if (decided === "allow") {
      const accepted = await this.#paused(await call("resume", { requestId: paused.requestId, response: { action: "accept" } }), conversation, call, present);

      return note(accepted, `ky approved ${tool} itself: the user set it to Allow in Settings › Executor.`);
    }

    const id = this.#approvals.requestApproval({
      kind: "executor",
      ref: paused.requestId,
      subject: tool,
      summary: message,
      payload: { tool, message },
      conversation
    });

    return note(
      result,
      present
        ? `ky showed the user a card for this request (approval ${id}); only their tap on it approves it, and you can't. In a sentence or two, tell them what it will do: what is sent, changed or deleted, where, and to whom, decoding what they can't read. Then stop: you'll hear here what they chose.`
        : `Nobody here can approve this. It waits for the user as a card in their chat (approval ${id}), and they were notified; you can't approve it. Say it waits for the user, and finish.`
    );
  }

  /** Whether `conversation` holds Executor's request for input `requestId`. */
  #ownsInput(requestId: string, conversation: string): boolean {
    return this.#sql.exec(`SELECT request_id FROM ${INPUTS} WHERE request_id = ? AND conversation = ?`, requestId, conversation).toArray().length > 0;
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

    // The model may turn an approval down on the user's word; the card goes with it, unless the user tapped first.
    if (asked) return this.#approvals.withdraw(asked.id, action) ? undefined : "The user already decided this request on its card, or it expired.";

    if (this.#ownsInput(requestId, conversation)) return undefined;

    return `ky has no request ${requestId} from this conversation, so it can't ${action} it. ${BEFORE_CARDS}`;
  }

  resumed(requestId: string): void {
    this.#sql.exec(`DELETE FROM ${INPUTS} WHERE request_id = ?`, requestId);
  }

  /** Tell `approval`'s chat that the user's `action` on it came to `text`. Each is its own notice: a card put back and tapped again is told again. */
  #tell(approval: Approval, action: ApprovalAction, text: string): Promise<void> {
    const payload = decodeOr(Payload, approval.payload, { tool: approval.subject, message: approval.summary });
    const what = `"${payload.message}"${payload.tool ? ` (${payload.tool})` : ""}`;

    return this.#deps.tell(approval.chat, `[the user ${CHOSE[action]} ${what}${text}`, `approval:${approval.id}:${crypto.randomUUID()}`);
  }

  /**
   * The user's tap, after it was answered: ky resumes the program at Executor itself, and the chat hears what came of
   * it. A request Executor no longer has expires. Only a resume that provably never reached Executor puts the card
   * back, so the user can tap again; one that reached it and failed may have acted, so it stays decided, and the chat
   * is told to check.
   */
  async decide(approval: Approval, action: ApprovalAction, settle: Settle): Promise<void> {
    const tell = (text: string) => this.#tell(approval, action, text);

    try {
      await this.#carry(approval, action, settle, tell);
    } catch (error) {
      // It may have reached Executor before it threw, so the card stays decided.
      await tell(`, but carrying it out failed: ${error instanceof Error ? error.message : String(error)}. Check with a read-only program whether it happened, and tell the user]`);
    }
  }

  /** A restart cut off the tap on `approval` before it was carried out; it waits for a tap again. Executor takes a request once, so a second tap can't do it twice. */
  lost(approval: Approval, action: ApprovalAction): Promise<void> {
    return this.#tell(
      approval,
      action,
      ", but ky restarted before it finished, so the tap may not have gone through. The card is back: if they tap it again and Executor no longer has the request, check with a read-only program whether it happened]"
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

    // It reached Executor, so the program may have gone on and acted before the error: the card stays decided.
    if (result.isError === true) {
      return tell(`, but Executor answered with an error: ${resultText(result).slice(0, 300)}. It may have happened anyway: check with a read-only program, and tell the user]`);
    }

    // What comes next, as another pause, is asked in the chat where the user just tapped; they are there.
    const after = await this.#paused(result, approval.chat, call, true);

    await tell(` with a tap. Executor answered:]\n${resultText(after)}`);
  }
}
