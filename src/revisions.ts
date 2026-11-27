/**
 * The agent documents' revisions no rewind or fork can read, deleted once.
 *
 * A conversation's `pi.agent` document keeps every revision, and pi-durable reads a past one only as of an
 * entry's commit: a fork copies it as of the entry it forks at, and a historical read is as of an entry too.
 * Before chats followed the main slot, each provider blink rewrote every chat's model, so most revisions were
 * written while nothing was said: one chat held 79,000. A revision is kept if it is a document's newest, or if
 * an entry of any conversation was committed while it was current; the rest no read can reach.
 */
import { type Static, type TSchema, Type } from "typebox";
import { decodeOr } from "./core/decode";

const AGENT_KIND = '"pi.agent"';

/** Set once every agent document was pruned; a restore or a later start finds nothing left to do. */
const DONE_KEY = "ky:agent-revisions-pruned";

const RevisionRow = Type.Object({ seq: Type.Number(), kind: Type.String() });

const SeqRow = Type.Object({ seq: Type.Number() });

const IdRow = Type.Object({ id: Type.Number() });

const CountRow = Type.Object({ n: Type.Number() });

/** The rows of `query` as `schema` reads them; a damaged one is left out. */
function rowsOf<Schema extends TSchema>(sql: SqlStorage, schema: Schema, query: string, ...bindings: SqlStorageValue[]): Static<Schema>[] {
  return sql
    .exec(query, ...bindings)
    .toArray()
    .flatMap((raw) => {
      const row: Static<Schema> | undefined = decodeOr(schema, raw, undefined);

      return row === undefined ? [] : [row];
    });
}

/**
 * The revisions of `seqs` (ascending) to keep: the newest, and each one some commit of `commits` (ascending) fell
 * in, from its seq up to the next one's.
 */
function keptOf(seqs: readonly number[], commits: readonly number[]): Set<number> {
  const kept = new Set<number>();
  let next = 0;

  for (const [index, seq] of seqs.entries()) {
    const until = seqs[index + 1] ?? Infinity;

    while ((commits[next] ?? Infinity) < seq) next++;

    if ((commits[next] ?? Infinity) < until || until === Infinity) kept.add(seq);
  }

  return kept;
}

/** Delete the unreachable revisions of document `id`, in one transaction; how many it deleted. */
function pruneDocument(storage: DurableObjectStorage, id: number): number {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const revisions = rowsOf(sql, RevisionRow, "SELECT seq, kind FROM pi_document_revisions WHERE document_id = ? ORDER BY seq", id);
    const total = rowsOf(sql, CountRow, "SELECT count(*) AS n FROM pi_document_revisions WHERE document_id = ?", id)[0]?.n;
    const first = revisions[0];

    // A delta needs the base before it, and a damaged row can't be judged: such a document is left as it is.
    if (!first || revisions.length !== total || revisions.some((revision) => revision.kind !== "base")) return 0;

    const commits = rowsOf(sql, SeqRow, "SELECT commit_seq AS seq FROM pi_entries WHERE commit_seq >= ? ORDER BY commit_seq", first.seq).map((row) => row.seq);
    const kept = keptOf(revisions.map((revision) => revision.seq), commits);
    const dropped = revisions.filter((revision) => !kept.has(revision.seq));

    for (const { seq } of dropped) sql.exec("DELETE FROM pi_document_revisions WHERE document_id = ? AND seq = ?", id, seq);

    return dropped.length;
  });
}

/**
 * Prune every agent document once, a document at a time: each reads the tables as they are then, so a restore
 * between two is pruned as it is. Logs what it freed.
 */
export async function pruneAgentRevisions(storage: DurableObjectStorage): Promise<void> {
  if (await storage.get(DONE_KEY)) return;

  const before = storage.sql.databaseSize;
  const documents = rowsOf(storage.sql, IdRow, "SELECT id FROM pi_documents WHERE kind = ?", AGENT_KIND);
  let deleted = 0;

  for (const { id } of documents) {
    deleted += pruneDocument(storage, id);
    // Let a request in between documents.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await storage.put(DONE_KEY, true);
  console.log(`agent revisions pruned: ${deleted} deleted across ${documents.length} documents; database ${before} → ${storage.sql.databaseSize} bytes`);
}
