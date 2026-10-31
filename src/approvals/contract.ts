import Type, { type Static } from "typebox";

export const ApprovalKindSchema = Type.Union([
  Type.Literal("executor"),
  Type.Literal("webhook-action"),
  Type.Literal("secret-request"),
  Type.Literal("browser-handoff"),
  Type.Literal("browse-steps")
]);

export type ApprovalKind = Static<typeof ApprovalKindSchema>;

export const APPROVAL_KINDS: Readonly<Record<ApprovalKind, { readonly title: string }>> = {
  executor: { title: "Approve this app action?" },
  "webhook-action": { title: "Approve this, on a webhook's data?" },
  "secret-request": { title: "Approve this call with a credential?" },
  "browser-handoff": { title: "ky needs you in its browser" },
  "browse-steps": { title: "Let ky act where you're signed in?" }
};

export const APPROVAL_TABLES = { approvals: "ky_approvals", policies: "ky_tool_policies", inputs: "ky_executor_inputs" } as const;

const ApprovalStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("declined"),
  Type.Literal("cancelled"),
  Type.Literal("expired")
]);

export type ApprovalStatus = Static<typeof ApprovalStatusSchema>;

export const ApprovalActionSchema = Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")]);

export type ApprovalAction = Static<typeof ApprovalActionSchema>;

export const GONE = "That approval isn't waiting any more.";

/** A card nobody answered gets one push reminder after this long… */
export const APPROVAL_REMIND_MS = 4 * 3_600_000;

/** …and lapses after this long: it shows as expired, and the chat that asked is told. */
export const APPROVAL_EXPIRE_MS = 24 * 3_600_000;

export const NOBODY_ANSWERED = "Nobody answered within 24 hours";

export const ToolPolicySchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("block")]);

export type ToolPolicy = Static<typeof ToolPolicySchema>;

export type ApprovalView = {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly subject: string;
  readonly summary: string;
  readonly chat: string;
  readonly createdAt: number;
  /** When it lapsed unanswered; its card then shows as expired, with no buttons. */
  readonly lapsedAt?: number;
  /** A page the card opens for the user, such as a hand-off's live view. */
  readonly link?: string;
};

export type ToolPolicyView = { readonly tool: string; readonly policy: ToolPolicy };
