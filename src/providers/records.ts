import type { Api } from "@earendil-works/pi-ai";

/**
 * The providers this deploy has, one row each in `ky_providers` (C5). A row
 * is added the first time its provider can run: Workers AI always, since
 * every deploy has the AI binding; VibeProxy when the owner overlay has its
 * tunnel; an api-key vendor when its secret is set. models.ts makes each
 * enabled row live, when its transport is there now.
 */

export type ProviderKind = "workers-ai" | "api-key" | "runner-local";

export type ProviderRecord = {
  /** The pi provider id. */
  readonly id: string;
  readonly kind: ProviderKind;
  /** An api-key provider's vendor, as api-key.ts names it. */
  readonly vendor: string | null;
  /** A runner-local provider's machine; none while it is reached through the overlay's tunnel. */
  readonly machine: string | null;
  /** A runner-local provider's port on its machine. */
  readonly port: number | null;
  /** The API a runner-local provider speaks. */
  readonly api: Api | null;
  /** The name Settings shows. */
  readonly label: string;
  readonly enabled: boolean;
};

type Row = {
  id: string;
  kind: ProviderKind;
  vendor: string | null;
  machine: string | null;
  port: number | null;
  api: Api | null;
  label: string;
  enabled: number;
};

export class ProviderRecords {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_providers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      vendor TEXT,
      machine TEXT,
      port INTEGER,
      api TEXT,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL)`);
  }

  list(): ProviderRecord[] {
    return this.#sql
      .exec<Row>("SELECT id, kind, vendor, machine, port, api, label, enabled FROM ky_providers ORDER BY rowid")
      .toArray()
      .map(({ enabled, ...row }) => ({ ...row, enabled: enabled === 1 }));
  }

  /** Record a provider unless it already is, so a row the user changed keeps their change. */
  add(record: ProviderRecord): void {
    this.#sql.exec(
      `INSERT INTO ky_providers (id, kind, vendor, machine, port, api, label, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      record.id,
      record.kind,
      record.vendor,
      record.machine,
      record.port,
      record.api,
      record.label,
      record.enabled ? 1 : 0
    );
  }
}
