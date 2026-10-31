/**
 * Client → server: every message the browser may send on its socket, as schemas. sockets.ts checks
 * each frame against ClientMessageSchema once, at the edge, and answers one that fails with an error
 * frame; past that, a handler gets exactly its message's shape. protocol.ts takes the type from here.
 * Commands with an `id` get a `result` or `error` back.
 *
 * The Worker loads this file, the page never does: it only needs the type.
 */
import Type, { type TSchema } from "typebox";
import { parseOr } from "./core/decode";
import { ApprovalActionSchema, ToolPolicySchema } from "./approvals/contract";
import { AutomationActionSchema, AutomationDraftSchema } from "./automations/contract";
import { ProactivityLevelSchema, RIGHT_AWAY_MOST, SoulChangeSchema } from "./dreaming/contract";
import { MachineLoginSchema, MachineStateSchema } from "./machines/contract";
import { ModelChoiceSchema, PurposeSchema } from "./settings/contract";
import { AccessChangeSchema, SkillChange, SpecialistDraftSchema } from "./skills/contract";
import type { PiServerMessage } from "./protocol";
import { CardAnswerSchema } from "./cards/contract";

const Text = Type.String();

const Texts = Type.Immutable(Type.Array(Text));

/** pi-ai's text and image parts: what a user message holds besides plain text. */
const TextPart = Type.Object({ type: Type.Literal("text"), text: Text, textSignature: Type.Optional(Text) });

const ImagePart = Type.Object({ type: Type.Literal("image"), data: Text, mimeType: Text });

/** pi's UserInput: plain text, or text and image parts. images.ts checks the parts' count and size. */
const UserInputSchema = Type.Union([Text, Type.Array(Type.Union([TextPart, ImagePart]))]);

export const SubscriptionKindSchema = Type.Union([Type.Literal("claude"), Type.Literal("chatgpt"), Type.Literal("github")]);

/** A message of `type` with `fields`, and the optional `id` its answer comes back by. */
function message<Kind extends string, Fields extends Record<string, TSchema>>(type: Kind, fields: Fields) {
  return Type.Object({ type: Type.Literal(type), id: Type.Optional(Text), ...fields });
}

export const ClientMessageSchema = Type.Union([
  message("submit", {
    input: UserInputSchema,
    whenBusy: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
    operationId: Type.Optional(Text),
    /** The message answers a card ky showed: what was chosen, kept beside it for the card to read back. */
    card: Type.Optional(CardAnswerSchema),
    /**
     * How long the message waited on the device before this send, in ms: a page that was offline kept it. Measured
     * on the device, so its clock being off doesn't matter. A long wait puts a note for the model after the words.
     */
    waited: Type.Optional(Type.Number({ minimum: 0 }))
  }),
  message("abort", {}),
  /** Stop the step the run is on, so what is queued goes in now rather than after it. */
  message("steer-now", {}),
  /** Take back a message still queued behind the run; answers false once pi has placed it. */
  message("withdraw", { operationId: Text }),
  message("reset", { handoff: Type.Optional(Text) }),
  /** Ask for a fresh snapshot. */
  message("resync", {}),
  /** Stop a subagent's current work or a machine task; queued machine runs are withdrawn. */
  message("stop-task", { task: Text }),
  message("stop-all", {}),
  /** Send a machine task a message: it steers a working task, or resumes a finished one. */
  message("send-task", { task: Text, message: Text }),
  /** Set whether ky may give a machine work, or what it is for. */
  message("set-machine", {
    machine: Text,
    state: Type.Optional(MachineStateSchema),
    note: Type.Optional(Text),
    login: Type.Optional(MachineLoginSchema)
  }),
  /**
   * Set ky's GitHub repo, owner/name, for self-edits, and this page's origin as ky's address; an empty repo
   * clears it. The result is `{ refused }` when it cannot be saved.
   */
  message("set-repo", { repo: Text }),
  /** Keep the Claude subscription: what `claude setup-token` prints. The result is `{ refused }` when it isn't one. Never sent back. */
  message("set-claude", { token: Text }),
  /** The repos a GitHub token reaches: the result is `{ repos }` or `{ refused }`. The token is never sent back. */
  message("github-repos", { token: Text }),
  /** Keep a GitHub token for the cloud machine and the repos it may touch; the result is `{ refused }` when it can't. */
  message("set-github", { token: Text, repos: Texts }),
  /** Forget a subscription; tasks sign in with their machine's own login. */
  message("remove-subscription", { kind: SubscriptionKindSchema }),
  /** Connect Executor: ky lists its tools with the token before keeping it. The result is `{ refused }` when it can't. */
  message("set-executor", { url: Text, token: Text }),
  /** Forget Executor; its tools go away. */
  message("remove-executor", {}),
  /** Start ChatGPT's device code sign-in; the result is `{ userCode, verificationUrl, loginId }`. */
  message("chatgpt-login", {}),
  /** How a ChatGPT sign-in is going: the result is "pending", "done" or `{ error }`. */
  message("chatgpt-poll", { login: Text }),
  /** The peers, each checked with a call to it; the result is PeerView[]. */
  message("peer-list", {}),
  /** Make an invite for a peer this ky will call `name`; the result is a PeerInvite or `{ refused }`. */
  message("peer-invite", { name: Text }),
  /** Pair with the ky at `address` with its invite code, calling it `name`; the result is `{ refused }` when it can't. */
  message("peer-pair", { name: Text, address: Text, code: Text }),
  /** Unpair a peer, both ways; the result is `{ refused }` when there is none by that name. */
  message("peer-remove", { name: Text }),
  /** What Settings › Mail shows, as a MailView. */
  message("mail-view", {}),
  /** Send a mail held for the user, and allow its address from then on; the result is `{ refused }` when it can't. */
  message("mail-approve", { mail: Text }),
  /** Discard a mail held for the user; the result is `{ refused }` when it isn't held. */
  message("mail-discard", { mail: Text }),
  /** Forget an allowed address: ky asks again before writing to it. */
  message("mail-disallow", { address: Text }),
  /** The user's tap on an approval's card; the result is `{ refused }` when it isn't waiting any more or what it asked for is gone. */
  message("approval-decide", { approval: Text, action: ApprovalActionSchema }),
  /** How ky treats an Executor tool that needs approval: allow, ask (the default) or block. */
  message("set-tool-policy", { tool: Text, policy: ToolPolicySchema }),
  /** Start a side chat; the result is `{ session }`. */
  message("new-chat", {}),
  /** Archive a side chat, or unarchive it with `archived: false`. */
  message("archive-chat", { session: Text, archived: Type.Boolean() }),
  /** Name a side chat; a blank title leaves it as it was. */
  message("rename-chat", { session: Text, title: Text }),
  /** Make specialists a chat's members, the main chat's or a side chat's: a group chat. None makes it a plain chat. */
  message("chat-members", { session: Text, members: Texts }),
  /** Change a skill as the user: edit, archive, restore, or revert it. */
  message("skill-change", { change: SkillChange }),
  /** A skill's versions, newest first, as the result. */
  message("skill-history", { name: Text }),
  /** Change SOUL.md as the user: edit, patch, or revert it. */
  message("soul-change", { change: SoulChangeSchema }),
  /** SOUL.md's versions, newest first, as the result. */
  message("soul-history", {}),
  /** Create a specialist (`create: true`, with a brief) or change its description, model or machine. */
  message("specialist-save", { specialist: Text, create: Type.Optional(Type.Boolean()), draft: SpecialistDraftSchema }),
  /** Change a specialist's brief as the user: edit, patch, or revert it. */
  message("specialist-brief", { specialist: Text, change: SoulChangeSchema }),
  /** A specialist's brief versions, newest first, as the result. */
  message("specialist-history", { specialist: Text }),
  /** Grant or revoke a specialist a Mac, or move it to another sandbox, as the user. */
  message("specialist-access", { specialist: Text, change: AccessChangeSchema }),
  /** Delete a specialist, as the user. */
  message("specialist-delete", { specialist: Text }),
  /** Answers with every step a task's log kept, oldest first, for its timeline. */
  message("task-steps", { task: Text }),
  /** Answers with a MemorySearch. */
  message("memory-search", { query: Text }),
  /** Answers with a block's two halves, as MemoryItems. */
  message("memory-zoom", { block: Text }),
  /** Drops a block's summary and those above it, for the agent to rebuild. */
  message("memory-forget", { block: Text }),
  /** Answers with the latest dream's changes, as DreamLedgerRows, oldest first. */
  message("dream-ledger", {}),
  /** Puts back one change of a dream by its ledger id, as the user. */
  message("dream-undo", { entry: Type.Number() }),
  /** Create an automation as the user, or change one by its id; the result is `{ refused }` when it cannot be saved. */
  message("automation-save", { automation: Type.Optional(Text), draft: AutomationDraftSchema }),
  /** Pause, resume, archive, unarchive, run or delete an automation, by its id; the result is what happened, as text. */
  message("automation", { automation: Text, action: AutomationActionSchema }),
  /** Answers with Settings › Proactivity: the level and the look times. */
  message("proactivity", {}),
  /** The user's 👍 or 👎 on an unasked post, decoded by its Schema (VerdictInput, src/dreaming/contract.ts); answers with the last 30 days' verdicts, or `{ refused }`. */
  message("post-verdict", { verdict: Type.Unknown() }),
  /** Answers with the last 30 days' verdicts on ky's unasked posts, and how many were 👍. */
  message("post-verdicts", {}),
  /** Set how proactive ky is; answers with Settings › Proactivity. */
  message("set-proactivity", { level: ProactivityLevelSchema }),
  /** Set the look times, each local HH:MM; answers with Settings › Proactivity, or fails saying what is wrong. */
  message("set-looks", { looks: Texts }),
  /** Set how many posts a day push to the user's devices; answers with Settings › Proactivity. */
  message("set-right-away", { most: Type.Integer({ minimum: 0, maximum: RIGHT_AWAY_MOST }) }),
  /** Answers with Settings › Spend: today, this month, today by purpose and source, and the daily cap. */
  message("spend", {}),
  /** Set the daily cap in US dollars, or null for none; answers as spend does, or with `{ refused }`. */
  message("set-spend-cap", { usd: Type.Union([Type.Number(), Type.Null()]) }),
  /** Answers with ky's VAPID public key, base64url, which this device subscribes to pushes with. */
  message("push-key", {}),
  /** Push to this device: its PushSubscription's endpoint and keys. */
  message("push-subscribe", { endpoint: Text, p256dh: Text, auth: Text }),
  /** Push no more to the device subscribed at `endpoint`. */
  message("push-unsubscribe", { endpoint: Text }),
  /** Whether the user is looking at this page: shown and in focus. While one is, a reply to them doesn't push. */
  message("watching", { watching: Type.Boolean() }),
  /** Let the nightly dream book check-ins, or not; off pauses the ones waiting. */
  message("set-check-ins", { on: Type.Boolean() }),
  /** Answers with the user's time zone, whether they pinned it, and the zone this connection is placed in. */
  message("zone", {}),
  /** Pin the user's time zone, an IANA name, or null to follow this connection's zone again; answers as zone does. */
  message("set-zone", { zone: Type.Union([Text, Type.Null()]) }),
  /** Choose the model, and its thinking level, for one purpose. */
  message("set-model", { purpose: PurposeSchema, choice: ModelChoiceSchema }),
  /** Save an API key for a vendor once a test call takes it; the result is `{ refused }` when it doesn't. Never sent back. */
  message("add-key", { vendor: Text, key: Text }),
  /** Remove an api-key provider's key; what ran on it moves to the next healthy provider. */
  message("remove-key", { provider: Text })
]);

/** Just enough of a frame ky can't take to answer it: the id its ask waits on, and what it called itself. */
const FrameHeadSchema = Type.Object({ id: Type.Optional(Text), type: Type.Optional(Text) });

/** The error frame for a message that isn't one ky takes: an old page's, or a broken one. Its id, if it had one, settles its ask. */
export function refusedFrame(raw: string): PiServerMessage {
  const head = parseOr(FrameHeadSchema, raw, undefined);
  const id = head?.id;
  const type = head?.type;
  const message = type === undefined ? "ky can't read that message." : `ky doesn't take a ${JSON.stringify(type)} message like that one; reload the page.`;

  return id === undefined ? { type: "error", message } : { type: "error", id, message };
}
