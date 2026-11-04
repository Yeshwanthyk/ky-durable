import path from "node:path";
import { REPO } from "../test/harness/stack.ts";

/**
 * Where perf/build.ts puts what strobe serves, under the variant strobe builds (its own checkout, so base and
 * head never share it): the stack's production build, and the state a seeded week of use leaves.
 */
export const OUT = path.join(REPO, "perf/.out");

export const BUILT = path.join(OUT, "build");

export const STATE = path.join(OUT, "state");

/** The side chat perf/build.ts fills with long answers; the benches open it by this title. */
export const LONG_CHAT = "Long chat for perf";

/** How many turns the long chat holds. */
export const LONG_TURNS = 60;
