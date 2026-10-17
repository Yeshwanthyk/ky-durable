import { ROOT_SESSION } from "agents/harness/pi";
import { type Automations, draftProblem } from "../automations/contract";
import { refused, type Result } from "../core/refusal";
import { ownMessages } from "../history";
import type { Anticipations } from "./anticipations";
import { countOf, type Creator, entryAt, type Proposal, proposalKey, type ProposalSpec, type ProposalStatus, proposalRow, type ProposalView } from "./contract";
import { localDay } from "./local-day";
import type { Proactivity } from "./proactivity";
import type { Surfaced } from "./surfaced";

/**
 * Proposals: an automation the dream suggests because the user kept doing the same check by hand, shown in
 * Activity › Suggested until the user accepts or dismisses it. Nothing turns on by itself
 * (docs/research/proactivity/dreaming-proactivity.md §4): only the dream proposes, only the user accepts, and
 * accepting creates the automation through the same path as the user's own save, as theirs (created_by user).
 *
 * The dream proposes through the `anticipate` tool's `propose` action, and is refused: for a key it offered
 * before in any status (a dismissal latches forever, and an accepted one is never offered again), past
 * OPEN_CAP open ones or NIGHT_CAP new ones a night, for a spec the automation tool would refuse, and unless
 * it cites the user's own messages from at least MIN_DAYS different local days: the repeated manual check.
 * While proactivity is off, nothing is proposed, shown, accepted or dismissed.
 */

/** Open proposals at most: the list is a short suggestion, not a backlog. */
const OPEN_CAP = 5;

/** New proposals one dream may make; a night is counted as the last NIGHT_MS. */
export const NIGHT_CAP = 2;

const NIGHT_MS = 12 * 3_600_000;

/** The different local days the cited messages of the user must fall on: the check was repeated. */
const MIN_DAYS = 2;

/** A key is a short slug, like "check-ci-main", so the digest can list them and the dream can repeat one exactly. */
const KEY = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** A recurring cron in UTC: five fields. Its syntax is checked when the automation is booked, on accept. */
const CRON = /^\S+(\s+\S+){4}$/;

/** What the dream proposes: its key, what it is and why, the automation's spec, and the user's messages it rests on. */
export type ProposalDraft = {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly spec: ProposalSpec;
  readonly messages: readonly number[];
};

/** A decision the user made on a proposal: empty when it went through, or why it was refused. */
export type Decided = { readonly refused?: string };

export type ProposalsParts = {
  readonly sql: SqlStorage;
  readonly anticipations: Pick<Anticipations, "checkEvidence">;
  readonly surfaced: Surfaced;
  readonly proactivity: Pick<Proactivity, "level">;
  readonly automations: Pick<Automations, "create" | "checkIns">;
};

export class Proposals {
  readonly #parts: ProposalsParts;

  constructor(parts: ProposalsParts) {
    this.#parts = parts;
    parts.sql.exec(`CREATE TABLE IF NOT EXISTS ky_proposals (
      id INTEGER PRIMARY KEY,
      dedup_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      why TEXT NOT NULL,
      spec TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      decided_at INTEGER)`);
  }

  /** The dream's proposal, saved open; an error saying why when it is refused, for the model to read. */
  propose(draft: ProposalDraft, by: Creator, now = Date.now()): Proposal {
    if (by !== "dream") throw new Error("Only the dream proposes automations.");

    this.#checkOn();
    this.#checkNew(draft.key, now);
    const problem = specProblem(draft);

    if (problem !== undefined) throw new Error(problem);
    const evidence = this.#parts.anticipations.checkEvidence({ messages: [...draft.messages], memories: [] });
    this.#checkRepeated(evidence.messages);

    const row = proposalRow(
      this.#parts.sql
        .exec(
          "INSERT INTO ky_proposals (dedup_key, title, why, spec, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
          draft.key,
          draft.title.trim(),
          draft.why.trim(),
          JSON.stringify(draft.spec),
          JSON.stringify(evidence),
          now
        )
        .toArray()[0]
    );

    if (row === undefined) throw new Error("The proposal was not saved.");

    return row;
  }

  /** Every key proposed and its status, newest first, for the dream's digest: none is offered twice. */
  keys(): { readonly key: string; readonly status: ProposalStatus }[] {
    return this.#parts.sql
      .exec("SELECT dedup_key, status FROM ky_proposals ORDER BY id DESC")
      .toArray()
      .flatMap((raw) => {
        const row = proposalKey(raw);

        return row === undefined ? [] : [{ key: row.dedup_key, status: row.status }];
      });
  }

  /** Activity › Suggested: the open proposals, oldest first; none while proactivity is off. */
  view(): ProposalView[] {
    if (this.#parts.proactivity.level() === "off") return [];

    return this.#open().map((row) => ({
      id: row.id,
      title: row.title,
      why: row.why,
      cron: row.spec.cron,
      prompt: row.spec.prompt,
      gate: row.spec.gate,
      days: this.#days(row.evidence.messages),
      created_at: row.created_at
    }));
  }

  /** The user's screen showed these proposals: each is recorded as surfaced, once. Ids not open are skipped; nothing while off. */
  seen(ids: readonly number[], now = Date.now()): void {
    if (this.#parts.proactivity.level() === "off") return;

    for (const row of this.#open().filter((each) => ids.includes(each.id))) this.#show(row, now);
  }

  /**
   * The user accepted: the automation is created as theirs, through the same path as their own save, and the
   * proposal is accepted. Refused while off, once it is no longer open, or when the save is refused (an
   * unparseable cron), which leaves it open.
   */
  async accept(id: number, now = Date.now()): Promise<Decided> {
    const row = this.#decide(id, "accepted", now);

    if ("refused" in row) return { refused: row.refused };

    const saved = await this.#parts.automations.create(
      { title: row.title, prompt: row.spec.prompt, cron: row.spec.cron, at: null, model: null, machine: null, chat: ROOT_SESSION, gate: row.spec.gate },
      "user"
    );

    if ("refused" in saved) {
      this.#parts.sql.exec("UPDATE ky_proposals SET status = 'open', decided_at = NULL WHERE id = ?", id);

      return { refused: saved.refused };
    }

    this.#settle(row, "acted", now);

    return {};
  }

  /** The user dismissed it: its key latches, and the dream never offers it again. Refused while off or once decided. */
  dismiss(id: number, now = Date.now()): Decided {
    const row = this.#decide(id, "dismissed", now);

    if ("refused" in row) return { refused: row.refused };
    this.#settle(row, "dismissed", now);

    return {};
  }

  /** Claim an open proposal as `status`, once: a second tap, or a tap while off, is refused. */
  #decide(id: number, status: "accepted" | "dismissed", now: number): Result<Proposal> {
    if (this.#parts.proactivity.level() === "off") return refused("Proactivity is off: ky makes no suggestions.");

    const row = proposalRow(
      this.#parts.sql.exec("UPDATE ky_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open' RETURNING *", status, now, id).toArray()[0]
    );

    return row ?? refused(`Suggestion #${id} is not open.`);
  }

  /** The surfaced row's outcome; a decision proves it was shown, if the page's report has not come. */
  #settle(row: Proposal, outcome: "acted" | "dismissed", now: number): void {
    this.#show(row, now);
    this.#parts.surfaced.outcome("proposal", row.dedup_key, outcome, now);
  }

  #show(row: Proposal, now: number): void {
    this.#parts.surfaced.shown(
      { kind: "proposal", loop: "dream", ref: `proposal:${row.id}`, item: row.dedup_key, text: row.title, expiresAt: Number.MAX_SAFE_INTEGER },
      now
    );
  }

  #open(): Proposal[] {
    return this.#parts.sql
      .exec("SELECT * FROM ky_proposals WHERE status = 'open' ORDER BY id")
      .toArray()
      .flatMap((raw) => proposalRow(raw) ?? []);
  }

  /** Refused while proactivity is off: ky suggests nothing. */
  #checkOn(): void {
    if (this.#parts.proactivity.level() === "off") throw new Error("Proactivity is off: ky suggests nothing.");
  }

  /** Refuse a bad or used key (in any status), and a proposal past the open or the nightly cap. */
  #checkNew(key: string, now: number): void {
    if (!KEY.test(key)) throw new Error('A key is a lowercase slug, like "check-ci-main".');
    const count = (query: string, ...values: SqlStorageValue[]) => countOf(this.#parts.sql.exec(query, ...values).toArray()[0]);

    if (count("SELECT COUNT(*) AS n FROM ky_proposals WHERE dedup_key = ?", key) > 0) {
      throw new Error(`"${key}" was proposed before; the user decided or will: never offer it again.`);
    }

    if (count("SELECT COUNT(*) AS n FROM ky_proposals WHERE status = 'open'") >= OPEN_CAP) {
      throw new Error(`${OPEN_CAP} suggestions are waiting for the user already: propose no more.`);
    }

    if (count("SELECT COUNT(*) AS n FROM ky_proposals WHERE created_at > ?", now - NIGHT_MS) >= NIGHT_CAP) {
      throw new Error(`A dream proposes at most ${NIGHT_CAP} a night; this one has.`);
    }
  }

  /** Refuse unless the user's own messages among `messages` fall on at least MIN_DAYS local days. */
  #checkRepeated(messages: readonly number[]): void {
    const own = ownMessages(this.#parts.sql, messages);
    const days = this.#days(messages.filter((id) => own.has(id)));

    if (days.length < MIN_DAYS) {
      throw new Error(`Cite the user's own messages doing the check on at least ${MIN_DAYS} different days; these fall on ${days.length}.`);
    }
  }

  /** The distinct local days the user's messages among `messages` were sent on, in order. */
  #days(messages: readonly number[]): string[] {
    const zone = this.#parts.automations.checkIns().zone;
    const days = new Set<string>();

    for (const raw of this.#parts.sql.exec(
      `SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM pi_entries
       WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(record, '$.kind') = 'pi.user'`,
      JSON.stringify(messages)
    )) {
      const entry = entryAt(raw);

      if (entry !== undefined) days.add(localDay(zone, entry.at));
    }

    return [...days].sort();
  }
}

/** What the automation tool would refuse in the spec, and what a proposal needs besides: a recurring cron. */
function specProblem(draft: ProposalDraft): string | undefined {
  if (!draft.why.trim()) return "Say why: what the user kept checking by hand, and on which days.";

  return (
    draftProblem({ title: draft.title, prompt: draft.spec.prompt, cron: draft.spec.cron, at: null, gate: draft.spec.gate }) ??
    (CRON.test(draft.spec.cron.trim()) ? undefined : "A proposal runs on a recurring schedule: give a five-field cron, in UTC.")
  );
}
