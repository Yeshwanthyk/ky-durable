/**
 * What crosses the peers domain's edges: the bodies other kys send and answer, the rows it keeps,
 * the tools a peer conversation may call, and the tables it owns. Every type here is derived from
 * its schema, so a value checked against the schema is the type, and nothing is written twice.
 *
 * This module imports nothing from the domain's own files, nor anything of the Worker's, so the
 * domain's files, everything outside, and Node (the CLI, test/invariants) can import it without a
 * cycle. What runs (Peers, PeerAsks, GroupDesk, the routes) is in peers.ts, group.ts and wiring.ts.
 */
import Type, { type Static } from "typebox";
import type { Result } from "../core/refusal";

// --- Tables ---

/**
 * The tables this domain owns, by what each keeps. A backup restores each table through
 * `ky_restore__<table>`, by name: never rename one, only add.
 */
export const PEERS_TABLES = {
  peers: "ky_peers",
  asks: "ky_peer_asks",
  chatMembers: "ky_chat_members",
  seats: "ky_specialist_seats",
  groupMessages: "ky_group_messages"
} as const;

// --- The peer routes another ky calls ---

export const PEER_PATH = "/peer/v1";

/** The longest question a ky takes. */
export const QUESTION_CHARS = 4_000;

/** The longest answer a ky takes. */
export const ANSWER_CHARS = 8_000;

/** How long a question waits for its answer before it expires. */
export const ASK_TTL_MS = 24 * 3_600_000;

/** A token the Vault mints: 32 random bytes as hex. */
const Token = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** What another ky sends the pair route: the invite code, its address, and the token this ky will call it with. */
export const PairBody = Type.Object({ code: Type.String(), address: Type.String(), token: Token });

export type PairBody = Static<typeof PairBody>;

/** What the pair route answers: the token to call that ky with. */
export const Paired = Type.Object({ token: Token });

/** A question a peer asks this ky. */
export const AskBody = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), question: Type.String({ minLength: 1, maxLength: QUESTION_CHARS }) });

export type AskBody = Static<typeof AskBody>;

/** A peer's answer to a question this ky asked. An empty answer is taken, and shown as one (peerAnswer). */
export const AnswerBody = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), answer: Type.String({ maxLength: ANSWER_CHARS }) });

export type AnswerBody = Static<typeof AnswerBody>;

// --- Rows ---

const PeerState = Type.Union([Type.Literal("on"), Type.Literal("revoked")]);

/** A row of ky_peers. */
export const PeerRow = Type.Object({ name: Type.String(), address: Type.String(), state: PeerState, created_at: Type.Number() });

export type PeerRow = Static<typeof PeerRow>;

const AskDirection = Type.Union([Type.Literal("in"), Type.Literal("out")]);

export type AskDirection = Static<typeof AskDirection>;

/** Open: being answered; asking: waiting on the person; then answered, or expired after ASK_TTL_MS. */
const AskState = Type.Union([Type.Literal("open"), Type.Literal("asking"), Type.Literal("answered"), Type.Literal("expired")]);

export type AskState = Static<typeof AskState>;

/** A row of ky_peer_asks: a question out, asked by this ky's `session`; or in, from a peer, answered in `session`. */
export const PeerAsk = Type.Object({
  id: Type.String(),
  peer: Type.String(),
  direction: AskDirection,
  question: Type.String(),
  state: AskState,
  answer: Type.Union([Type.String(), Type.Null()]),
  session: Type.String(),
  /** In: whether the answer reached the peer, 0 or 1. */
  sent: Type.Number(),
  created_at: Type.Number()
});

export type PeerAsk = Static<typeof PeerAsk>;

/** A COUNT(*) row. */
export const Count = Type.Object({ n: Type.Number() });

/** A row of ky_chat_members. */
export const ChatMember = Type.Object({ chat: Type.String(), specialist: Type.String() });

/** A seat's session, from ky_specialist_seats. */
export const SeatRow = Type.Object({ session: Type.String() });

/** ky_group_messages.responders: a JSON array of specialist ids. */
export const Responders = Type.Array(Type.String());

/** A row of ky_group_messages, as decided() reads it. */
export const ResponderRow = Type.Object({ responders: Type.String() });

// --- Tools ---

/** The peer tool's name. */
export const PEER_TOOL = "peer";

/**
 * The tools a peer conversation may call, besides `peer escalate`: memory and skill lookups, and the
 * executor. The executor runs programs against the user's connected apps, so a peer conversation can
 * act through them, not only look things up; the user chose to keep it. What holds it back is that an
 * approval is the user's alone (src/approvals/executor.ts): executor_resume can't accept, so a tool that
 * needs approval waits as a card in the user's main chat, with a push, until their own tap decides it.
 * A peer can only decline, cancel, or answer a request for input.
 */
export const PEER_TOOLS = ["memory_recall", "memory_zoom", "skill_view", "executor_skills", "executor_execute", "executor_resume"] as const;

// --- Group chats ---

/** Specialists that answer one user message, at most. */
export const RESPONDER_CAP = 3;

/** Each group chat's member ids, by session. */
export type GroupMembers = Record<string, string[]>;

/** Who answers a user's message, as decided once; or why no one may. */
export type RoutePlan = Result<{ readonly to: readonly string[] }>;

/** How a specialist's reply ended: its words, a failure, or stopped (the user's stop, or its seat's abort). */
const ReplyOutcome = Type.Union([
  Type.Object({ kind: Type.Literal("answered"), text: Type.String() }),
  Type.Object({ kind: Type.Literal("failed"), text: Type.String() }),
  Type.Object({ kind: Type.Literal("stopped"), text: Type.String() })
]);

export type ReplyOutcome = Static<typeof ReplyOutcome>;

/** The reply task's checkpoint before it posts: the outcome; or, from before outcomes, its text and whether it failed. */
const PostCheckpoint = Type.Union([
  Type.Object({ phase: Type.Literal("post"), outcome: ReplyOutcome }),
  Type.Object({ phase: Type.Literal("post"), text: Type.String(), failed: Type.Boolean() })
]);

export type PostCheckpoint = Static<typeof PostCheckpoint>;
