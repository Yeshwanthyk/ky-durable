import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge, type Refusable } from "../core/edge";
import { Sql } from "../core/sql";
import { isMachine, type SkillWrite } from "../skills/contract";
import type { Reviews, Skills } from "../skills/wiring";
import type { DreamLedgerRow } from "./contract";
import type { Memory, MemoryForget } from "./memory";

const DESTRUCTIVE: ReadonlySet<string> = new Set(["edit", "patch", "archive", "revert", "forget"]);

const NIGHT_MS = 12 * 60 * 60 * 1000;

const DREAMS = "coalesce(actor, 'dream') = 'dream'";

const LedgerRow = Schema.Struct({
  id: Schema.Number,
  run: Schema.String,
  kind: Schema.Literals(["skill", "memory"]),
  action: Schema.String,
  target: Schema.String,
  before: Schema.Union([Schema.Number, Schema.String, Schema.Null]),
  reason: Schema.NullOr(Schema.String),
  absorbed_into: Schema.NullOr(Schema.String),
  at: Schema.Number,
  undone_at: Schema.NullOr(Schema.Number),
  actor: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.Number)
});

const decodeRow = Schema.decodeUnknownOption(LedgerRow);

const ColumnRow = Schema.Struct({ name: Schema.String });

type Kind = DreamLedgerRow["kind"];

class AlreadyChanged extends Schema.TaggedError<AlreadyChanged>()("AlreadyChanged", { kind: Schema.Literals(["skill", "memory"]), target: Schema.String, action: Schema.String }) implements Refusable {
  get refusal(): string {
    return `This run already changed ${this.target} (${this.action}); one change per ${this.kind === "skill" ? "skill" : "summary"} a run, so each can be undone on its own.`;
  }
}

class NotSaved extends Schema.TaggedError<NotSaved>()("NotSaved", {}) implements Refusable {
  get refusal(): string {
    return "The ledger row was not saved, so the change is not made.";
  }
}

class NoChange extends Schema.TaggedError<NoChange>()("NoChange", { id: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `No dream change ${this.id}.`;
  }
}

class AlreadyUndone extends Schema.TaggedError<AlreadyUndone>()("AlreadyUndone", { actor: Schema.NullOr(Schema.String), action: Schema.String, target: Schema.String }) implements Refusable {
  get refusal(): string {
    return `The ${this.actor ?? "dream"}'s ${this.action} of ${this.target} is already undone.`;
  }
}

class ChangedSince extends Schema.TaggedError<ChangedSince>()("ChangedSince", {
  target: Schema.String,
  action: Schema.String,
  version: Schema.Number,
  by: Schema.Struct({ action: Schema.String, actor: Schema.String })
}) implements Refusable {
  get refusal(): string {
    return `${this.target} changed after this ${this.action} (version ${this.version}, ${this.by.action} by ${this.by.actor}), so undo would lose that; revert it from its history instead.`;
  }
}

class PinnedSince extends Schema.TaggedError<PinnedSince>()("PinnedSince", { target: Schema.String, action: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.target} was pinned since; unpin it first to undo this ${this.action}.`;
  }
}

class Refused extends Schema.TaggedError<Refused>()("Refused", { refusal: Schema.String }) implements Refusable {}

const refusedBy = (cause: unknown) => new Refused({ refusal: cause instanceof Error ? cause.message : String(cause) });

type Entry = {
  readonly run: string;
  readonly actor: string;
  readonly kind: Kind;
  readonly action: string;
  readonly target: string;
  readonly before: number | string | null;
  readonly reason: string | null;
  readonly absorbed_into: string | null;
};

type Deps = { readonly skills: Skills; readonly memory: Memory; readonly reviews: Reviews };

export class Ledger extends Context.Service<
  Ledger,
  {
    readonly skillWrite: (write: SkillWrite) => Effect.Effect<number, AlreadyChanged | NotSaved>;
    readonly landed: (id: number, version: number) => Effect.Effect<void>;
    readonly forget: (forget: MemoryForget) => Effect.Effect<void, AlreadyChanged | NotSaved>;
    readonly lastNight: Effect.Effect<DreamLedgerRow[]>;
    readonly undo: (id: number) => Effect.Effect<string, NoChange | AlreadyUndone | ChangedSince | PinnedSince | Refused>;
  }
>()("ky/dreaming/Ledger") {
  static readonly layer = ({ skills, memory, reviews }: Deps) =>
    Layer.effect(
      Ledger,
      Effect.gen(function* () {
        const sql = yield* Sql;
        const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
        const rows = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), (found) => found.flatMap((row) => Option.toArray(decodeRow(row))));

        yield* exec(`CREATE TABLE IF NOT EXISTS ky_dream_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run TEXT NOT NULL,
          kind TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          before,
          reason TEXT,
          absorbed_into TEXT,
          at INTEGER NOT NULL,
          undone_at INTEGER
        )`);

        const have = new Set((yield* exec("PRAGMA table_info(ky_dream_ledger)")).flatMap((row) => Option.toArray(Schema.decodeUnknownOption(ColumnRow)(row)).map((column) => column.name)));

        for (const [name, type] of [["actor", "TEXT"], ["after", "INTEGER"]] as const) {
          if (!have.has(name)) yield* exec(`ALTER TABLE ky_dream_ledger ADD COLUMN ${name} ${type}`);
        }

        const record = Effect.fn("Ledger.record")(function* (entry: Entry, at: number) {
          if (DESTRUCTIVE.has(entry.action)) {
            const earlier = (yield* rows("SELECT * FROM ky_dream_ledger WHERE kind = ? AND target = ? AND run = ? AND undone_at IS NULL", entry.kind, entry.target, entry.run)).find(
              (row) => DESTRUCTIVE.has(row.action)
            );

            if (earlier) return yield* new AlreadyChanged({ kind: entry.kind, target: entry.target, action: earlier.action });
          }

          const [row] = yield* rows(
            "INSERT INTO ky_dream_ledger (run, actor, kind, action, target, before, reason, absorbed_into, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
            entry.run,
            entry.actor,
            entry.kind,
            entry.action,
            entry.target,
            entry.before,
            entry.reason,
            entry.absorbed_into,
            at
          );

          return row?.id ?? (yield* new NotSaved());
        });

        const undoSkill = Effect.fn("Ledger.undoSkill")(function* ({ target, before, after, action }: DreamLedgerRow) {
          const skill = yield* Effect.sync(() => skills.get(target));
          const [newest] = yield* Effect.sync(() => skills.history(target));

          if (after !== null && newest !== undefined && newest.id !== after) {
            return yield* new ChangedSince({ target, action, version: newest.id, by: { action: newest.action, actor: newest.actor } });
          }

          if (skill?.pinned) return yield* new PinnedSince({ target, action });

          return yield* Effect.try({
            try: () =>
              before === null ? skills.apply({ name: target, action: "archive" }, "user") : skills.apply({ name: target, action: "revert", version: Number(before) }, "user"),
            catch: refusedBy
          });
        });

        return Ledger.of({
          skillWrite: Effect.fn("Ledger.skillWrite")(function* ({ name, action, actor, conversation, run, before, absorbed_into, reason }) {
            const at = yield* Clock.currentTimeMillis;
            const owner = run ?? (conversation === null ? `${actor}-${at}` : yield* Effect.sync(() => reviews.run(conversation)));

            return yield* record({ run: owner, actor, kind: "skill", action, target: name, before, reason, absorbed_into }, at);
          }),
          landed: (id, version) => Effect.asVoid(exec("UPDATE ky_dream_ledger SET after = ? WHERE id = ?", version, id)),
          forget: Effect.fn("Ledger.forget")(function* ({ block, text, conversation }) {
            if (conversation === null) return;
            const kind = yield* Effect.sync(() => reviews.kind(conversation));

            if (kind === undefined) return;
            const run = yield* Effect.sync(() => reviews.run(conversation));
            yield* record({ run, actor: kind, kind: "memory", action: "forget", target: block, before: text, reason: null, absorbed_into: null }, yield* Clock.currentTimeMillis);
          }),
          lastNight: rows(`SELECT * FROM ky_dream_ledger WHERE ${DREAMS} AND at > (SELECT MAX(at) FROM ky_dream_ledger WHERE ${DREAMS}) - ? ORDER BY id`, NIGHT_MS),
          undo: Effect.fn("Ledger.undo")(function* (id) {
            const [row] = yield* rows("SELECT * FROM ky_dream_ledger WHERE id = ?", id);

            if (!row) return yield* new NoChange({ id });

            if (row.undone_at !== null) return yield* new AlreadyUndone({ actor: row.actor, action: row.action, target: row.target });
            const done = row.kind === "memory" ? yield* Effect.try({ try: () => memory.renote(String(row.before)), catch: refusedBy }) : yield* undoSkill(row);
            yield* exec("UPDATE ky_dream_ledger SET undone_at = ? WHERE id = ?", yield* Clock.currentTimeMillis, id);

            return done;
          })
        });
      })
    );
}

const thrown = <A, E extends Refusable>(effect: Effect.Effect<A, E, Ledger>) => Effect.catch(effect, ({ refusal }) => Effect.die(new Error(refusal)));

export class DreamLedger {
  readonly #edge: Edge<Ledger>;

  constructor(storage: DurableObjectStorage, deps: Deps) {
    this.#edge = makeEdge(Ledger.layer(deps).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
    deps.skills.onWrite((write) => (isMachine(write.actor) ? this.#skillWrite(write) : undefined));
    deps.memory.onForget((forget) => this.#edge.run(thrown(Ledger.use((ledger) => ledger.forget(forget)))));
  }

  #skillWrite(write: SkillWrite): (version: number) => void {
    const id = this.#edge.run(thrown(Ledger.use((ledger) => ledger.skillWrite(write))));

    return (version) => this.#edge.run(Ledger.use((ledger) => ledger.landed(id, version)));
  }

  lastNight(): DreamLedgerRow[] {
    return this.#edge.run(Ledger.use((ledger) => ledger.lastNight));
  }

  undo(id: number): string {
    return this.#edge.run(thrown(Ledger.use((ledger) => ledger.undo(id))));
  }
}
