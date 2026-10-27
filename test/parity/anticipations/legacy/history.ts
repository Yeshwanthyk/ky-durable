import Type from "typebox";
import { decodeOr } from "../../../../src/core/decode";
import { isOwnRequest } from "../../../../src/history";
import type { LegacySql } from "./rows";

const PLACED_SLACK = 5_000;

const PlacedRow = Type.Object({ entry: Type.Number(), request: Type.Union([Type.String(), Type.Null()]) });

const NewestRow = Type.Object({ id: Type.Union([Type.Number(), Type.Null()]) });

export function ownMessages(sql: LegacySql, users: readonly number[]): ReadonlySet<number> {
  return new Set([...placedBy(sql, users)].flatMap(([entry, request]) => (isOwnRequest(request) ? [entry] : [])));
}

export function placedBy(sql: LegacySql, users: readonly number[]): ReadonlyMap<number, string | undefined> {
  if (users.length === 0) return new Map();

  const low = Math.min(...users);
  const high = Math.max(...users);
  const wanted = new Set(users);

  const placed = sql.exec(
    `SELECT json_extract(record, '$.entry') AS entry, json_extract(record, '$.requestId') AS request FROM pi_submissions
     WHERE id BETWEEN ? AND ? AND json_extract(record, '$.entry') BETWEEN ? AND ?`,
    low - PLACED_SLACK,
    high + PLACED_SLACK,
    low,
    high
  );

  const requests = new Map<number, string | undefined>();

  for (const raw of placed) {
    const row = decodeOr(PlacedRow, raw, undefined);

    if (row !== undefined && wanted.has(row.entry)) requests.set(row.entry, row.request ?? undefined);
  }

  return requests;
}

export function startedByUser(sql: LegacySql, conversation: string): boolean {
  const newest = decodeOr(
    NewestRow,
    sql.exec("SELECT max(id) AS id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'", Number(conversation)).one(),
    { id: null }
  ).id;

  return newest !== null && ownMessages(sql, [newest]).has(newest);
}
