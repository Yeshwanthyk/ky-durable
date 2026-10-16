import { decode } from "../core/decode";
import type { Reviews, Skills, SkillWrite } from "../skills/contract";
import { DreamLedgerRow } from "./contract";
import type { Memory, MemoryForget } from "./memory";

/** The actions that overwrite or drop something; a dream makes at most one of them per target a run. */
const DESTRUCTIVE: ReadonlySet<string> = new Set(["edit", "patch", "archive", "revert", "forget"]);

/** How far back from a dream's last change "last night" reaches: its stale pass and its model run, not the night before. */
const NIGHT_MS = 12 * 60 * 60 * 1000;

/** The run of ky's own stale pass on the day of `at`, which runs just before the model's. */
const staleRun = (at: number): string => `stale-${new Date(at).toISOString().slice(0, 10)}`;

/**
 * ky_dream_ledger: one row per change a dream makes, with what it replaced, after Hermes's curator log.
 * It watches the skill library and memory, writes a row just before each change by a dream lands, and
 * refuses a second destructive change to the same target in one run. `undo` puts a change back: a skill to
 * the version before it, and a forgotten summary as a new note, since OptMem's log is never edited.
 */
export class DreamLedger {
  readonly #sql: SqlStorage;
  readonly #skills: Skills;
  readonly #memory: Memory;

  constructor(sql: SqlStorage, { skills, memory, reviews }: { readonly skills: Skills; readonly memory: Memory; readonly reviews: Reviews }) {
    this.#sql = sql;
    this.#skills = skills;
    this.#memory = memory;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_dream_ledger (
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
    skills.onWrite((write) => {
      if (write.actor === "dream") this.#skillWrite(write);
    });
    memory.onForget((forget) => {
      if (forget.conversation !== null && reviews.kind(forget.conversation) === "dream") this.#forget(forget.conversation, forget);
    });
  }

  #skillWrite({ name, action, conversation, before, absorbed_into, reason }: SkillWrite): void {
    const at = Date.now();
    const run = conversation ?? staleRun(at);
    this.#guard(run, "skill", action, name, at);
    this.#insert(run, "skill", action, name, before, reason, absorbed_into, at);
  }

  #forget(run: string, { block, text }: MemoryForget): void {
    const at = Date.now();
    this.#guard(run, "memory", "forget", block, at);
    this.#insert(run, "memory", "forget", block, text, null, null, at);
  }

  /** Refuse a second destructive change to one target in a run, counting the stale pass as part of it. */
  #guard(run: string, kind: DreamLedgerRow["kind"], action: string, target: string, at: number): void {
    if (!DESTRUCTIVE.has(action)) return;

    const earlier = this.#rows(
      `SELECT * FROM ky_dream_ledger WHERE kind = ? AND target = ? AND run IN (?, ?) AND undone_at IS NULL`,
      kind,
      target,
      run,
      staleRun(at)
    ).filter((row) => DESTRUCTIVE.has(row.action));

    if (earlier.length > 0) {
      throw new Error(`This dream already changed ${target} (${earlier[0]?.action}); one change per ${kind === "skill" ? "skill" : "summary"} a night, so each can be undone on its own.`);
    }
  }

  #insert(
    run: string,
    kind: DreamLedgerRow["kind"],
    action: string,
    target: string,
    before: number | string | null,
    reason: string | null,
    absorbedInto: string | null,
    at: number
  ): void {
    this.#sql.exec(
      "INSERT INTO ky_dream_ledger (run, kind, action, target, before, reason, absorbed_into, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      run,
      kind,
      action,
      target,
      before,
      reason,
      absorbedInto,
      at
    );
  }

  #rows(query: string, ...bindings: SqlStorageValue[]): DreamLedgerRow[] {
    return this.#sql
      .exec(query, ...bindings)
      .toArray()
      .map((row) => decode(DreamLedgerRow, row, "a dream ledger row"));
  }

  /** The changes of the latest dream, oldest first; empty before the first. */
  lastNight(): DreamLedgerRow[] {
    return this.#rows("SELECT * FROM ky_dream_ledger WHERE at > (SELECT MAX(at) FROM ky_dream_ledger) - ? ORDER BY id", NIGHT_MS);
  }

  /** Put one change back, as the user: a skill to the version before it (a created one archived), a forget re-noted. */
  undo(id: number): string {
    const [row] = this.#rows("SELECT * FROM ky_dream_ledger WHERE id = ?", id);

    if (!row) throw new Error(`No dream change ${id}.`);

    if (row.undone_at !== null) throw new Error(`The dream's ${row.action} of ${row.target} is already undone.`);
    const done = row.kind === "memory" ? this.#memory.note(String(row.before)) : this.#undoSkill(row);
    this.#sql.exec("UPDATE ky_dream_ledger SET undone_at = ? WHERE id = ?", Date.now(), id);

    return done;
  }

  #undoSkill({ target, before }: DreamLedgerRow): string {
    if (before === null) return this.#skills.apply({ name: target, action: "archive" }, "user");

    return this.#skills.apply({ name: target, action: "revert", version: Number(before) }, "user");
  }
}
