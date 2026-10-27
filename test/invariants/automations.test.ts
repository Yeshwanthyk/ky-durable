import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { ModelChoiceSchema } from "../../src/settings/contract";
import { budget } from "../parity/kit";
import { type Action, actions, HOUR, installIds, next, port, START, World } from "../parity/automations/world";

const SRC = path.join(import.meta.dirname, "../../src");

const DOMAIN = path.join(SRC, "automations");

const read = (file: string) => readFileSync(file, "utf8");

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
  watch: null,
  post: 0,
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
  chat: null,
  created_at: 1,
  updated_at: 1,
  started_at: null,
  finished_at: null,
  turns: null,
  cost_usd: null
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

describe("stored rows", () => {
  it("reads a model column", () => {
    const model = { provider: "p", modelId: "m", thinkingLevel: "high" };

    expect(automationRows([{ ...automation, model: JSON.stringify(model) }])[0]?.model).toEqual(model);
  });

  it.each(["{", "null", "[]", `{"provider":"p"}`, `{"provider":"p","modelId":"m","thinkingLevel":"loud"}`])(
    "reads the corrupt model column %j as the worker's",
    (model) => {
      expect(automationRows([{ ...automation, model }])).toEqual([{ ...automation, zone: "UTC", model: null, post: false }]);
    }
  );

  it("reads any model text as the choice it holds, or the worker's, and keeps the row", () => {
    const level = fc.constantFrom("off", "minimal", "low", "medium", "high", "xhigh", "max", "loud");
    const choice = fc.record({ provider: fc.string(), modelId: fc.string(), thinkingLevel: level }, { requiredKeys: [] });
    const text = fc.oneof(fc.string(), fc.json(), choice.map((each) => JSON.stringify(each)), fc.tuple(choice, fc.dictionary(fc.string(), fc.jsonValue())).map(([each, extra]) => JSON.stringify({ ...extra, ...each })));

    fc.assert(
      fc.property(text, (model) => {
        const parsed = Option.getOrUndefined(parseJson(model));

        const expected = Value.Check(ModelChoiceSchema, parsed) ? { provider: parsed.provider, modelId: parsed.modelId, thinkingLevel: parsed.thinkingLevel } : null;

        expect(automationRows([{ ...automation, model }])).toEqual([{ ...automation, zone: "UTC", model: expected, post: false }]);
      })
    );
  });

  it.each(["{", "null", `{"at":1}`, `[{"at":"x","text":"y"}]`])("reads the corrupt steps column %j as none", (steps) => {
    expect(taskRows([{ ...task, steps }])).toEqual([{ ...task, steps: [] }]);
  });

  it("keeps a row stored without its zone column, which reads as the column's default, UTC", () => {
    expect(automationRows([automation])).toEqual([{ ...automation, zone: "UTC", post: false }]);
  });

  it("leaves out a row damaged past reading, keeping the rest", () => {
    expect(automationRows([{ ...automation, status: "lost" }, automation])).toHaveLength(1);
    expect(taskRows([{ ...task, kind: 3 }, null, task])).toHaveLength(1);
  });
});

describe("tools", () => {
  const registered = new Set(
    sources(SRC).flatMap((file) => [...read(file).matchAll(/defineTool\(\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]))
  );

  it("allows a check-in only tools that are registered", () => {
    expect(CHECK_IN_TOOLS.filter((tool) => !registered.has(tool))).toEqual([]);
  });

  it("registers the automation tool by the contract's name, which no other tool takes", () => {
    expect(read(path.join(DOMAIN, "tool.ts"))).toMatch(/defineTool\(\{\s*name: AUTOMATION_TOOL,/);
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
    expect(read(path.join(DOMAIN, "tool.ts"))).toMatch(new RegExp(`^\\s+${action}: \\(automations, id\\) => automations\\.${action}\\(id\\)`, "m"));
    expect(read(path.join(DOMAIN, "wiring.ts"))).toMatch(new RegExp(`^  (async )?${action}\\(id: string\\)`, "m"));
    expect(read(path.join(SRC, "sockets.ts"))).toMatch(new RegExp(`^\\s+${action}: \\(id\\) => this\\.#automations\\.${action}\\(id\\)`, "m"));
  });
});

type Step = Action | { readonly advance: number } | { readonly advance: "alarm" };

const steps: fc.Arbitrary<Step[]> = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: actions },
    { weight: 1, arbitrary: fc.record({ advance: fc.integer({ min: 1_000, max: 2 * HOUR }) }) },
    { weight: 1, arbitrary: fc.record({ advance: fc.constant("alarm" as const) }) }
  ),
  { minLength: 5, maxLength: 40 }
);

const PAUSED_AFTER_DONE: Step[] = [
  { create: { title: "Digest", prompt: "digest", cron: "0 9 * * *", at: null }, author: "user", watch: null },
  { act: "run", id: "00000001" },
  { advance: "alarm" },
  { world: "progress", id: "00000001", status: "working" },
  { world: "progress", id: "00000001", status: "done" },
  { act: "pause", id: "00000001" },
  { world: "report", id: "00000001" }
];

function overlapping(world: World): string[] {
  return world.rows("SELECT source FROM ky_tasks WHERE status IN ('queued', 'working') GROUP BY source HAVING COUNT(*) > 1").map((row) => String(row.source));
}

const twice = (seen: readonly { task: string }[]) => seen.flatMap(({ task }, at) => (seen.findIndex((each) => each.task === task) === at ? [] : [task]));

describe("runs", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    installIds();
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const holds = (check: (world: World) => void) =>
    fc.assert(
      fc.asyncProperty(steps, async (run) => {
        const time = { at: START };
        const side = next({ now: () => time.at });

        try {
          for (const step of run) {
            if (!("advance" in step)) await side.apply(step);
            else {
              const to = step.advance === "alarm" ? side.scheduler.nextAlarm() : time.at + step.advance;

              if (to !== null && to >= time.at) {
                time.at = to;
                await side.due();
              }
            }

            check(side.world);
          }
        } finally {
          await side.dispose();
        }
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed, examples: [[PAUSED_AFTER_DONE]] }
    );

  it("OneRunPerSlot: a slot starts one run, however often it fires", async () => {
    await holds((world) => {
      expect(twice(world.started)).toEqual([]);
    });
  });

  it("NoOverlap: an automation has at most one run going", async () => {
    await holds((world) => {
      expect(overlapping(world)).toEqual([]);
    });
  });

  it("NothingAfterPause: no run starts unless its automation is active, and none reports once it is paused, archived or gone", async () => {
    await holds((world) => {
      expect(world.started.filter((seen) => seen.status !== "active")).toEqual([]);
      expect(world.posted.filter((seen) => seen.status !== "active" && seen.status !== "done")).toEqual([]);
    });
  });
});

const EARLY_AUTOMATIONS = `CREATE TABLE ky_automations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, at INTEGER, model TEXT, machine TEXT,
  chat TEXT NOT NULL, created_by TEXT NOT NULL, status TEXT NOT NULL, schedule_id TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL)`;

describe("stored data", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("reads what an early B stored: its automations take the new columns' defaults, and its check-ins keep their zone", async () => {
    const world = new World({ now: () => START });
    world.db.exec(EARLY_AUTOMATIONS);
    world.db.exec("CREATE TABLE ky_check_ins (id INTEGER PRIMARY KEY CHECK (id = 1), off INTEGER NOT NULL, zone TEXT)");
    world.db.exec("INSERT INTO ky_check_ins (id, off, zone) VALUES (1, 1, 'Europe/London')");
    world.rows(
      "INSERT INTO ky_automations VALUES ('a1', 'Digest', 'digest', '0 9 * * *', NULL, ?, NULL, '1', 'user', 'active', NULL, 1, 1), ('a2', 'Call', 'call', NULL, ?, NULL, 'mini', '1', 'ky', 'done', NULL, 2, 2)",
      JSON.stringify({ provider: "workers-ai", modelId: "glm", thinkingLevel: "off" }),
      START + HOUR
    );
    world.feed.create({ id: "a-a2-1", kind: "machine", source: "automation:a2", worker: "mini", title: "Call", status: "done", session: null });

    const automations = port(world, world.deps());

    expect(automations.checkIns()).toEqual({ on: false, zone: "Europe/London", pinned: false });
    expect((await automations.list(true)).map(({ id, zone, gate, gate_errors, post, watch, model, last_run }) => ({ id, zone, gate, gate_errors, post, watch, model, last: last_run?.status ?? null }))).toEqual([
      { id: "a2", zone: "UTC", gate: null, gate_errors: 0, post: false, watch: null, model: null, last: "done" },
      { id: "a1", zone: "UTC", gate: null, gate_errors: 0, post: false, watch: null, model: { provider: "workers-ai", modelId: "glm", thinkingLevel: "off" }, last: null }
    ]);
    world.db.close();
  });
});
