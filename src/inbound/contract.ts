/**
 * Inbound's tables, which a backup keeps and a restore puts back (src/tables.ts). A restored hook's token stays in
 * the old deploy's Vault, so its URL answers 404 until the user rotates it.
 */
export const INBOUND_TABLES = {
  hooks: "ky_hooks",
  seen: "ky_hook_seen",
  asks: "ky_secret_asks",
  /** An approved webhook action's one call, used once: not the approvals module's, which keeps no "used". */
  passes: "ky_passes"
} as const;
