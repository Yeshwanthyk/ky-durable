/**
 * Every data migration ky has released, oldest first (src/core/migrate.ts runs them). A ky's level is how many
 * of these it has applied. Add a migration at the end; never rename, reorder or remove one once it has shipped,
 * since kys and their archives record each by its place and name.
 *
 * A migration names what it rewrites as literals, never by a live constant: it rewrites the data of its own
 * moment, whatever later code calls things.
 */
import * as Effect from "effect/Effect";
import type { Migration } from "./core/migrate";
import { Sql } from "./core/sql";

/**
 * Migration 1's renames. pi-durable names its own kinds under `pi.` (and the agents SDK under `agents.`), so
 * a bare name can't meet one of theirs.
 */
const KINDS = {
  /** pi_tasks: task definition names (src/skills/subagents.ts, src/skills/specialists.ts, src/peers/group.ts). */
  tasks: [
    ["ky.subagent-anchor", "subagent-anchor"],
    ["ky.subagent-reporter", "subagent-reporter"],
    ["ky.discuss", "discuss"],
    ["ky.specialist-reply", "specialist-reply"]
  ],
  /** pi_documents: document kinds (src/skills/subagents.ts, src/automations/automations.ts, src/cards/wiring.ts). */
  documents: [
    ["ky.subagents", "subagents"],
    ["ky.automation-runs", "automation-runs"],
    ["ky.run-cards", "run-cards"]
  ],
  /** pi_entries: transcript entry kinds (src/core/transcript.ts, src/cards/contract.ts). */
  entries: [
    ["ky.to-specialists", "to-specialists"],
    ["ky.specialist-reply", "specialist-reply"],
    ["ky.look", "look"],
    ["ky.card-answer", "card-answer"]
  ]
} as const;

/** The tags ky writes into a user's message text (src/core/late.ts, src/files/media.ts). */
const TAGS = [
  ["<ky-late>", "<late-note>"],
  ["</ky-late>", "</late-note>"],
  ["<ky-media", "<media-clip"],
  ["</ky-media>", "</media-clip>"]
] as const;

type Pairs = readonly (readonly [string, string])[];

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** `value` with each pair's old text replaced by its new, as nested SQL replace() calls. */
const replaced = (value: string, pairs: Pairs) => pairs.reduce((inner, [from, to]) => `replace(${inner}, ${quote(from)}, ${quote(to)})`, value);

/** A CASE mapping `value`, one of the pairs' old texts, to its new. */
const mapped = (value: string, pairs: Pairs, wrap: (text: string) => string = quote) =>
  `CASE ${value} ${pairs.map(([from, to]) => `WHEN ${wrap(from)} THEN ${wrap(to)}`).join(" ")} END`;

const oneOf = (pairs: Pairs, wrap: (text: string) => string = quote) => `(${pairs.map(([from]) => wrap(from)).join(", ")})`;

/** pi stores a task's and a document's kind column as a JSON string, quotes and all (its encodeIndexedString). */
const indexed = (text: string) => quote(JSON.stringify(text));

/** Rows holding a tag: a LIKE per old open tag. */
const holdsTag = (column: string) => `(${column} LIKE '%<ky-late>%' OR ${column} LIKE '%<ky-media%')`;

/**
 * A kind inside JSON text, as JSON.stringify writes it: `"kind":"ky.look"`. Inside a JSON string (a user's words,
 * a tool's output) the same characters are escaped (`\"kind\":\"ky.look\"`), so this matches only a real key.
 */
const jsonKind = (pairs: Pairs): Pairs => pairs.map(([from, to]) => [`"kind":${JSON.stringify(from)}`, `"kind":${JSON.stringify(to)}`]);

const Named = Effect.fn("Named")(function* (table: string) {
  const sql = yield* Sql;

  return (yield* sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table)).length > 0;
});

/**
 * Rewrites the product name out of the identifiers ky stores in pi's tables, so a later rename of the product
 * never touches stored data:
 *
 * - a task's kind, in pi_tasks' column and its record: a kind pi has no definition for parks the task;
 * - a document's kind, in pi_documents' column and its record: pi finds a document by kind;
 * - an entry's kind, in its record: the thread projects an entry by kind;
 * - an entry draft's kind in a queued input or write, held in a document's revisions (pi.inbox);
 * - the late and media tags in stored message text, everywhere but what the model said and what tools returned
 *   (pi.assistant and pi.tool-result entries), which are history as they were.
 *
 * A table that isn't there is skipped: a ky with data but no pi tables yet has nothing of these.
 */
const neutralKinds = Effect.gen(function* () {
  const sql = yield* Sql;

  if (yield* Named("pi_tasks")) {
    const { tasks } = KINDS;
    yield* sql.exec(
      `UPDATE pi_tasks SET kind = ${mapped("kind", tasks, indexed)}, record = json_set(record, '$.kind', ${mapped("json_extract(record, '$.kind')", tasks)})
        WHERE kind IN ${oneOf(tasks, indexed)}`
    );
    yield* sql.exec(`UPDATE pi_tasks SET record = ${replaced("record", TAGS)} WHERE ${holdsTag("record")}`);
  }

  if (yield* Named("pi_documents")) {
    const { documents } = KINDS;
    yield* sql.exec(
      `UPDATE pi_documents SET kind = ${mapped("kind", documents, indexed)}, record = json_set(record, '$.kind', ${mapped("json_extract(record, '$.kind')", documents)})
        WHERE kind IN ${oneOf(documents, indexed)}`
    );
  }

  if (yield* Named("pi_document_revisions")) {
    yield* sql.exec(
      `UPDATE pi_document_revisions SET content = ${replaced(replaced("content", jsonKind(KINDS.entries)), TAGS)}
        WHERE content LIKE '%"kind":"ky.%' OR ${holdsTag("content")}`
    );
  }

  if (yield* Named("pi_entries")) {
    const { entries } = KINDS;
    yield* sql.exec(
      `UPDATE pi_entries SET record = json_set(record, '$.kind', ${mapped("json_extract(record, '$.kind')", entries)})
        WHERE json_extract(record, '$.kind') IN ${oneOf(entries)}`
    );
    yield* sql.exec(
      `UPDATE pi_entries SET record = ${replaced("record", TAGS)}
        WHERE ${holdsTag("record")} AND json_extract(record, '$.kind') NOT IN ('pi.assistant', 'pi.tool-result')`
    );
  }
});

export const MIGRATIONS: readonly Migration[] = [{ name: "neutral stored kinds and tags", run: neutralKinds }];
