import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import type { History } from "../history";
import type { Anticipations } from "./anticipations";
import { CHAT_SEARCH, countOf, entryAt, MEMORY_RECALL, placedBy, type Recalled } from "./contract";
import type { Memory } from "./memory";
import type { Proactivity } from "./proactivity";
import type { Surfaced } from "./surfaced";

/**
 * Turn-start recall (L2, docs/research/proactivity/dreaming-proactivity.md §2): before ky answers a message the
 * user sent in the main chat or a side chat, it looks up what it already knows about the message's words, so
 * the model starts with it instead of searching for it. Deterministic and SQL only: no model call.
 *
 * The words of the user's latest message (not a notice ky posted, and not a short ack) are looked up in chat
 * search, memory (memory_recall's regex read), open anticipations and the skills' descriptions. What turns up is
 * a `<recalled>` block of at most BLOCK_CHARS, one line per hit naming where it is from, appended to the
 * request's copy of that message only: the committed transcript never holds it, and the system prompt stays as
 * it was, so its cache does too. A block is made once per message, when its turn's first request goes out, and
 * kept as a surfaced row (kind recall, loop L2); every later request (a tool round, a retry, the turns after)
 * appends the same block to the same message again, so the conversation's cached prefix holds as well.
 *
 * Anticipations a block shows become surfaced. When the model still calls memory_recall or chat_search in that
 * turn, the block is recorded as missed: the miss rate is how often recall did not bring what was needed.
 */

/** The block's cap, tags included. */
const BLOCK_CHARS = 1_500;

/** A line's cap, so one long hit cannot crowd out the rest. */
const LINE_CHARS = 300;

/** Words of a message looked up, in the order it says them. */
const TERMS = 8;

/** A word shorter than this is not looked up. */
const TERM_CHARS = 3;

/** Hits each source gives at most. */
const MEMORIES = 3;

const MESSAGES = 3;

const ANTICIPATIONS = 3;

const SKILLS = 2;

/** A block is open to a miss for this long; then it expires, which counts as not missed. */
const MISS_WINDOW_MS = 3_600_000;

/** Recall blocks the chip replays when a chat opens. */
const REPLAYED = 100;

/** Recall blocks a request may carry, at most: one per user message in its context. */
const CARRIED = 1_000;

/** Messages decided (a block made, or none to make) kept in memory, so a tool round does not decide again. */
const DECIDED = 1_000;

/** How far apart, in pi's ids, a user entry and the submission that placed it may be: History's PLACED_SLACK. */
const PLACED_SLACK = 5_000;

/** A request id the browser or the harness made up: the message is the user's own (History's OWN_REQUEST). */
const OWN_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A message that asks nothing to look up: an ack, a thanks, a greeting. */
const TRIVIAL = /^(?:ok(?:ay)?|k|kk|thanks?(?: you)?|thx|ty|cool|nice|great|perfect|yes|yep|yeah|yup|no|nope|sure|done|got it|sounds good|lgtm|lol|hi|hey|hello|go|go ahead|continue)[\s.!?]*$/i;

/** Words too common to look up. */
const STOP = new Set(
  (
    "the and for are but not you all any can had her was one our out has him his how its may new now old see two who did get got let say she too use " +
    "what when where which with this that from have will your about would there their could should them then than been were into just like also some " +
    "more make does want need please know think tell show give here they these those very much only over such after again why yes okay thanks thank " +
    "hey hello can't don't i'm it's you're let's"
  ).split(" ")
);

/** The skills recall reads: their names and descriptions, from src/skills (passed in, so this domain does not import it). */
export type SkillLine = { readonly name: string; readonly description: string };

export type RecallWiring = {
  readonly sql: SqlStorage;
  readonly memory: Memory;
  readonly history: History;
  readonly anticipations: Anticipations;
  readonly surfaced: Surfaced;
  readonly proactivity: Proactivity;
  readonly skills: () => readonly SkillLine[];
  /** The main chat or a side chat: the only conversations recall runs in. */
  readonly chat: (session: string) => boolean;
};

/** The words of `text` worth looking up: lower-cased, not too short or common, each once, the first TERMS. */
export function termsOf(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? []).filter((word) => word.length >= TERM_CHARS && !STOP.has(word));

  return [...new Set(words.map((word) => word.replace(/'/g, "")))].filter((word) => word.length >= TERM_CHARS).slice(0, TERMS);
}

/** Whether `text` asks nothing to look up: an ack, or no word worth looking up. */
export function isTrivial(text: string): boolean {
  return TRIVIAL.test(text.trim()) || termsOf(text).length === 0;
}

/** The block for `lines`, as the model reads it. */
function blockOf(lines: readonly string[]): string {
  return `<recalled>\nrecalled context, not user input\n${lines.map((line) => `- ${line}`).join("\n")}\n</recalled>`;
}

/** As many of `lines` as fit the block's cap, each cut to LINE_CHARS, in order. */
function fit(lines: readonly string[]): string[] {
  const kept: string[] = [];

  for (const line of lines.map((each) => cut(each.replace(/\s+/g, " ").trim(), LINE_CHARS))) {
    if (blockOf([...kept, line]).length > BLOCK_CHARS) break;
    kept.push(line);
  }

  return kept;
}

const cut = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, chars - 1)}…`);

/** A message's text parts, as one string. */
function textOf(message: UserMessage): string {
  return Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    : message.content;
}

/** `message` with `block` after what it says. */
function withBlock(message: UserMessage, block: string): UserMessage {
  const after = `\n\n${block}`;

  return {
    ...message,
    content: Array.isArray(message.content) ? [...message.content, { type: "text", text: after }] : `${message.content}${after}`
  };
}

const isUser = (message: Message): message is UserMessage => message.role === "user";

/** A recall block's surfaced item: the chat and the message's entry. */
const itemOf = (session: string, entry: number) => `${session}#${entry}`;

const entryOf = (item: string) => Number(item.slice(item.indexOf("#") + 1));

/** The lines a block holds, and the anticipations among them. */
type Gathered = { readonly lines: string[]; readonly anticipations: number[] };

export class Recall {
  readonly #wiring: RecallWiring;
  readonly #listeners = new Set<(session: string, recalled: Recalled) => void>();
  /** Messages already decided this run of the object, by entry id. */
  readonly #decided = new Set<number>();

  constructor(wiring: RecallWiring) {
    this.#wiring = wiring;
  }

  /** Called with each block made, for the chip under its message. */
  onShown(listener: (session: string, recalled: Recalled) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** The chat's recent blocks, newest first, for the chips when it opens. */
  shown(session: string): Recalled[] {
    return this.#wiring.surfaced
      .items("recall", `${session}#`, 0, REPLAYED)
      .map((row) => ({ entry: entryOf(row.item), lines: row.text.split("\n") }));
  }

  /**
   * The request's messages with each user message's block appended, making the latest one's block first when
   * it has none yet; undefined when no message carries one, or outside a chat.
   */
  request(session: string, messages: readonly Message[], now = Date.now()): { readonly messages: readonly Message[] } | undefined {
    if (!this.#wiring.chat(session)) return undefined;
    const users = messages.filter(isUser);
    const latest = users.at(-1);

    if (latest === undefined) return undefined;
    this.#decide(session, latest, messages, now);

    const blocks = this.#blocks(session, users);

    if (blocks.size === 0) return undefined;

    return { messages: messages.map((message) => (isUser(message) && blocks.has(message.timestamp) ? withBlock(message, blocks.get(message.timestamp) ?? "") : message)) };
  }

  /** The model searched memory or the chats itself: the block of the turn it is in, if one is open, missed. */
  searched(session: string, now = Date.now()): void {
    if (!this.#wiring.chat(session)) return;
    const entry = this.#latestEntry(session);

    if (entry === undefined) return;
    const item = itemOf(session, entry.id);

    if (this.#wiring.surfaced.outcomeOf("recall", item) === null) this.#wiring.surfaced.outcome("recall", item, "missed", now);
  }

  /** Make the block for `message` if it is the user's latest, their own, and asks something; once per message. */
  #decide(session: string, message: UserMessage, messages: readonly Message[], now: number): void {
    const entry = this.#fresh(session, message);

    if (entry === undefined) return;
    const text = textOf(message);

    if (!this.#wanted(session, entry, text)) return;
    const gathered = this.#gather(session, termsOf(text), messages, now);

    if (gathered.lines.length > 0) this.#show(session, entry, gathered, now);
  }

  /** The chat's latest user entry when `message` is it and it is not yet decided; marks it decided. */
  #fresh(session: string, message: UserMessage): number | undefined {
    const entry = this.#latestEntry(session);

    // A request whose latest user message is not the chat's latest entry (one placed since) waits for its own.
    if (entry === undefined || entry.at !== message.timestamp || this.#decided.has(entry.id)) return undefined;

    if (this.#decided.size >= DECIDED) this.#decided.clear();
    this.#decided.add(entry.id);

    return entry.id;
  }

  /** Whether the message gets a block: none made yet, proactivity on, the user's own words, and not an ack. */
  #wanted(session: string, entry: number, text: string): boolean {
    const unmade = this.#wiring.surfaced.outcomeOf("recall", itemOf(session, entry)) === undefined;

    return unmade && this.#wiring.proactivity.level() !== "off" && !isTrivial(text) && this.#own(entry);
  }

  /** Record the block as surfaced, surface the open anticipations it shows, and tell the chips. */
  #show(session: string, entry: number, { lines, anticipations }: Gathered, now: number): void {
    this.#wiring.surfaced.shown({ kind: "recall", loop: "L2", ref: `entry:${entry}`, item: itemOf(session, entry), text: lines.join("\n"), expiresAt: now + MISS_WINDOW_MS }, now);

    for (const id of anticipations) {
      if (this.#wiring.anticipations.get(id).status === "open") this.#wiring.anticipations.surface(id, now);
    }

    for (const listener of this.#listeners) listener(session, { entry, lines });
  }

  /** What the four sources hold about `terms`, as the block's lines: anticipations, memories, messages, skills. */
  #gather(session: string, terms: readonly string[], messages: readonly Message[], now: number): Gathered {
    const due = this.#wiring.anticipations.match(terms, now, ANTICIPATIONS);
    const ahead = due.map((row) => `anticipation #${row.id} ${row.kind}: ${row.text}`);
    const remembered = this.#wiring.memory.relevant(terms, MEMORIES).map((memory) => `memory #${memory.id} ${memory.date}: ${memory.text}`);
    const lines = fit([...ahead, ...remembered, ...this.#said(session, terms, messages), ...this.#skills(terms)]);

    // The block keeps a prefix of its lines, and the anticipations come first.
    return { lines, anticipations: due.slice(0, lines.length).map((row) => row.id) };
  }

  /** Chat search's best hits for `terms`, leaving out the messages this request already holds. */
  #said(session: string, terms: readonly string[], messages: readonly Message[]): string[] {
    const hits = this.#wiring.history
      .search(terms.join(" "), 0, session)
      .split("\n")
      .flatMap((line) => {
        const id = /^#(\d+) /.exec(line)?.[1];

        return id === undefined ? [] : [{ id: Number(id), line }];
      });

    if (hits.length === 0) return [];

    const from = Math.min(...messages.map((message) => message.timestamp));

    const held = new Set(
      this.#wiring.sql
        .exec(
          `SELECT id AS n FROM pi_entries WHERE id IN (SELECT value FROM json_each(?)) AND conversation_id = ?
           AND json_extract(record, '$.model[0].timestamp') >= ?`,
          JSON.stringify(hits.map((hit) => hit.id)),
          Number(session),
          from
        )
        .toArray()
        .map((row) => countOf(row))
    );

    return hits.filter((hit) => !held.has(hit.id)).slice(0, MESSAGES).map((hit) => `chat ${hit.line}`);
  }

  /** The skills whose name or description share the most of `terms`. */
  #skills(terms: readonly string[]): string[] {
    return this.#wiring
      .skills()
      .map((skill) => {
        const words = new Set(termsOf(`${skill.name.replace(/[-_]/g, " ")} ${skill.description}`));

        return { skill, score: terms.filter((term) => words.has(term)).length };
      })
      .filter((each) => each.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, SKILLS)
      .map(({ skill }) => `skill ${skill.name}: ${skill.description}`);
  }

  /** Each of `users`' blocks by the message's timestamp: the chat's recall rows since the oldest of them. */
  #blocks(session: string, users: readonly UserMessage[]): Map<number, string> {
    const rows = this.#wiring.surfaced.items("recall", `${session}#`, Math.min(...users.map((message) => message.timestamp)), CARRIED);

    if (rows.length === 0) return new Map();
    const texts = new Map(rows.map((row) => [entryOf(row.item), row.text]));
    const blocks = new Map<number, string>();

    for (const row of this.#wiring.sql.exec(
      "SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM pi_entries WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify([...texts.keys()])
    )) {
      const entry = entryAt(row);
      const text = entry === undefined ? undefined : texts.get(entry.id);

      if (entry !== undefined && text !== undefined) blocks.set(entry.at, blockOf(text.split("\n")));
    }

    return blocks;
  }

  /** The chat's latest user entry and its message's timestamp. */
  #latestEntry(session: string): { readonly id: number; readonly at: number } | undefined {
    return entryAt(
      this.#wiring.sql
        .exec(
          `SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM pi_entries
           WHERE id = (SELECT max(id) FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user')`,
          Number(session)
        )
        .toArray()[0]
    );
  }

  /** Whether the user sent entry `id` themselves, as History tells: its submission's request id is a bare UUID. */
  #own(id: number): boolean {
    return this.#wiring.sql
      .exec(
        `SELECT json_extract(record, '$.requestId') AS request FROM pi_submissions
         WHERE id BETWEEN ? AND ? AND json_extract(record, '$.entry') = ?`,
        id - PLACED_SLACK,
        id + PLACED_SLACK,
        id
      )
      .toArray()
      .some((row) => OWN_REQUEST.test(placedBy(row) ?? ""));
  }
}

/** Recall's hooks: a block on each chat request, and a miss when the model searches anyway. Neither ever fails a turn. */
export function recallExtension(recall: Recall): Extension {
  return defineExtension({
    name: "recall",
    hooks: [
      hook(GenerationTask, {
        beforeRequest({ messages }, api) {
          try {
            return recall.request(String(api.conversationId), messages);
          } catch (error) {
            console.warn("recall: no block for this request", error);

            return undefined;
          }
        }
      }),
      hook(ToolTask, {
        beforeTool(call, api) {
          if (call.name !== MEMORY_RECALL && call.name !== CHAT_SEARCH) return undefined;

          try {
            recall.searched(String(api.conversationId));
          } catch (error) {
            console.warn("recall: the miss was not recorded", error);
          }

          return undefined;
        }
      })
    ]
  });
}
