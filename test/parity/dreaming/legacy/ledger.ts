import Type from "typebox";
import { decodeOr } from "../../../../src/core/decode";
import { isMachine, type SkillWrite } from "../../../../src/skills/contract";
import type { Reviews, Skills } from "../../../../src/skills/wiring";
import type { DreamLedgerRow } from "../../../../src/dreaming/contract";
import { type LegacySql, ledgerRow, type Value } from "./rows";
import type { Memory, MemoryForget } from "../../../../src/dreaming/memory";

const DESTRUCTIVE: ReadonlySet<string> = new Set(["edit", "patch", "archive", "revert", "forget"]);

const NIGHT_MS = 12 * 60 * 60 * 1000;

const ColumnRow = Type.Object({ name: Type.String() });

const DREAMS = "coalesce(actor, 'dream') = 'dream'";

export class LegacyDreamLedger {
  readonly #sql: LegacySql;
  readonly #skills: Skills;
  readonly #memory: Memory;
  readonly #reviews: Reviews;

  constructor(sql: LegacySql, { skills, memory, reviews }: { readonly skills: Skills; readonly memory: Memory; readonly reviews: Reviews }) {
    this.#sql = sql;
    this.#skills = skills;
    this.#memory = memory;
    this.#reviews = reviews;
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

    const have = new Set(sql.exec("PRAGMA table_info(ky_dream_ledger)").toArray().map((column) => decodeOr(ColumnRow, column, undefined)?.name));

    for (const [name, type] of [["actor", "TEXT"], ["after", "INTEGER"]] as const) {
      if (!have.has(name)) sql.exec(`ALTER TABLE ky_dream_ledger ADD COLUMN ${name} ${type}`);
    }

    skills.onWrite((write) => (isMachine(write.actor) ? this.#skillWrite(write) : undefined));
    memory.onForget((forget) => {
      const kind = forget.conversation === null ? undefined : reviews.kind(forget.conversation);

      if (forget.conversation !== null && kind !== undefined) this.#forget(this.#reviews.run(forget.conversation), kind, forget);
    });
  }

  #skillWrite({ name, action, actor, conversation, run, before, absorbed_into, reason }: SkillWrite): (version: number) => void {
    const at = Date.now();
    const owner = run ?? (conversation === null ? `${actor}-${at}` : this.#reviews.run(conversation));
    this.#guard(owner, "skill", action, name);
    const id = this.#insert(owner, actor, "skill", action, name, before, reason, absorbed_into, at);

    return (version) => this.#sql.exec("UPDATE ky_dream_ledger SET after = ? WHERE id = ?", version, id);
  }

  #forget(run: string, actor: string, { block, text }: MemoryForget): void {
    this.#guard(run, "memory", "forget", block);
    this.#insert(run, actor, "memory", "forget", block, text, null, null, Date.now());
  }

  #guard(run: string, kind: DreamLedgerRow["kind"], action: string, target: string): void {
    if (!DESTRUCTIVE.has(action)) return;

    const earlier = this.#rows("SELECT * FROM ky_dream_ledger WHERE kind = ? AND target = ? AND run = ? AND undone_at IS NULL", kind, target, run).filter(
      (row) => DESTRUCTIVE.has(row.action)
    );

    if (earlier.length > 0) {
      throw new Error(`This run already changed ${target} (${earlier[0]?.action}); one change per ${kind === "skill" ? "skill" : "summary"} a run, so each can be undone on its own.`);
    }
  }

  #insert(
    run: string,
    actor: string,
    kind: DreamLedgerRow["kind"],
    action: string,
    target: string,
    before: number | string | null,
    reason: string | null,
    absorbedInto: string | null,
    at: number
  ): number {
    const row = this.#rows(
      "INSERT INTO ky_dream_ledger (run, actor, kind, action, target, before, reason, absorbed_into, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      run,
      actor,
      kind,
      action,
      target,
      before,
      reason,
      absorbedInto,
      at
    )[0];

    if (row === undefined) throw new Error("The ledger row was not saved, so the change is not made.");

    return row.id;
  }

  #rows(query: string, ...bindings: Value[]): DreamLedgerRow[] {
    return this.#sql
      .exec(query, ...bindings)
      .toArray()
      .flatMap((row) => ledgerRow(row) ?? []);
  }

  lastNight(): DreamLedgerRow[] {
    return this.#rows(
      `SELECT * FROM ky_dream_ledger WHERE ${DREAMS} AND at > (SELECT MAX(at) FROM ky_dream_ledger WHERE ${DREAMS}) - ? ORDER BY id`,
      NIGHT_MS
    );
  }

  undo(id: number): string {
    const [row] = this.#rows("SELECT * FROM ky_dream_ledger WHERE id = ?", id);

    if (!row) throw new Error(`No dream change ${id}.`);

    if (row.undone_at !== null) throw new Error(`The ${row.actor ?? "dream"}'s ${row.action} of ${row.target} is already undone.`);
    const done = row.kind === "memory" ? this.#memory.renote(String(row.before)) : this.#undoSkill(row);
    this.#sql.exec("UPDATE ky_dream_ledger SET undone_at = ? WHERE id = ?", Date.now(), id);

    return done;
  }

  #undoSkill({ target, before, after, action }: DreamLedgerRow): string {
    const skill = this.#skills.get(target);
    const newest = this.#skills.history(target)[0];

    if (after !== null && newest !== undefined && newest.id !== after) {
      throw new Error(
        `${target} changed after this ${action} (version ${newest.id}, ${newest.action} by ${newest.actor}), so undo would lose that; revert it from its history instead.`
      );
    }

    if (skill?.pinned) throw new Error(`${target} was pinned since; unpin it first to undo this ${action}.`);

    if (before === null) return this.#skills.apply({ name: target, action: "archive" }, "user");

    return this.#skills.apply({ name: target, action: "revert", version: Number(before) }, "user");
  }
}
