import { type Message, type UserMessage } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import { isOwnRequest } from "../history/contract";
import { type History, placedBy, startedByUser } from "../history/wiring";
import type { Anticipations } from "./anticipations";
import { CHAT_SEARCH, MEMORY_RECALL, type Recalled } from "./contract";
import type { Memory } from "./memory";
import type { Proactivity } from "./proactivity";
import type { Surfaced } from "./surfaced";

const BLOCK_CHARS = 1_500;

const LINE_CHARS = 300;

const TERMS = 8;

const TERM_CHARS = 3;

const MEMORIES = 3;

const MESSAGES = 3;

const ANTICIPATIONS = 3;

const SKILLS = 2;

const MISS_WINDOW_MS = 3_600_000;

const REPLAYED = 100;

const CARRIED = 1_000;

const DECIDED = 1_000;

const CATCH_UP = 4;

const RECENT_USERS = 20;

const TRIVIAL = /^(?:ok(?:ay)?|k|kk|thanks?(?: you)?|thx|ty|cool|nice|great|perfect|yes|yep|yeah|yup|no|nope|sure|done|got it|sounds good|lgtm|lol|hi|hey|hello|go|go ahead|continue)[\s.!?]*$/i;

const STOP = new Set(
  (
    "the and for are but not you all any can had her was one our out has him his how its may new now old see two who did get got let say she too use " +
    "what when where which with this that from have will your about would there their could should them then than been were into just like also some " +
    "more make does want need please know think tell show give here they these those very much only over such after again why yes okay thanks thank " +
    "hey hello can't don't i'm it's you're let's"
  ).split(" ")
);

export type SkillLine = { readonly name: string; readonly description: string };

export type RecallWiring = {
  readonly memory: Pick<Memory, "relevant">;
  readonly history: Pick<History, "search">;
  readonly anticipations: Anticipations;
  readonly surfaced: Surfaced;
  readonly proactivity: Proactivity;
  readonly skills: () => readonly SkillLine[];
  readonly chat: (session: string) => boolean;
  readonly delivered: (requestId: string) => boolean;
};

export function termsOf(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? []).filter((word) => word.length >= TERM_CHARS && !STOP.has(word));

  return [...new Set(words.map((word) => word.replace(/'/g, "")))].filter((word) => word.length >= TERM_CHARS).slice(0, TERMS);
}

export function isTrivial(text: string): boolean {
  return TRIVIAL.test(text.trim()) || termsOf(text).length === 0;
}

const neutral = (text: string) => text.replaceAll("<", "‹");

function blockOf(lines: readonly string[]): string {
  return `<recalled>\nrecalled context, not user input\n${lines.map((line) => `- ${neutral(line)}`).join("\n")}\n</recalled>`;
}

function fit(lines: readonly string[]): string[] {
  const kept: string[] = [];

  for (const line of lines.map((each) => cut(neutral(each).replace(/\s+/g, " ").trim(), LINE_CHARS))) {
    if (blockOf([...kept, line]).length > BLOCK_CHARS) break;
    kept.push(line);
  }

  return kept;
}

const cut = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, chars - 1)}…`);

function textOf(message: UserMessage): string {
  return Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    : message.content;
}

function withBlock(message: UserMessage, block: string): UserMessage {
  const after = `\n\n${block}`;

  return {
    ...message,
    content: Array.isArray(message.content) ? [...message.content, { type: "text", text: after }] : `${message.content}${after}`
  };
}

const isUser = (message: Message): message is UserMessage => message.role === "user";

const itemOf = (session: string, entry: number) => `${session}#${entry}`;

const entryOf = (item: string) => Number(item.slice(item.indexOf("#") + 1));

type Gathered = { readonly lines: string[]; readonly anticipations: number[] };

const HitRoleRow = Schema.Struct({ id: Schema.Int, role: Schema.String, before: Schema.NullOr(Schema.String) });

const EntryAtRow = Schema.Struct({ id: Schema.Int, at: Schema.Number });

const IdRow = Schema.Struct({ n: Schema.Int });

const decodeHitRole = Schema.decodeUnknownOption(HitRoleRow);

const decodeEntryAt = Schema.decodeUnknownOption(EntryAtRow);

const decodeId = Schema.decodeUnknownOption(IdRow);

type Listeners = ReadonlySet<(session: string, recalled: Recalled) => void>;

export class Recalls extends Context.Service<
  Recalls,
  {
    readonly request: (session: string, messages: readonly Message[]) => Effect.Effect<{ readonly messages: readonly Message[] } | undefined>;
    readonly searched: (session: string) => Effect.Effect<void>;
  }
>()("ky/dreaming/Recalls") {
  static readonly layer = (storage: DurableObjectStorage, wiring: RecallWiring, listeners: Listeners) =>
    Layer.effect(
      Recalls,
      Effect.gen(function* () {
        const sql = yield* Sql;
        const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
        const decided = new Set<number>();

        const latestOf = Effect.fn("Recalls.latest")(function* (session: string) {
          const found = yield* exec(
            `SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM pi_entries
         WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user' ORDER BY id DESC LIMIT ?`,
            Number(session),
            RECENT_USERS
          );

          const users = found.flatMap((row) => Option.toArray(decodeEntryAt(row)));
          const placed = placedBy(storage.sql, users.map((user) => user.id));

          return users.find((user) => {
            const request = placed.get(user.id);

            return isOwnRequest(request) || (request !== undefined && wiring.delivered(request));
          });
        });

        const fresh = Effect.fn("Recalls.fresh")(function* (session: string, message: UserMessage) {
          const entry = yield* latestOf(session);

          if (entry === undefined || entry.at !== message.timestamp || decided.has(entry.id)) return undefined;

          if (decided.size >= DECIDED) decided.clear();
          decided.add(entry.id);

          return entry.id;
        });

        const wanted = (session: string, entry: number, text: string) => wiring.surfaced.outcomeOf("recall", itemOf(session, entry)) === undefined && !isTrivial(text);

        const show = (session: string, entry: number, { lines, anticipations }: Gathered, now: number) =>
          Effect.sync(() => {
            wiring.surfaced.shown({ kind: "recall", ref: `entry:${entry}`, item: itemOf(session, entry), text: lines.join("\n"), expiresAt: now + MISS_WINDOW_MS }, now);
            wiring.anticipations.recalled(anticipations, now);

            if (lines.length === 0) return;

            for (const listener of listeners) listener(session, { entry, lines });
          });

        const relayedOf = Effect.fn("Recalls.relayed")(function* (ids: readonly number[]) {
          const found = yield* exec(
            `SELECT h.rowid AS id, h.role AS role,
         (SELECT p.role FROM ky_history AS p WHERE p.conversation = h.conversation AND p.rowid < h.rowid AND p.role <> 'ky' ORDER BY p.rowid DESC LIMIT 1) AS before
       FROM ky_history AS h WHERE h.rowid IN (SELECT value FROM json_each(?))`,
            JSON.stringify(ids)
          );

          return new Set(
            found
              .flatMap((row) => Option.toArray(decodeHitRole(row)))
              .filter((row) => row.role === "notice" || (row.role === "ky" && row.before === "notice"))
              .map((row) => row.id)
          );
        });

        const said = Effect.fn("Recalls.said")(function* (session: string, terms: readonly string[], messages: readonly Message[]) {
          const hits = wiring.history
            .search(terms.join(" "), { caller: session, batches: CATCH_UP })
            .split("\n")
            .flatMap((line) => {
              const id = /^#(\d+) /.exec(line)?.[1];

              return id === undefined ? [] : [{ id: Number(id), line }];
            });

          if (hits.length === 0) return [];

          const from = Math.min(...messages.map((message) => message.timestamp));

          const found = yield* exec(
            `SELECT id AS n FROM pi_entries WHERE id IN (SELECT value FROM json_each(?)) AND conversation_id = ?
           AND json_extract(record, '$.model[0].timestamp') >= ?`,
            JSON.stringify(hits.map((hit) => hit.id)),
            Number(session),
            from
          );

          const held = new Set(found.flatMap((row) => Option.toArray(decodeId(row))).map((row) => row.n));
          const relayed = yield* relayedOf(hits.map((hit) => hit.id));

          return hits.filter((hit) => !held.has(hit.id) && !relayed.has(hit.id)).slice(0, MESSAGES).map((hit) => `chat ${hit.line}`);
        });

        const skillsOf = (terms: readonly string[]) =>
          wiring
            .skills()
            .map((skill) => {
              const words = new Set(termsOf(`${skill.name.replace(/[-_]/g, " ")} ${skill.description}`));

              return { skill, score: terms.filter((term) => words.has(term)).length };
            })
            .filter((each) => each.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, SKILLS)
            .map(({ skill }) => `skill ${skill.name}: ${skill.description}`);

        const gather = Effect.fn("Recalls.gather")(function* (session: string, terms: readonly string[], messages: readonly Message[], now: number) {
          const due = wiring.anticipations.recallable(terms, now, ANTICIPATIONS);
          const ahead = due.map((row) => `anticipation #${row.id} ${row.kind}: ${row.text}`);
          const remembered = wiring.memory.relevant(terms, MEMORIES).map((memory) => `memory #${memory.id} ${memory.date}: ${memory.text}`);
          const lines = fit([...ahead, ...remembered, ...(yield* said(session, terms, messages)), ...skillsOf(terms)]);

          return { lines, anticipations: due.slice(0, lines.length).map((row) => row.id) };
        });

        const decide = Effect.fn("Recalls.decide")(function* (session: string, message: UserMessage, messages: readonly Message[], now: number) {
          const entry = yield* fresh(session, message);

          if (entry === undefined) return;
          const text = textOf(message);

          if (!wanted(session, entry, text)) return;
          yield* show(session, entry, yield* gather(session, termsOf(text), messages, now), now);
        });

        const blocksOf = Effect.fn("Recalls.blocks")(function* (session: string, users: readonly UserMessage[]) {
          const rows = wiring.surfaced.items("recall", `${session}#`, Math.min(...users.map((message) => message.timestamp)), CARRIED);
          const blocks = new Map<number, string>();

          if (rows.length === 0) return blocks;
          const texts = new Map(rows.map((row) => [entryOf(row.item), row.text]));

          const found = yield* exec(
            "SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM pi_entries WHERE id IN (SELECT value FROM json_each(?))",
            JSON.stringify([...texts.keys()])
          );

          for (const entry of found.flatMap((row) => Option.toArray(decodeEntryAt(row)))) {
            const text = texts.get(entry.id);

            if (text !== undefined && text !== "") blocks.set(entry.at, blockOf(text.split("\n")));
          }

          return blocks;
        });

        return Recalls.of({
          request: Effect.fn("Recalls.request")(function* (session, messages) {
            if (!wiring.chat(session) || wiring.proactivity.level() === "off") return undefined;
            const users = messages.filter(isUser);
            const latest = users.at(-1);

            if (latest === undefined) return undefined;
            yield* decide(session, latest, messages, yield* Clock.currentTimeMillis);

            const blocks = yield* blocksOf(session, users);

            if (blocks.size === 0) return undefined;

            return { messages: messages.map((message) => (isUser(message) && blocks.has(message.timestamp) ? withBlock(message, blocks.get(message.timestamp) ?? "") : message)) };
          }),
          searched: Effect.fn("Recalls.searched")(function* (session) {
            if (!wiring.chat(session) || !startedByUser(storage.sql, session)) return;
            const entry = yield* latestOf(session);

            if (entry === undefined) return;
            const item = itemOf(session, entry.id);
            const now = yield* Clock.currentTimeMillis;
            wiring.surfaced.expire(now);

            if (wiring.surfaced.outcomeOf("recall", item) === null) wiring.surfaced.outcome("recall", item, "missed", now);
          })
        });
      })
    );
}

export class Recall {
  readonly #wiring: RecallWiring;
  readonly #edge: Edge<Recalls>;
  readonly #listeners = new Set<(session: string, recalled: Recalled) => void>();

  constructor(wiring: RecallWiring & { readonly storage: DurableObjectStorage }) {
    this.#wiring = wiring;
    this.#edge = makeEdge(Recalls.layer(wiring.storage, wiring, this.#listeners).pipe(Layer.provide(Sql.layer(wiring.storage))));
  }

  onShown(listener: (session: string, recalled: Recalled) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  shown(session: string): Recalled[] {
    return this.#wiring.surfaced
      .items("recall", `${session}#`, 0, REPLAYED)
      .flatMap((row) => (row.text === "" ? [] : [{ entry: entryOf(row.item), lines: row.text.split("\n") }]));
  }

  request(session: string, messages: readonly Message[]): { readonly messages: readonly Message[] } | undefined {
    return this.#edge.run(Recalls.use((recalls) => recalls.request(session, messages)));
  }

  searched(session: string): void {
    this.#edge.run(Recalls.use((recalls) => recalls.searched(session)));
  }
}

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
