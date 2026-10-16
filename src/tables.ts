/**
 * The tables a restore puts back: each domain's, as its contract names them, ky's own, and pi's and the
 * workspace's, whose schema versions a restore checks. A table an archive has that isn't one of these, an
 * old one or a stray, is left out of the restore. Machine pairings are never restored (backup.ts).
 */
import { AUTOMATION_TABLES } from "./automations/contract";
import { DREAMING_TABLES } from "./dreaming/contract";
import { PEERS_TABLES } from "./peers/contract";
import { SKILL_TABLES } from "./skills/contract";

/** ky's own tables, outside any domain, by the file that makes each. */
const CORE_TABLES = [
  // avatars.ts
  "ky_avatars",
  // chats.ts
  "ky_chats",
  "ky_main_chat",
  // files.ts
  "ky_files",
  // settings.ts
  "ky_purposes",
  // sandboxes.ts
  "ky_sandboxes",
  "ky_sandboxes_seeded",
  // setup.ts
  "ky_setup"
] as const;

/** pi-durable's tables, and the workspace's (two prefixes: its sync tables lead with an underscore). */
const LIBRARY_PREFIXES = ["pi_", "vfs_", "_vfs_"] as const;

const RESTORED: ReadonlySet<string> = new Set([
  ...CORE_TABLES,
  ...Object.values(AUTOMATION_TABLES),
  ...Object.values(DREAMING_TABLES),
  ...Object.values(PEERS_TABLES),
  ...Object.values(SKILL_TABLES)
]);

/** Whether a restore puts back a table of this name. */
export const restores = (table: string): boolean => RESTORED.has(table) || LIBRARY_PREFIXES.some((prefix) => table.startsWith(prefix));
