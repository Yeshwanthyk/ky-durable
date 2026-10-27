import { ownerRoute, pairAs, tokenRoute } from "../../../src/runners/legacy/runners";
import { Sandboxes } from "../../../src/runners/legacy/sandboxes";
import type { Side } from "./world";

export const legacy: Side = { registry: (_storage, sql) => new Sandboxes(sql), tokenRoute, ownerRoute, pairAs };
