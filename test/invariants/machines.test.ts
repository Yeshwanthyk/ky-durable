import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeOr, parseOr } from "../../src/core/decode";
import {
  decodeObjectFrame,
  decodeReport,
  MACHINE_ACTIONS,
  MACHINE_TABLES,
  MACHINE_TOOL,
  MachineLoginSchema,
  MachineStateSchema,
  PROTOCOL,
  QueuedSchema,
  TASK_REPORT_TYPES,
  TurnsRowSchema,
  WIRE
} from "../../src/machines/contract";
import { describeTool } from "../../src/tool-labels";

/**
 * What must stay true of the machines domain: the tables it keeps, the frames it takes from a
 * runner and sends one, and its tool. The hub itself loads the Worker, so it is read here as source;
 * src/tests/runner-protocol.test.ts drives it.
 */
const root = path.join(import.meta.dirname, "../..");

const source = (file: string) => readFileSync(path.join(root, file), "utf8");

const hub = source("src/machines/machines.ts");

/** The `type` literals of a union of object schemas, however deeply the unions nest. */
type Node = { anyOf?: Node[]; properties?: { type?: { const?: string } } };

function typesOf(schema: Node): string[] {
  if (schema.anyOf) return schema.anyOf.flatMap(typesOf);

  const type = schema.properties?.type?.const;

  return type === undefined ? [] : [type];
}

const cases = (text: string) => new Set([...text.matchAll(/case "([a-z_]+)":/g)].map((match) => match[1]));

describe("the machines domain's tables", () => {
  const created = [...hub.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/g)];

  it("creates each table the contract names, only those, and only if it is not there", () => {
    expect(created.map((match) => match[2]).sort()).toEqual(Object.values(MACHINE_TABLES).sort());
    expect(created.filter((match) => match[1] === undefined)).toEqual([]);
  });

  it("names each table with the ky_machine prefix a backup leaves out", () => {
    expect(Object.values(MACHINE_TABLES).filter((table) => !table.startsWith("ky_machine"))).toEqual([]);
    expect(source("src/backup.ts")).toContain("ky_machine");
  });

  it("never drops a table on start", () => {
    expect(hub).not.toMatch(/\bDROP\s+TABLE\b/i);
  });
});

describe("the machines domain's stored JSON", () => {
  it("decodes a queued command that isn't JSON, or isn't a command, to none", () => {
    expect(parseOr(QueuedSchema, "{oops", undefined)).toBeUndefined();
    expect(parseOr(QueuedSchema, '{"type":"run","task":"m-1"}', undefined)).toBeUndefined();
    expect(parseOr(QueuedSchema, '{"type":"stop","task":"m-1","turn":2}', undefined)).toEqual({ type: "stop", task: "m-1", turn: 2 });
  });

  it("decodes a damaged state or login to its default", () => {
    expect(decodeOr(MachineStateSchema, "sideways", "on")).toBe("on");
    expect(decodeOr(MachineLoginSchema, "nobody", "own")).toBe("own");
    expect(decodeOr(MachineStateSchema, "paused", "on")).toBe("paused");
  });

  it("reads a task's turns with the turn it was asked to stop, which decides a stopped result", () => {
    expect(Object.keys(TurnsRowSchema.properties).sort()).toEqual(["closed", "sent", "stopping", "turn"]);
    expect(hub).toMatch(/ALTER TABLE ky_machine_turns ADD COLUMN stopping INTEGER NOT NULL DEFAULT 0/);
  });
});

describe("the runner's frames", () => {
  const reports = typesOf(WIRE.report);
  const pipeHandlers = cases(source("src/pipe.ts"));

  it("has a handler for every report type: the hub's task reports, the pipe's http_ ones", () => {
    const tasks = Object.keys(TASK_REPORT_TYPES);
    const pipe = reports.filter((type) => !tasks.includes(type));

    expect(tasks.filter((type) => !reports.includes(type))).toEqual([]);
    expect(pipe.filter((type) => !type.startsWith("http_"))).toEqual([]);
    expect(tasks.filter((type) => !cases(hub).has(type))).toEqual([]);
    expect(pipe.filter((type) => !pipeHandlers.has(type))).toEqual([]);
  });

  it("has a handler in the runner for every command and frame the object sends", () => {
    const runner = cases(source("cli/runner/runner.ts"));

    expect(typesOf(WIRE.command).length).toBeGreaterThan(0);
    expect(typesOf(WIRE.frame).filter((type) => !runner.has(type))).toEqual([]);
  });

  it("rejects a malformed report: not JSON, an unknown type, or a known one missing its fields", () => {
    expect(decodeReport("not json")).toEqual({ kind: "malformed" });
    expect(decodeReport('{"type":"shrug"}')).toEqual({ kind: "malformed" });
    expect(decodeReport('{"type":"result","task":"m-1"}')).toEqual({ kind: "malformed" });
    expect(decodeReport(`{"type":"hello","protocol":${PROTOCOL},"version":"x","active":[],"facts":{"kind":"mac"}}`)).toEqual({ kind: "malformed" });
    expect(decodeReport('{"type":"ack","seq":3}')).toEqual({ kind: "report", report: { type: "ack", seq: 3 } });
  });

  it("rejects a malformed frame from the object, which the runner then ignores", () => {
    expect(decodeObjectFrame("{")).toBeUndefined();
    expect(decodeObjectFrame('{"type":"run","seq":1,"task":"m-1"}')).toBeUndefined();
    expect(decodeObjectFrame('{"type":"cf_agent_state"}')).toBeUndefined();
  });
});

describe("the machine tool", () => {
  it("is a tool the activity labels know", () => {
    expect(describeTool(MACHINE_TOOL, { action: "list" }).icon).toBe("monitor");
  });

  it("handles only the actions it takes: each by name, but send, which is what a task's other actions leave", () => {
    const named = [...hub.matchAll(/args\.action === "(\w+)"/g)].map((match) => match[1] ?? "");
    const actions: readonly string[] = MACHINE_ACTIONS;

    expect(named.filter((action) => !actions.includes(action))).toEqual([]);
    expect(actions.filter((action) => !named.includes(action))).toEqual(["send"]);
  });
});
