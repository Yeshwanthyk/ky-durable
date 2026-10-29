import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge, type Refusable, runOrThrow } from "../core/edge";
import { toolReply as text } from "../core/reply";
import { Sql } from "../core/sql";
import { ownMessages, startedByUser } from "../history/wiring";
import { ANTICIPATE, ANTICIPATION_KINDS, type Anticipation, type AnticipationKind, anticipationRow, type AnticipationStatus, type Creator, type Evidence } from "./contract";
import type { Memory } from "./memory";

const OPEN_CAP = 20;

export const RUN_CAP = 5;

const EPISODE_CAP = 3;

const RUN_MS = 12 * 3_600_000;

const TEXT_BYTES = 280;

const PREPARED_CHARS = 1_500;

const RECALL_AGAIN_MS = 86_400_000;

const MATCH_TERMS = 12;

const RECENT_USERS = 20;

const TERM_CHARS = 3;

const DAY_MS = 24 * 3_600_000;

export type Actor = Creator;

export type EpisodePass = {
  readonly parent: string;
  readonly after: number;
  readonly upto: number;
};

export type Window = { readonly from: number; readonly to: number };

export type Draft = {
  readonly kind: AnticipationKind;
  readonly text: string;
  readonly evidence: Evidence;
  readonly prepared?: string;
  readonly window?: Window;
};

const MOVES: Readonly<Record<AnticipationStatus, readonly AnticipationStatus[]>> = {
  open: ["surfaced", "done", "dismissed", "expired"],
  surfaced: ["done", "dismissed"],
  done: [],
  dismissed: [],
  expired: []
};

const LIVE = "status IN ('open', 'surfaced')";

const encoder = new TextEncoder();

const bytes = (line: string) => encoder.encode(line).length;

const like = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

const MessageRow = Schema.Struct({
  id: Schema.Number,
  conversation_id: Schema.Number,
  kind: Schema.String
});

const decodeMessage = Schema.decodeUnknownOption(MessageRow);

const CountRow = Schema.Struct({ n: Schema.Number });

const decodeCount = Schema.decodeUnknownOption(CountRow);

const countOf = (row: Readonly<Record<string, SqlStorageValue>> | undefined) =>
  Option.getOrElse(
    Option.map(decodeCount(row), ({ n }) => n),
    () => 0
  );

const ColumnRow = Schema.Struct({ name: Schema.String });

type MessagePlace = { readonly conversation: string; readonly notice: boolean };

const cites = (ids: readonly number[]) => ids.map((id) => `#${id}`).join(", ");

class Empty extends Schema.TaggedError<Empty>()("Empty", {}) implements Refusable {
  get refusal(): string {
    return "Empty. An anticipation is one line of text.";
  }
}

class NotOneLine extends Schema.TaggedError<NotOneLine>()("NotOneLine", {}) implements Refusable {
  get refusal(): string {
    return "An anticipation is one line.";
  }
}

class TooLong extends Schema.TaggedError<TooLong>()("TooLong", { bytes: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `Too long: ${this.bytes} bytes, limit ${TEXT_BYTES}.`;
  }
}

class NotDates extends Schema.TaggedError<NotDates>()("NotDates", {}) implements Refusable {
  get refusal(): string {
    return "A window needs a from and a to that are dates.";
  }
}

class Backwards extends Schema.TaggedError<Backwards>()("Backwards", {}) implements Refusable {
  get refusal(): string {
    return "A window's to is before its from.";
  }
}

class NoAnticipation
  extends Schema.TaggedError<NoAnticipation>()("NoAnticipation", {
    id: Schema.Number
  })
  implements Refusable
{
  get refusal(): string {
    return `No anticipation #${this.id}.`;
  }
}

class OpenFull extends Schema.TaggedError<OpenFull>()("OpenFull", {}) implements Refusable {
  get refusal(): string {
    return `${OPEN_CAP} are open already: close or absorb one first.`;
  }
}

class RunFull extends Schema.TaggedError<RunFull>()("RunFull", {}) implements Refusable {
  get refusal(): string {
    return `A dream adds at most ${RUN_CAP}; this one has.`;
  }
}

class NoPass extends Schema.TaggedError<NoPass>()("NoPass", {}) implements Refusable {
  get refusal(): string {
    return "Only an episode reflection's own fork adds as an episode.";
  }
}

class NoOwnWords extends Schema.TaggedError<NoOwnWords>()("NoOwnWords", {}) implements Refusable {
  get refusal(): string {
    return "Cite the user's own messages (#id) it rests on.";
  }
}

class OutsideStretch
  extends Schema.TaggedError<OutsideStretch>()("OutsideStretch", {
    ids: Schema.Array(Schema.Number)
  })
  implements Refusable
{
  get refusal(): string {
    return `Message ${cites(this.ids)} is not the user's own words in the stretch you read: cite only the user's lines above.`;
  }
}

class EpisodeFull extends Schema.TaggedError<EpisodeFull>()("EpisodeFull", {}) implements Refusable {
  get refusal(): string {
    return `An episode reflection adds at most ${EPISODE_CAP}; this one has.`;
  }
}

class NoEvidence extends Schema.TaggedError<NoEvidence>()("NoEvidence", {}) implements Refusable {
  get refusal(): string {
    return "No evidence: cite the chat messages (#rowid) or memories (#id) it rests on.";
  }
}

class Missing
  extends Schema.TaggedError<Missing>()("Missing", {
    cited: Schema.Array(Schema.String)
  })
  implements Refusable
{
  get refusal(): string {
    return `No such ${this.cited.join(", ")}: cite only what is there.`;
  }
}

class NotFromChat
  extends Schema.TaggedError<NotFromChat>()("NotFromChat", {
    ids: Schema.Array(Schema.Number)
  })
  implements Refusable
{
  get refusal(): string {
    return `Message ${cites(this.ids)} is not from a chat (a dream, a subagent or a task said it): cite what the user and ky said in a chat.`;
  }
}

class Relayed
  extends Schema.TaggedError<Relayed>()("Relayed", {
    ids: Schema.Array(Schema.Number)
  })
  implements Refusable
{
  get refusal(): string {
    return `Message ${cites(this.ids)} is a notice ky relayed (mail, a peer, a report), not the user's words: cite what the user and ky said.`;
  }
}

class Illegal
  extends Schema.TaggedError<Illegal>()("Illegal", {
    id: Schema.Number,
    status: Schema.String,
    to: Schema.String
  })
  implements Refusable
{
  get refusal(): string {
    return `#${this.id} is ${this.status}; it cannot become ${this.to}.`;
  }
}

class EpisodeOnlyAdds extends Schema.TaggedError<EpisodeOnlyAdds>()("EpisodeOnlyAdds", {}) implements Refusable {
  get refusal(): string {
    return "An episode reflection only adds and lists; the dream and the user close, extend and absorb.";
  }
}

class UsersOwn extends Schema.TaggedError<UsersOwn>()("UsersOwn", { id: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `#${this.id} is the user's; only they change it.`;
  }
}

class Pinned extends Schema.TaggedError<Pinned>()("Pinned", { id: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `#${this.id} is pinned; only the user changes it.`;
  }
}

class Closed
  extends Schema.TaggedError<Closed>()("Closed", {
    id: Schema.Number,
    status: Schema.String
  })
  implements Refusable
{
  get refusal(): string {
    return `#${this.id} is ${this.status}; only an open one moves.`;
  }
}

class NotAnotherOpen
  extends Schema.TaggedError<NotAnotherOpen>()("NotAnotherOpen", {
    into: Schema.Number
  })
  implements Refusable
{
  get refusal(): string {
    return `#${this.into} is not another open anticipation.`;
  }
}

class NoKind extends Schema.TaggedError<NoKind>()("NoKind", { kind: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No kind ${this.kind}: one of ${ANTICIPATION_KINDS.join(", ")}.`;
  }
}

class PreparedTooLong
  extends Schema.TaggedError<PreparedTooLong>()("PreparedTooLong", {
    length: Schema.Number
  })
  implements Refusable
{
  get refusal(): string {
    return `prepared is ${this.length} characters, limit ${PREPARED_CHARS}.`;
  }
}

class NoWindow extends Schema.TaggedError<NoWindow>()("NoWindow", {}) implements Refusable {
  get refusal(): string {
    return "An upcoming one needs a window: from and to.";
  }
}

class NotADate
  extends Schema.TaggedError<NotADate>()("NotADate", {
    what: Schema.String,
    value: Schema.String
  })
  implements Refusable
{
  get refusal(): string {
    return `${this.what} "${this.value}" is not a date; write it like 2026-10-17T08:00:00+02:00.`;
  }
}

class NoTo extends Schema.TaggedError<NoTo>()("NoTo", {}) implements Refusable {
  get refusal(): string {
    return "A window needs a to.";
  }
}

class Needs extends Schema.TaggedError<Needs>()("Needs", { what: Schema.String }) implements Refusable {
  get refusal(): string {
    return `This action needs ${this.what}.`;
  }
}

class OnlyUserPins extends Schema.TaggedError<OnlyUserPins>()("OnlyUserPins", {}) implements Refusable {
  get refusal(): string {
    return "Only the user pins.";
  }
}

class LookLists extends Schema.TaggedError<LookLists>()("LookLists", {}) implements Refusable {
  get refusal(): string {
    return "A look may only list anticipations.";
  }
}

class NoticeTurn extends Schema.TaggedError<NoticeTurn>()("NoticeTurn", {}) implements Refusable {
  get refusal(): string {
    return "This turn was started by a notice, not the user: ask the user before changing anticipations.";
  }
}

class Refused extends Schema.TaggedError<Refused>()("Refused", { refusal: Schema.String }) implements Refusable {}

type DraftRefusal = NoKind | PreparedTooLong | NotDates | Backwards | NoWindow | Empty | NotOneLine | TooLong;

type EvidenceRefusal = NoEvidence | Missing | NotFromChat | Relayed;

type AddRefusal = DraftRefusal | EvidenceRefusal | NoPass | NoOwnWords | OutsideStretch | EpisodeFull | OpenFull | RunFull;

type ChangeRefusal = NoAnticipation | EpisodeOnlyAdds | UsersOwn | Pinned;

type ToolRefusal = AddRefusal | ChangeRefusal | Illegal | Closed | NotAnotherOpen | Refused | NotADate | NoTo | Needs | OnlyUserPins | LookLists | NoticeTurn;

const checkText = (line: string): Effect.Effect<string, Empty | NotOneLine | TooLong> => {
  const trimmed = line.trim();

  if (trimmed === "") return Effect.fail(new Empty());

  if (/[\r\n]/.test(trimmed)) return Effect.fail(new NotOneLine());

  if (bytes(trimmed) > TEXT_BYTES) return Effect.fail(new TooLong({ bytes: bytes(trimmed) }));

  return Effect.succeed(trimmed);
};

const checkWindow = (window: Window): Effect.Effect<Window, NotDates | Backwards> => {
  if (!Number.isFinite(window.from) || !Number.isFinite(window.to)) return Effect.fail(new NotDates());

  if (window.to < window.from) return Effect.fail(new Backwards());

  return Effect.succeed(window);
};

const checkDraft = Effect.fn("Anticipations.checkDraft")(function* (draft: Draft) {
  if (!ANTICIPATION_KINDS.includes(draft.kind)) return yield* new NoKind({ kind: draft.kind });
  const prepared = draft.prepared?.trim() || undefined;

  if (prepared !== undefined && prepared.length > PREPARED_CHARS) return yield* new PreparedTooLong({ length: prepared.length });
  const window = draft.window === undefined ? undefined : yield* checkWindow(draft.window);

  if (draft.kind === "upcoming" && window === undefined) return yield* new NoWindow();

  return { text: yield* checkText(draft.text), prepared, window };
});

const AnticipateInput = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("close"), Type.Literal("extend"), Type.Literal("absorb"), Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("list")]),
  id: Type.Optional(
    Type.Integer({
      description: "The anticipation, for close, extend, absorb, pin and unpin."
    })
  ),
  kind: Type.Optional(Type.Union([Type.Literal("open_loop"), Type.Literal("upcoming"), Type.Literal("predicted_ask"), Type.Literal("watch")])),
  text: Type.Optional(Type.String({ description: `One line, at most ${TEXT_BYTES} bytes.` })),
  messages: Type.Optional(
    Type.Array(Type.Integer(), {
      description: "Chat message rowids it rests on, as chat_search and the digest show them (#123)."
    })
  ),
  memories: Type.Optional(Type.Array(Type.Integer(), { description: "Memory ids it rests on (#7)." })),
  prepared: Type.Optional(
    Type.String({
      description: `Up to ${PREPARED_CHARS} characters of context a future turn would need.`
    })
  ),
  from: Type.Optional(
    Type.String({
      description: "When it starts to matter, an ISO date and time with its offset."
    })
  ),
  to: Type.Optional(
    Type.String({
      description: "When it stops mattering, an ISO date and time with its offset."
    })
  ),
  outcome: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("dismissed")])),
  note: Type.Optional(
    Type.String({
      description: "For close done: the outcome in one line, kept as a memory."
    })
  ),
  into: Type.Optional(
    Type.Integer({
      description: "For absorb: the open anticipation that now stands for this one."
    })
  ),
  about: Type.Optional(
    Type.String({
      description: "For list: only the open ones these words, or a window around now, match."
    })
  ),
  hours: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 168,
      description: "For list: only the dates in the next this many hours."
    })
  )
});

type AnticipateArgs = Static<typeof AnticipateInput>;

export type Call = {
  readonly args: AnticipateArgs;
  readonly by: Actor;
  readonly session: string;
  readonly pass: EpisodePass | undefined;
  readonly listOnly: boolean;
};

const USER_ACTS: ReadonlySet<string> = new Set(["add", "close", "extend", "absorb", "pin", "unpin"]);

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const when = (value: string, what: string): Effect.Effect<number, NotADate> => {
  const ms = Date.parse(value);

  return Number.isNaN(ms) ? Effect.fail(new NotADate({ what, value })) : Effect.succeed(ms);
};

const windowOf = Effect.fn("Anticipations.windowOf")(function* (from: string | undefined, to: string | undefined, now: number) {
  if (to === undefined) {
    if (from !== undefined) return yield* new NoTo();

    return undefined;
  }

  return {
    from: from === undefined ? now : yield* when(from, "from"),
    to: yield* when(to, "to")
  };
});

const need = <T>(value: T | undefined, what: string): Effect.Effect<T, Needs> => (value === undefined ? Effect.fail(new Needs({ what })) : Effect.succeed(value));

export function anticipationLine(row: Anticipation, now: number): string {
  const days = Math.max(0, Math.floor((now - row.created_at) / 86_400_000));
  const age = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} old`;
  const window = row.window_from === null || row.window_to === null ? "" : `, ${iso(row.window_from)} to ${iso(row.window_to)}`;
  const cited = [...row.evidence.messages.map((id) => `message #${id}`), ...row.evidence.memories.map((id) => `memory #${id}`)].join(", ");

  return `- #${row.id} ${row.kind}, ${row.status}, ${age}, by ${row.created_by}${row.pinned ? ", pinned" : ""}${window}: ${row.text} (rests on ${cited})`;
}

const lines = (rows: readonly Anticipation[], now: number) => (rows.length === 0 ? "None open." : rows.map((row) => anticipationLine(row, now)).join("\n"));

type Deps = {
  readonly memory: Memory;
  readonly chat: (session: string) => boolean;
  readonly entries: SqlStorage;
  readonly closed: () => void;
};

const nowOr = (now: number | undefined) => (now === undefined ? Clock.currentTimeMillis : Effect.succeed(now));

export class Anticipating extends Context.Service<
  Anticipating,
  {
    readonly get: (id: number) => Effect.Effect<Anticipation, NoAnticipation>;
    readonly add: (draft: Draft, by: Creator, now: number | undefined, pass: EpisodePass | undefined) => Effect.Effect<Anticipation, AddRefusal>;
    readonly open: Effect.Effect<Anticipation[]>;
    readonly match: (terms: readonly string[], now: number, limit: number) => Effect.Effect<Anticipation[]>;
    readonly recallable: (terms: readonly string[], now: number, limit: number) => Effect.Effect<Anticipation[]>;
    readonly recalled: (ids: readonly number[], now: number | undefined) => Effect.Effect<void>;
    readonly due: (now: number, until: number) => Effect.Effect<Anticipation[]>;
    readonly close: (id: number, outcome: "done" | "dismissed", by: Actor, note: string | undefined, now: number | undefined) => Effect.Effect<Anticipation, ChangeRefusal | Illegal | Refused>;
    readonly extend: (id: number, window: Window, by: Actor) => Effect.Effect<Anticipation, ChangeRefusal | Closed | NotDates | Backwards>;
    readonly absorb: (id: number, into: number, by: Actor, now: number | undefined) => Effect.Effect<Anticipation, ChangeRefusal | NotAnotherOpen | Illegal>;
    readonly expire: (now: number | undefined) => Effect.Effect<number>;
    readonly pin: (id: number, pinned: boolean) => Effect.Effect<void, NoAnticipation>;
    readonly act: (call: Call) => Effect.Effect<string, ToolRefusal>;
  }
>()("ky/dreaming/Anticipating") {
  static readonly layer = ({ memory, chat, entries, closed }: Deps) =>
    Layer.effect(
      Anticipating,
      Effect.gen(function* () {
        const sql = yield* Sql;
        const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
        const rows = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), (found) => found.flatMap((row) => anticipationRow(row) ?? []));
        const count = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), ([row]) => countOf(row));

        yield* exec(`CREATE TABLE IF NOT EXISTS ky_anticipations (
          id INTEGER PRIMARY KEY,
          created_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          evidence TEXT NOT NULL,
          prepared TEXT,
          window_from INTEGER,
          window_to INTEGER,
          status TEXT NOT NULL DEFAULT 'open',
          pinned INTEGER NOT NULL DEFAULT 0,
          absorbed_into INTEGER,
          closed_at INTEGER,
          recalled_at INTEGER)`);

        const columns = yield* Effect.orDie(sql.rows(ColumnRow, "PRAGMA table_info(ky_anticipations)"));

        if (!columns.some((column) => column.name === "recalled_at")) yield* exec("ALTER TABLE ky_anticipations ADD COLUMN recalled_at INTEGER");

        const get = Effect.fn("Anticipations.get")(function* (id: number) {
          const [row] = yield* rows("SELECT * FROM ky_anticipations WHERE id = ?", id);

          return row ?? (yield* new NoAnticipation({ id }));
        });

        const open = rows(`SELECT * FROM ky_anticipations WHERE ${LIVE} ORDER BY id`);

        const own = (ids: readonly number[]) => Effect.sync(() => ownMessages(entries, ids));

        const placesOf = Effect.fn("Anticipations.placesOf")(function* (ids: readonly number[]) {
          const messages = (yield* exec(
            `SELECT id, conversation_id, json_extract(record, '$.kind') AS kind FROM pi_entries
             WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(record, '$.kind') IN ('pi.user', 'pi.assistant')`,
            JSON.stringify(ids)
          )).flatMap((row) => Option.toArray(decodeMessage(row)));

          const users = yield* own(messages.flatMap((message) => (message.kind === "pi.user" ? [message.id] : [])));

          return new Map<number, MessagePlace>(
            messages.map((message) => [
              message.id,
              {
                conversation: String(message.conversation_id),
                notice: message.kind === "pi.user" && !users.has(message.id)
              }
            ])
          );
        });

        const checkEvidence = Effect.fn("Anticipations.checkEvidence")(function* (evidence: Evidence) {
          const messages = [...new Set(evidence.messages)];
          const memories = [...new Set(evidence.memories)];

          if (messages.length + memories.length === 0) return yield* new NoEvidence();
          const places = yield* placesOf(messages);
          const absent: string[] = messages.flatMap((id) => (places.has(id) ? [] : [`message #${id}`]));

          for (const id of memories) {
            if ((yield* count("SELECT COUNT(*) AS n FROM memo_log WHERE id = ?", id)) === 0) absent.push(`memory #${id}`);
          }

          if (absent.length > 0) return yield* new Missing({ cited: absent });

          const elsewhere = messages.filter((id) => {
            const place = places.get(id);

            return place !== undefined && !chat(place.conversation);
          });

          if (elsewhere.length > 0) return yield* new NotFromChat({ ids: elsewhere });
          const notices = messages.filter((id) => places.get(id)?.notice === true);

          if (notices.length > 0) return yield* new Relayed({ ids: notices });

          return { messages, memories };
        });

        const checkPass = Effect.fn("Anticipations.checkPass")(function* (evidence: Evidence, pass: EpisodePass | undefined) {
          if (pass === undefined) return yield* new NoPass();

          if (evidence.messages.length === 0) return yield* new NoOwnWords();
          const users = yield* own(evidence.messages);
          const places = yield* placesOf(evidence.messages);
          const outside = evidence.messages.filter((id) => id <= pass.after || id > pass.upto || !users.has(id) || places.get(id)?.conversation !== pass.parent);

          if (outside.length > 0) return yield* new OutsideStretch({ ids: outside });

          const added = yield* count(
            `SELECT COUNT(*) AS n FROM ky_anticipations AS a WHERE created_by = 'episode' AND EXISTS (
               SELECT 1 FROM json_each(a.evidence, '$.messages') AS cited JOIN pi_entries AS e ON e.id = cited.value
               WHERE e.conversation_id = ? AND e.id > ? AND e.id <= ?)`,
            Number(pass.parent),
            pass.after,
            pass.upto
          );

          if (added >= EPISODE_CAP) return yield* new EpisodeFull();
        });

        const checkRoom = Effect.fn("Anticipations.checkRoom")(function* (by: Creator, now: number) {
          if (by !== "user" && (yield* open).length >= OPEN_CAP) return yield* new OpenFull();

          if (by === "dream" && (yield* rows("SELECT * FROM ky_anticipations WHERE created_by = 'dream' AND created_at > ?", now - RUN_MS)).length >= RUN_CAP) {
            return yield* new RunFull();
          }
        });

        const add = Effect.fn("Anticipations.add")(function* (draft: Draft, by: Creator, at: number | undefined, pass: EpisodePass | undefined) {
          const now = yield* nowOr(at);
          const { text: line, prepared, window } = yield* checkDraft(draft);
          const evidence = yield* checkEvidence(draft.evidence);

          if (by === "episode") yield* checkPass(evidence, pass);
          yield* checkRoom(by, now);

          return yield* Effect.orDie(
            Effect.head(
              rows(
                `INSERT INTO ky_anticipations (created_at, created_by, kind, text, evidence, prepared, window_from, window_to)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
                now,
                by,
                draft.kind,
                line,
                JSON.stringify(evidence),
                prepared ?? null,
                window?.from ?? null,
                window?.to ?? null
              )
            )
          );
        });

        const latestAsk = Effect.fn("Anticipations.latestAsk")(function* (conversation: string) {
          const users = (yield* exec(
            "SELECT id AS n FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user' ORDER BY id DESC LIMIT ?",
            Number(conversation),
            RECENT_USERS
          )).map(countOf);

          const mine = yield* own(users);

          return users.find((id) => mine.has(id));
        });

        const matching = (terms: readonly string[], now: number, limit: number, recalledBefore: number) => {
          const words = [...new Set(terms.flatMap((term) => (term.trim().length >= TERM_CHARS ? [term.trim().toLowerCase()] : [])))].slice(0, MATCH_TERMS);
          const keyword = words.map(() => "text LIKE ? ESCAPE '\\' OR prepared LIKE ? ESCAPE '\\'");

          return rows(
            `SELECT * FROM ky_anticipations
             WHERE ${LIVE} AND ((window_from <= ? AND window_to >= ? AND (recalled_at IS NULL OR recalled_at < ?))${keyword.map((each) => ` OR ${each}`).join("")})
             ORDER BY (window_from <= ? AND window_to >= ?) DESC, id DESC LIMIT ?`,
            now,
            now,
            recalledBefore,
            ...words.flatMap((word) => [like(word), like(word)]),
            now,
            now,
            limit
          );
        };

        const due = (now: number, until: number) =>
          rows(`SELECT * FROM ky_anticipations WHERE ${LIVE} AND kind = 'upcoming' AND window_from <= ? AND window_to >= ? ORDER BY window_from, id`, until, now);

        const legal = (row: Anticipation, to: AnticipationStatus) => (MOVES[row.status].includes(to) ? Effect.void : Effect.fail(new Illegal({ id: row.id, status: row.status, to })));

        const move = Effect.fn("Anticipations.move")(function* (row: Anticipation, to: AnticipationStatus, now: number, absorbedInto: number | null) {
          yield* legal(row, to);
          const closedAt = MOVES[to].length === 0 ? now : null;
          yield* exec("UPDATE ky_anticipations SET status = ?, closed_at = ?, absorbed_into = ? WHERE id = ?", to, closedAt, absorbedInto, row.id);

          if (closedAt !== null) yield* Effect.sync(closed);
        });

        const changeable = Effect.fn("Anticipations.changeable")(function* (id: number, by: Actor) {
          const row = yield* get(id);

          if (by === "episode") return yield* new EpisodeOnlyAdds();

          if (by !== "user" && row.created_by === "user") return yield* new UsersOwn({ id });

          if (by !== "user" && row.pinned) return yield* new Pinned({ id });

          return row;
        });

        const close = Effect.fn("Anticipations.close")(function* (id: number, outcome: "done" | "dismissed", by: Actor, note: string | undefined, at: number | undefined) {
          const now = yield* nowOr(at);
          const row = yield* changeable(id, by);
          yield* legal(row, outcome);

          if (outcome === "done") {
            const done = `Done: ${row.text}`;
            const said = note?.trim() || (bytes(done) <= TEXT_BYTES ? done : row.text);
            yield* Effect.try({
              try: () => memory.note(said),
              catch: (cause) =>
                new Refused({
                  refusal: cause instanceof Error ? cause.message : String(cause)
                })
            });
          }

          yield* move(row, outcome, now, null);

          return yield* Effect.orDie(get(id));
        });

        const extend = Effect.fn("Anticipations.extend")(function* (id: number, window: Window, by: Actor) {
          const row = yield* changeable(id, by);

          if (MOVES[row.status].length === 0) return yield* new Closed({ id, status: row.status });
          const { from, to } = yield* checkWindow(window);
          yield* exec("UPDATE ky_anticipations SET window_from = ?, window_to = ? WHERE id = ?", from, to, id);

          return yield* Effect.orDie(get(id));
        });

        const absorb = Effect.fn("Anticipations.absorb")(function* (id: number, into: number, by: Actor, at: number | undefined) {
          const now = yield* nowOr(at);
          const row = yield* changeable(id, by);
          const target = yield* get(into);

          if (into === id || MOVES[target.status].length === 0) return yield* new NotAnotherOpen({ into });
          yield* move(row, "dismissed", now, into);

          return yield* Effect.orDie(get(id));
        });

        const pin = Effect.fn("Anticipations.pin")(function* (id: number, pinned: boolean) {
          yield* get(id);
          yield* exec("UPDATE ky_anticipations SET pinned = ? WHERE id = ?", pinned ? 1 : 0, id);
        });

        const pinning = Effect.fn("Anticipations.pinning")(function* ({ args, by }: Call, pinned: boolean) {
          if (by !== "user") return yield* new OnlyUserPins();
          const id = yield* need(args.id, "id");
          yield* pin(id, pinned);

          return `#${id} is ${pinned ? "pinned: it never expires, and only the user changes it" : "unpinned"}.`;
        });

        const adding = Effect.fn("Anticipations.adding")(function* ({ args, by, session, pass }: Call, now: number) {
          const asked = by === "user" ? yield* latestAsk(session) : undefined;
          const messages = [...(args.messages ?? []), ...(asked === undefined ? [] : [asked])];
          const kind = yield* need(args.kind, "kind");
          const line = yield* need(args.text, "text");
          const window = yield* windowOf(args.from, args.to, now);

          const row = yield* add(
            {
              kind,
              text: line,
              evidence: { messages, memories: args.memories ?? [] },
              prepared: args.prepared,
              window
            },
            by,
            now,
            pass
          );

          return `Saved as #${row.id}.`;
        });

        const closing = Effect.fn("Anticipations.closing")(function* ({ args, by }: Call, now: number) {
          const id = yield* need(args.id, "id");
          const outcome = yield* need(args.outcome, "outcome");
          yield* close(id, outcome, by, args.note, now);

          return `#${id} is ${outcome}${outcome === "done" ? "; its outcome is a memory now" : ""}.`;
        });

        const extending = Effect.fn("Anticipations.extending")(function* ({ args, by }: Call, now: number) {
          const id = yield* need(args.id, "id");
          const row = yield* extend(id, yield* need(yield* windowOf(args.from, args.to, now), "to"), by);

          return `#${row.id} now matters from ${iso(row.window_from ?? now)} to ${iso(row.window_to ?? now)}.`;
        });

        const absorbing = Effect.fn("Anticipations.absorbing")(function* ({ args, by }: Call, now: number) {
          const id = yield* need(args.id, "id");
          const into = yield* need(args.into, "into");
          const row = yield* absorb(id, into, by, now);

          return `#${row.id} is folded into #${into}.`;
        });

        const listing = Effect.fn("Anticipations.listing")(function* ({ args }: Call, now: number) {
          if (args.about !== undefined) return lines(yield* matching(args.about.split(/[^\p{L}\p{N}_]+/u), now, 5, Number.MAX_SAFE_INTEGER), now);

          if (args.hours !== undefined) return lines(yield* due(now, now + args.hours * 3_600_000), now);

          return lines(yield* open, now);
        });

        const handle = (call: Call, now: number) => {
          switch (call.args.action) {
            case "add":
              return adding(call, now);
            case "close":
              return closing(call, now);
            case "extend":
              return extending(call, now);
            case "absorb":
              return absorbing(call, now);
            case "pin":
              return pinning(call, true);
            case "unpin":
              return pinning(call, false);
            case "list":
              return listing(call, now);
          }
        };

        return Anticipating.of({
          get,
          add,
          open,
          match: (terms, now, limit) => matching(terms, now, limit, Number.MAX_SAFE_INTEGER),
          recallable: (terms, now, limit) => matching(terms, now, limit, now - RECALL_AGAIN_MS),
          recalled: Effect.fn("Anticipations.recalled")(function* (ids, at) {
            if (ids.length === 0) return;
            yield* exec("UPDATE ky_anticipations SET recalled_at = ? WHERE id IN (SELECT value FROM json_each(?))", yield* nowOr(at), JSON.stringify(ids));
          }),
          due,
          close,
          extend,
          absorb,
          expire: Effect.fn("Anticipations.expire")(function* (at) {
            const now = yield* nowOr(at);

            const expired = (yield* exec("UPDATE ky_anticipations SET status = 'expired', closed_at = ? WHERE status = 'open' AND pinned = 0 AND window_to < ? RETURNING id", now, now)).length;

            if (expired > 0) yield* Effect.sync(closed);

            return expired;
          }),
          pin,
          act: Effect.fn("Anticipations.act")(function* (call) {
            if (call.args.action !== "list" && call.listOnly) return yield* new LookLists();

            if (call.by === "user" && USER_ACTS.has(call.args.action) && !(yield* Effect.sync(() => startedByUser(entries, call.session)))) return yield* new NoticeTurn();

            return yield* handle(call, yield* Clock.currentTimeMillis);
          })
        });
      })
    );
}

export class Anticipations {
  readonly #edge: Edge<Anticipating>;
  readonly #closed = new Set<() => void>();

  constructor(storage: DurableObjectStorage, memory: Memory, chat: (session: string) => boolean) {
    const closed = () => {
      for (const listener of this.#closed) listener();
    };

    this.#edge = makeEdge(Anticipating.layer({ memory, chat, entries: storage.sql, closed }).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  onClose(listener: () => void): void {
    this.#closed.add(listener);
  }

  get(id: number): Anticipation {
    return runOrThrow(
      this.#edge,
      Anticipating.use((store) => store.get(id))
    );
  }

  add(draft: Draft, by: Creator, now?: number, pass?: EpisodePass): Anticipation {
    return runOrThrow(
      this.#edge,
      Anticipating.use((store) => store.add(draft, by, now, pass))
    );
  }

  open(): Anticipation[] {
    return this.#edge.run(Anticipating.use((store) => store.open));
  }

  match(terms: readonly string[], now: number, limit = 5): Anticipation[] {
    return this.#edge.run(Anticipating.use((store) => store.match(terms, now, limit)));
  }

  recallable(terms: readonly string[], now: number, limit = 5): Anticipation[] {
    return this.#edge.run(Anticipating.use((store) => store.recallable(terms, now, limit)));
  }

  recalled(ids: readonly number[], now?: number): void {
    this.#edge.run(Anticipating.use((store) => store.recalled(ids, now)));
  }

  due(now: number, until = now + DAY_MS): Anticipation[] {
    return this.#edge.run(Anticipating.use((store) => store.due(now, until)));
  }

  close(id: number, outcome: "done" | "dismissed", by: Actor, note?: string, now?: number): Anticipation {
    return runOrThrow(
      this.#edge,
      Anticipating.use((store) => store.close(id, outcome, by, note, now))
    );
  }

  expire(now?: number): number {
    return this.#edge.run(Anticipating.use((store) => store.expire(now)));
  }

  act(call: Call): string {
    return runOrThrow(
      this.#edge,
      Anticipating.use((store) => store.act(call))
    );
  }
}

export function anticipateTool(anticipations: Anticipations, actor: (session: string) => Actor, pass: (session: string) => EpisodePass | undefined, listOnly: (session: string) => boolean) {
  return defineTool({
    name: ANTICIPATE,
    description:
      "What the user will need soon: an open loop they committed to, a date ahead, a question likely next, or something to watch. add needs kind, text (one line) and evidence: the chat messages (#rowid) or memories (#id) it rests on. Nothing that only a page, file, tool output or a notice brought up. From the main chat, the user's message is cited for you. prepared is the context a future turn would need. close says done (with note: the outcome, kept as a memory) or dismissed; extend moves its window; absorb folds it into another; pin keeps one for the user; list shows the open ones, about some words or the dates of the next hours.",
    parameters: AnticipateInput,
    replay: "unsafe",
    execute: async (args, api) => {
      const session = String(api.conversationId);
      const by = actor(session);

      return text(
        anticipations.act({
          args,
          by,
          session,
          pass: by === "episode" ? pass(session) : undefined,
          listOnly: listOnly(session)
        })
      );
    }
  });
}
