/**
 * What ky asks the user before it acts for them, as the page, the sockets and
 * each kind's owner see it. An approval is the user's alone: a tool can only
 * ask, and the answer comes from the user's own tap on their socket. Only
 * typebox and types, so the page and Node load it as it is.
 */
import Type, { type Static } from "typebox";

/**
 * What an approval is for: an Executor app action, a call a run on a webhook's data asks to make
 * (src/inbound/inbound.ts), or an API call with a credential that isn't a GET or HEAD. Each kind has its row in
 * APPROVAL_KINDS and one handler (src/server.ts).
 */
export const ApprovalKindSchema = Type.Union([Type.Literal("executor"), Type.Literal("webhook-action"), Type.Literal("secret-request")]);

export type ApprovalKind = Static<typeof ApprovalKindSchema>;

/** How each kind shows: the card's title. Every kind's approvals show as cards in their chat, and a push tells the user when they aren't there. */
export const APPROVAL_KINDS: Readonly<Record<ApprovalKind, { readonly title: string }>> = {
  executor: { title: "Approve this app action?" },
  "webhook-action": { title: "Approve this, on a webhook's data?" },
  "secret-request": { title: "Approve this call with a credential?" }
};

/**
 * The tables approvals keep, which a restore puts back (src/tables.ts): the approvals (approvals.ts), and
 * Executor's tool policies and input requests (executor.ts). A pending approval restored into a new deploy
 * expires on its tap, as Executor there doesn't have its request.
 */
export const APPROVAL_TABLES = { approvals: "ky_approvals", policies: "ky_tool_policies", inputs: "ky_executor_inputs" } as const;

/**
 * Where an approval stands: waiting on the user, decided by them, or gone before what it asked for could happen.
 * Every write names the status it moves from, so none overwrites another.
 */
export const ApprovalStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("declined"),
  Type.Literal("cancelled"),
  Type.Literal("expired")
]);

export type ApprovalStatus = Static<typeof ApprovalStatusSchema>;

/** The user's answer: accept, decline this one, or cancel what asked altogether. */
export const ApprovalActionSchema = Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")]);

export type ApprovalAction = Static<typeof ApprovalActionSchema>;

/** What a tap on one that isn't waiting any more is told. */
export const GONE = "That approval isn't waiting any more.";

/** How ky treats an Executor tool that needs approval, as the user sets it in Settings › Executor. */
export const ToolPolicySchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("block")]);

export type ToolPolicy = Static<typeof ToolPolicySchema>;

/** A pending approval as the page shows its card, in the chat `chat`. */
export type ApprovalView = {
  readonly id: string;
  readonly kind: ApprovalKind;
  /** What it acts on: an app tool's path. */
  readonly subject: string;
  /** What will happen, in the asker's own words. */
  readonly summary: string;
  readonly chat: string;
  readonly createdAt: number;
};

/** An Executor tool's policy, for each tool that has asked before or has one set. */
export type ToolPolicyView = { readonly tool: string; readonly policy: ToolPolicy };
