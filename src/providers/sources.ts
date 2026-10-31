import type { Missing as NotSetUp } from "../avatars/contract";
import type { ModelsBoundary } from "./contract";
import type { Source } from "./endpoint";
import { apiKeys } from "./sources/api-keys";
import { chatgpt } from "./sources/chatgpt";
import { vibeProxy } from "./sources/vibeproxy";
import { workersAi } from "./sources/workers-ai";

/**
 * Every way models reach ky. Adding one is a file in sources/ and a line here. This order is the order
 * their records are first stored in; which endpoint ky prefers is each source's priority.
 */
export const SOURCES: readonly Source[] = [workersAi, vibeProxy, apiKeys, chatgpt];

/** What this deploy lacks, by every source that can say, given the providers ky has. */
export function notSetUp(boundary: ModelsBoundary, providers: readonly string[] = []): readonly NotSetUp[] {
  return SOURCES.flatMap((source) => source.missing?.(boundary, providers) ?? []);
}
