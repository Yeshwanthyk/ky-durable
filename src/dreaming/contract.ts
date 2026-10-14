/**
 * The dreaming domain's public surface: memory (OptMem), SOUL.md and its versioned files, and the
 * nightly dream. Code outside src/dreaming/ imports from here and nowhere else in the folder.
 *
 * The shapes, tool names, frozen table names and row decoders live in ./schema (a leaf, so the files here can use
 * them without an import cycle); this file says which of them, and which classes, are public.
 */

export {
  DREAM_MEMORY_TOOLS,
  DREAMING_TABLES,
  MEMORY_WRITE_TOOLS,
  type MemoryItem,
  type MemoryRow,
  type MemorySearch,
  type MemoryView,
  SOUL_EDIT,
  type SoulAction,
  type SoulChange,
  type SoulVersion,
  type SoulView
} from "./schema";

export { DREAM_CRON, Dreaming } from "./dreaming";

export { type Compressor, Memory } from "./memory";

export { Soul, TEMPLATE, Versioned, versionLine } from "./soul";

export { dreamingTools } from "./wiring";
