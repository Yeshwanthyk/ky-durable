import Type from "typebox";
import { decode, decodeOr, parseOr } from "../core/decode";
import { type CallResult, type ExecutorCall, type ExecutorConfig, type ExecutorGate, type ResumeAction, callOnce } from "../executor";
import type { ApprovalRequest, Approvals } from "./approvals";
import { type ToolPolicy, ToolPolicySchema, type ToolPolicyView } from "./contract";

/**
 * Executor's approvals belong to the user. A tool that needs approval pauses
 * its program (`status: "approval-required"`); ky, not the model, takes the
 * pause: by the tool's policy it declines it, accepts it, or, by default,
 * asks the user with a card. The user's tap comes over their own socket, and
 * ky resumes the program at Executor itself. The model can decline or cancel
 * a request and answer one that asked for input, but it has no way to accept
 * one: in a peer's conversation, a routine or the user's own chat alike.
 *
 * The policy, as in bdots: `policyFor` reads the user's setting for the tool
 * (ask unless they set it), and `decide` weighs it against who is there.
 * Block declines. Allow accepts only while the user is in the chat; with
 * nobody there it asks, so nothing approves itself. Ask always shows a card;
 * with nobody there the turn can't wait for it, so it goes on without, and the
 * user is notified (src/approvals/approvals.ts).
 */

/** A paused program as Executor answers in model mode, by the fields ky reads. */
const Paused = Type.Object({
  status: Type.Union([Type.Literal("approval-required"), Type.Literal("input-required")]),
  requestId: Type.String(),
  message: Type.Optional(Type.String()),
  /** The app tool that asked, when Executor names it. */
  toolPath: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String())
});

const PolicyTool = Type.Object({ tool: Type.String() });

/** Executor's answer to a resume of a request it no longer has. */
const Unavailable = Type.Object({ status: Type.Literal("unavailable"), reason: Type.Optional(Type.String()) });

/** What an approval row of kind executor keeps: enough to resume it. */
const Payload = Type.Object({ requestId: Type.String(), tool: Type.String(), message: Type.String() });

const textOf = (result: CallResult) => result.output.map((part) => part.text).join("\n");

const note = (result: CallResult, text: string): CallResult => ({ output: [...result.output, { type: "text", text: `\n\n${text}` }], isError: result.isError === true });

/** Whether a resume found the request gone: Executor's `unavailable`, or a failure that says not found or expired. */
function gone(result: CallResult): boolean {
  const text = textOf(result);

  if (parseOr(Unavailable, text, undefined)) return true;

  return result.isError === true && /not[ _-]?found|expired/i.test(text);
}

/** bdots' decide: the user's policy for a tool, weighed against whether the user is there to answer. */
function decide(policy: ToolPolicy, present: boolean): ToolPolicy {
  if (policy === "allow" && !present) return "ask";

  return policy;
}

export type ExecutorApprovalDeps = {
  /** Executor's connection now, or null once it is gone. */
  readonly config: () => Promise<ExecutorConfig | null>;
  /** Whether a session is a chat the user is in. */
  readonly chat: (session: string) => boolean;
  /** Tell a chat what came of its approval, between turns. */
  readonly tell: (session: string, content: string, requestId: string) => Promise<void>;
};

export class ExecutorApprovals implements ExecutorGate {
  readonly #sql: SqlStorage;
  readonly #approvals: Approvals;
  readonly #deps: ExecutorApprovalDeps;

  constructor(sql: SqlStorage, approvals: Approvals, deps: ExecutorApprovalDeps) {
    this.#sql = sql;
    this.#approvals = approvals;
    this.#deps = deps;
    sql.exec("CREATE TABLE IF NOT EXISTS ky_tool_policies (tool TEXT PRIMARY KEY, policy TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    // The requests that asked for input, which the model may answer; an approval is never among them.
    sql.exec("CREATE TABLE IF NOT EXISTS ky_executor_inputs (request_id TEXT PRIMARY KEY, conversation TEXT NOT NULL, created_at INTEGER NOT NULL)");
    approvals.handle("executor", { decide: (approval, action) => this.#decided(approval.id, action) });
  }

  /** The user's policy for an app tool: ask unless they set one. */
  policyFor(tool: string): ToolPolicy {
    const [row] = this.#sql.exec("SELECT policy FROM ky_tool_policies WHERE tool = ?", tool).toArray();

    return decodeOr(ToolPolicySchema, row?.policy, "ask");
  }

  /** Set a tool's policy; ask is the default, so setting it back forgets the tool's row. */
  setPolicy(tool: string, policy: ToolPolicy): void {
    if (policy === "ask") this.#sql.exec("DELETE FROM ky_tool_policies WHERE tool = ?", tool);
    else this.#sql.exec("INSERT OR REPLACE INTO ky_tool_policies (tool, policy, updated_at) VALUES (?, ?, ?)", tool, policy, Date.now());
  }

  /** Each tool that has asked for approval or has a policy, as Settings › Executor lists them. */
  policies(): ToolPolicyView[] {
    const set = this.#sql
      .exec("SELECT tool FROM ky_tool_policies ORDER BY tool")
      .toArray()
      .map((row) => decode(PolicyTool, row, "A stored tool policy").tool);

    const tools = [...new Set([...this.#approvals.subjects("executor"), ...set])];

    return tools.map((tool) => ({ tool, policy: this.policyFor(tool) }));
  }

  async replied(result: CallResult, conversation: string, call: ExecutorCall): Promise<CallResult> {
    const paused = result.isError === true ? undefined : parseOr(Paused, textOf(result), undefined);

    if (paused === undefined) return result;

    if (paused.status === "input-required") {
      this.#sql.exec("INSERT OR REPLACE INTO ky_executor_inputs (request_id, conversation, created_at) VALUES (?, ?, ?)", paused.requestId, conversation, Date.now());

      return result;
    }

    const tool = paused.toolPath ?? paused.tool ?? "";
    const message = paused.message?.trim() || "an action in your apps";

    const request: ApprovalRequest = {
      kind: "executor",
      subject: tool,
      summary: message,
      payload: { requestId: paused.requestId, tool, message },
      conversation
    };

    const present = this.#deps.chat(conversation);
    const verdict = decide(tool === "" ? "ask" : this.policyFor(tool), present);

    if (verdict === "block") {
      this.#approvals.recordDecided(request, "decline");
      const declined = await call("resume", { requestId: paused.requestId, response: { action: "decline" } });

      return note(result, `ky declined this request: the user set ${tool} to Block in Settings › Executor. Executor answered: ${textOf(declined)}\nTell the user it was blocked, and don't try it another way.`);
    }

    if (verdict === "allow") {
      this.#approvals.recordDecided(request, "accept");
      const accepted = await this.replied(await call("resume", { requestId: paused.requestId, response: { action: "accept" } }), conversation, call);

      return note(accepted, `ky approved ${tool} itself: the user set it to Allow in Settings › Executor.`);
    }

    const id = this.#approvals.requestApproval(request);

    return note(
      result,
      present
        ? `ky showed the user a card for this request (approval ${id}); only their tap on it approves it, and you can't. In a sentence or two, tell them what it will do: what is sent, changed or deleted, where, and to whom, decoding what they can't read. Then stop: you'll hear here what they chose.`
        : `Nobody here can approve this. It waits for the user as a card in their chat (approval ${id}), and they were notified; you can't approve it. Say it waits for the user, and finish.`
    );
  }

  beforeResume(requestId: string, action: ResumeAction, conversation: string): string | undefined {
    const waiting = this.#approvals.pendingBy("executor", "requestId", requestId);

    if (waiting && waiting.conversation !== conversation && waiting.chat !== conversation) return `Request ${requestId} belongs to another conversation.`;

    if (action !== "answer") {
      // The model may turn an approval down on the user's word; the card goes with it, unless the user tapped first.
      if (waiting && !this.#approvals.withdraw(waiting.id, action)) return "The user already decided this request on its card.";

      return undefined;
    }

    const inputs = this.#sql.exec("SELECT request_id FROM ky_executor_inputs WHERE request_id = ?", requestId).toArray();

    if (inputs.length > 0) return undefined;

    return waiting
      ? `Request ${requestId} is an approval: only the user's tap on its card approves it. Tell them it waits there.`
      : `ky has no input request ${requestId}. An approval is only ever approved by the user's tap on its card. One from before ky's approval cards has no card and can't be approved any more: cancel it, check with a read-only program whether anything happened, tell the user, and run the program again only once they say so; then it asks with a card.`;
  }

  resumed(requestId: string): void {
    this.#sql.exec("DELETE FROM ky_executor_inputs WHERE request_id = ?", requestId);
  }

  /** The user's tap: ky resumes the program at Executor itself, and the chat hears what came of it. */
  async #decided(id: string, action: "accept" | "decline" | "cancel"): Promise<{ refused: string } | Record<string, never>> {
    const approval = this.#approvals.get(id);
    const payload = decodeOr(Payload, approval?.payload, undefined);

    if (!approval || !payload) return { refused: "That approval isn't waiting any more." };
    const what = `"${payload.message}"${payload.tool ? ` (${payload.tool})` : ""}`;
    const chose = action === "accept" ? "approved" : action === "decline" ? "declined" : "cancelled";
    const config = await this.#deps.config();

    if (!config) {
      this.#approvals.expire(id);
      await this.#deps.tell(approval.chat, `[the user ${chose} ${what}, but Executor isn't connected any more, so nothing was sent to it]`, `approval:${id}`);

      return { refused: "Executor isn't connected, so nothing was sent." };
    }

    const call: ExecutorCall = (name, args) => callOnce(config, name, args);
    const result = await call("resume", { requestId: payload.requestId, response: { action } });

    if (gone(result)) {
      this.#approvals.expire(id);
      await this.#deps.tell(
        approval.chat,
        `[the user ${chose} ${what}, but Executor no longer has request ${payload.requestId}: it expired. If they approved it, check with a read-only program whether the action happened anyway, for example by looking in Sent. Then tell the user, and ask again before you try anything new]`,
        `approval:${id}`
      );

      return { refused: "Executor no longer has that request, so it expired. ky told the chat." };
    }

    // What comes next, as another pause, is asked in the chat where the user just tapped.
    const after = await this.replied(result, approval.chat, call);

    await this.#deps.tell(approval.chat, `[the user ${chose} ${what} with a tap. Executor answered:]\n${textOf(after)}`, `approval:${id}`);

    return {};
  }
}
