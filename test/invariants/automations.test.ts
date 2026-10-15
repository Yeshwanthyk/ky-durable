import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TOOL,
  automationRows,
  AutomationToolInput,
  BY_ID_ACTIONS,
  CHECK_IN_TOOLS,
  AUTOMATION_TABLES,
  taskRows,
  TOOL_ACTIONS
} from "../../src/automations/contract";

const SRC = path.join(import.meta.dirname, "../../src");

const DOMAIN = path.join(SRC, "automations");

const read = (file: string) => readFileSync(file, "utf8");

/** Every .ts file under `dir`, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "tests" ? [] : sources(full);

    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const domain = sources(DOMAIN).map(read).join("\n");

const automation = {
  id: "a1",
  title: "Digest",
  prompt: "digest",
  cron: "0 9 * * *",
  at: null,
  model: null,
  machine: null,
  chat: "0",
  gate: null,
  gate_checked_at: null,
  gate_note: null,
  gate_errors: 0,
  created_by: "user",
  status: "active",
  schedule_id: null,
  created_at: 1,
  updated_at: 1
};

const task = {
  id: "t1",
  kind: "cloud",
  source: "chat",
  worker: "w",
  title: "T",
  status: "done",
  summary: "",
  steps: "[]",
  session: null,
  agent: null,
  created_at: 1,
  updated_at: 1,
  started_at: null,
  finished_at: null,
  turns: null,
  cost_usd: null
};

describe("stored rows", () => {
  it("reads a model column", () => {
    const model = { provider: "p", modelId: "m", thinkingLevel: "high" };

    expect(automationRows([{ ...automation, model: JSON.stringify(model) }])[0]?.model).toEqual(model);
  });

  it.each(["{", "null", "[]", `{"provider":"p"}`, `{"provider":"p","modelId":"m","thinkingLevel":"loud"}`])(
    "reads the corrupt model column %j as the worker's",
    (model) => {
      expect(automationRows([{ ...automation, model }])).toEqual([{ ...automation, model: null }]);
    }
  );

  it.each(["{", "null", `{"at":1}`, `[{"at":"x","text":"y"}]`])("reads the corrupt steps column %j as none", (steps) => {
    expect(taskRows([{ ...task, steps }])).toEqual([{ ...task, steps: [] }]);
  });

  it("leaves out a row damaged past reading, keeping the rest", () => {
    expect(automationRows([{ ...automation, status: "lost" }, automation])).toHaveLength(1);
    expect(taskRows([{ ...task, kind: 3 }, null, task])).toHaveLength(1);
  });
});

describe("tools", () => {
  /** Every tool name a defineTool registers in src. */
  const registered = new Set(
    sources(SRC).flatMap((file) => [...read(file).matchAll(/defineTool\(\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]))
  );

  it("allows a check-in only tools that are registered", () => {
    expect(CHECK_IN_TOOLS.filter((tool) => !registered.has(tool))).toEqual([]);
  });

  it("registers the automation tool by the contract's name, which no other tool takes", () => {
    expect(read(path.join(DOMAIN, "automations.ts"))).toMatch(/defineTool\(\{\s*name: AUTOMATION_TOOL,/);
    expect(registered).not.toContain(AUTOMATION_TOOL);
  });
});

describe("tables", () => {
  const names: readonly string[] = Object.values(AUTOMATION_TABLES);

  const created = [...domain.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]);

  it("creates exactly the tables the contract names", () => {
    expect([...created].sort()).toEqual([...names].sort());
  });

  it("creates only if missing, and never drops a table", () => {
    expect(domain).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(domain).not.toMatch(/DROP TABLE/i);
  });

  it("touches no ky_ table the contract doesn't name", () => {
    const touched = new Set([...domain.matchAll(/\bky_[a-z_]*[a-z]\b/g)].map((match) => match[0]));

    expect([...touched].filter((table) => !names.includes(table))).toEqual([]);
  });
});

describe("actions", () => {
  it("the tool takes exactly the contract's actions", () => {
    for (const action of TOOL_ACTIONS) expect(Value.Check(AutomationToolInput, { action })).toBe(true);
    expect(Value.Check(AutomationToolInput, { action: "explode" })).toBe(false);
  });

  it.each(BY_ID_ACTIONS)("handles %s: a tool handler, an Automations method and a socket case", (action) => {
    const automations = read(path.join(DOMAIN, "automations.ts"));

    expect(automations).toMatch(new RegExp(`^\\s+${action}: \\(automations, id\\) => automations\\.${action}\\(id\\)`, "m"));
    expect(automations).toMatch(new RegExp(`^  (async )?${action}\\(id: string\\)`, "m"));
    expect(read(path.join(SRC, "sockets.ts"))).toMatch(new RegExp(`^\\s+${action}: \\(id\\) => this\\.#automations\\.${action}\\(id\\)`, "m"));
  });
});
