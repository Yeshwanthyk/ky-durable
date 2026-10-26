import { readFileSync } from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Sql } from "../../src/core/sql";
import {
  decodeObjectFrame,
  decodeReport,
  MACHINE_ACTIONS,
  MACHINE_TABLES,
  MACHINE_TOOL,
  MachineRow,
  PROTOCOL,
  QueuedJson,
  TASK_REPORT_TYPES,
  TurnsRow,
  WIRE
} from "../../src/machines/contract";
import type { MachineChange, TaskReport } from "../../src/machines/contract";
import { Host, Machines } from "../../src/machines/machines";
import { describeTool } from "../../src/tool-labels";
import { budget } from "../parity/kit";
import { settle, World } from "../parity/machines/world";

const root = path.join(import.meta.dirname, "../..");

const source = (file: string) => readFileSync(path.join(root, file), "utf8");

const hub = source("src/machines/machines.ts");

type Node = { anyOf?: Node[]; properties?: { type?: { enum?: string[] } } };

function typesOf(schema: Schema.Top): string[] {
  const walk = (node: Node): string[] => (node.anyOf ? node.anyOf.flatMap(walk) : (node.properties?.type?.enum ?? []));

  // SAFETY: a JSON Schema document's schema is JSON; only anyOf and the type property are read.
  return walk(Schema.toJsonSchemaDocument(schema).schema as Node);
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
    const queued = (text: string) => Option.getOrUndefined(Schema.decodeUnknownOption(QueuedJson)(text));

    expect(queued("{oops")).toBeUndefined();
    expect(queued('{"type":"run","task":"m-1"}')).toBeUndefined();
    expect(queued('{"type":"stop","task":"m-1","turn":2}')).toEqual({ type: "stop", task: "m-1", turn: 2 });
  });

  it("decodes a damaged state or login to its default", () => {
    const row = (state: string, login: string) =>
      Schema.decodeUnknownSync(MachineRow)({ name: "mini", seen_at: 1, state, note: "", facts: null, login, hello: null, reason: null });

    expect(row("sideways", "nobody")).toMatchObject({ state: "on", login: "own" });
    expect(row("paused", "ky")).toMatchObject({ state: "paused", login: "ky" });
  });

  it("reads a task's turns with the turn it was asked to stop, which decides a stopped result", () => {
    expect(Object.keys(TurnsRow.fields).sort()).toEqual(["closed", "sent", "stopping", "turn"]);
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
    const named = [...source("src/machines/tool.ts").matchAll(/args\.action === "(\w+)"/g)].map((match) => match[1] ?? "");
    const actions: readonly string[] = MACHINE_ACTIONS;

    expect(named.filter((action) => !actions.includes(action))).toEqual([]);
    expect(actions.filter((action) => !named.includes(action))).toEqual(["send"]);
  });
});

const DATE = 5;

const T = 1_760_000_000_000;

const WINDOW = 75_000;

const DAY = 24 * 60 * 60_000;

const FACTS = {
  os: "darwin",
  chrome: false,
  repos: [],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } },
  ports: [],
  kind: "computer" as const
};

type Port = Machines["Service"];

type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

type Harness = { readonly port: Port; readonly run: Run; readonly world: World; readonly at: (ms: number) => Promise<void> };

async function portWith(test: (harness: Harness) => Promise<void>): Promise<void> {
  const world = new World({ now: () => DATE });

  const host = Layer.succeed(Host)({
    feed: world.feed,
    sockets: world.socketsOf,
    files: world.files,
    tokens: world.tokens,
    creds: world.creds,
    sandboxes: world.sandboxes,
    harness: () => world.harness,
    wanted: () => true,
    cloud: () => undefined,
    recheckAt: (at) => world.effects.host.push({ recheckAt: at }),
    changed: () => world.effects.host.push("changed"),
    retryMs: () => 1_000
  });

  const runtime = ManagedRuntime.make(Machines.layer.pipe(Layer.provideMerge(Layer.mergeAll(Sql.layer(world.durable.storage()), host, TestClock.layer()))));

  const run: Run = async (effect) => {
    const done = await runtime.runPromise(effect);
    await settle();

    return done;
  };

  try {
    await runtime.runPromise(TestClock.setTime(T));
    await test({ port: await runtime.runPromise(Machines.use(Effect.succeed)), run, world, at: (ms) => runtime.runPromise(TestClock.setTime(ms)) });
  } finally {
    await runtime.dispose();
    world.db.close();
  }
}

const hello = ({ port, run, world }: Harness, connection: string, active: readonly string[] = []) => {
  world.sockets.set(connection, { readyState: 1, tags: [connection] });

  return run(port.onReport("mini", { type: "hello", protocol: PROTOCOL, version: "1", active, facts: FACTS }, connection));
};

const refusalOf = ({ port, run }: Harness, name: string, change: MachineChange) =>
  run(Effect.match(port.configure(name, change), { onFailure: (error) => error.refusal, onSuccess: () => null }));

const property = <Ts extends [unknown, ...unknown[]]>(...args: [...{ [K in keyof Ts]: fc.Arbitrary<Ts[K]> }, (...values: Ts) => Promise<void>]) =>
  fc.assert(fc.asyncProperty(...args), { numRuns: budget().numRuns, seed: budget().seed });

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DATE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
});

describe("the port's refusals", () => {
  it("refuses a change to a machine ky doesn't list, in B's words", () =>
    property(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), async (name) => {
      await portWith(async (harness) => {
        expect(await refusalOf(harness, name, { state: "on" })).toBe(`No machine ${name}.`);
      });
    }));

  it("takes a state only of on, paused or off, and refuses any other in B's words", () =>
    property(fc.oneof(fc.constantFrom("on", "paused", "off"), fc.string()), async (state) => {
      await portWith(async (harness) => {
        const { port, run } = harness;
        await run(port.paired("mini", FACTS, "p1"));
        // SAFETY: a caller past the tool's schema can send any state.
        const refusal = await refusalOf(harness, "mini", { state: state as "on" });
        const valid = ["on", "paused", "off"].includes(state);

        expect(refusal).toBe(valid ? null : `A machine is on, paused or off, not ${JSON.stringify(state)}.`);
        expect((await run(port.machine("mini")))?.state).toBe(valid ? state : "on");
      });
    }));

  it("takes a login only of own or ky, and refuses any other in B's words", () =>
    property(fc.oneof(fc.constantFrom("own", "ky"), fc.string()), async (login) => {
      await portWith(async (harness) => {
        const { port, run } = harness;
        await run(port.paired("mini", FACTS, "p1"));
        // SAFETY: as the state.
        const refusal = await refusalOf(harness, "mini", { login: login as "own" });
        const valid = ["own", "ky"].includes(login);

        expect(refusal).toBe(valid ? null : `A machine's tasks sign in with its own login or ky's, not ${JSON.stringify(login)}.`);
        expect((await run(port.machine("mini")))?.login).toBe(valid ? login : "own");
      });
    }));

  it("lets a runner's socket be the machine's only with its live pairing", () =>
    property(fc.constantFrom("p1", "p2"), fc.option(fc.constantFrom("p1", "p2", ""), { nil: undefined }), async (live, offered) => {
      await portWith(async (harness) => {
        const { port, run } = harness;
        await run(port.paired("mini", FACTS, "p0"));
        await run(port.paired("mini", FACTS, live));

        expect(await run(port.pairedAs("mini", offered))).toBe(offered === live);
        await run(port.remove("mini"));
        expect(await run(port.pairedAs("mini", offered))).toBe(false);
      });
    }));
});

describe("the port's time is the Clock's", () => {
  const since = fc.oneof(fc.integer({ min: 0, max: 3 * WINDOW }), fc.constantFrom(WINDOW - 1, WINDOW, WINDOW + 1));

  it("shows a machine online for ONLINE_WITHIN_MS after its hello, and not a millisecond longer", () =>
    property(since, async (after) => {
      await portWith(async (harness) => {
        const { port, run, at } = harness;
        await run(port.paired("mini", FACTS, "p1"));
        await hello(harness, "c1");
        await at(T + after);

        expect(await run(port.online("mini"))).toBe(after <= WINDOW);
      });
    }));

  it("tells the watchers when a machine with an open socket has been silent past the window", () =>
    property(since, async (after) => {
      await portWith(async (harness) => {
        const { port, run, world, at } = harness;
        await run(port.paired("mini", FACTS, "p1"));
        await hello(harness, "c1");
        await at(T + after);
        const before = world.effects.host.length;
        await run(port.recheck);

        expect(world.effects.host.slice(before)).toEqual(after > WINDOW ? ["changed"] : []);
      });
    }));

  it("stores a hello's time and books the look after it by the Clock", () =>
    property(fc.integer({ min: 0, max: DAY }), async (after) => {
      await portWith(async (harness) => {
        const { port, run, world, at } = harness;
        await run(port.paired("mini", FACTS, "p1"));
        await at(T + after);
        await hello(harness, "c1");

        expect(world.rows("SELECT seen_at FROM ky_machines")).toEqual([{ seen_at: T + after }]);
        expect(world.effects.host).toContainEqual({ recheckAt: T + after + WINDOW + 1_000 });
      });
    }));

  it("stores when a runner was last seen by the Clock", () =>
    property(fc.integer({ min: 0, max: DAY }), async (after) => {
      await portWith(async (harness) => {
        const { port, run, at } = harness;
        await run(port.paired("mini", FACTS, "p1"));
        await at(T + after);
        await run(port.seen("mini", 1000));

        expect((await run(port.machine("mini")))?.seenAt).toBe(T + after);
      });
    }));

  it("stores when a machine paired by the Clock", () =>
    property(fc.integer({ min: 0, max: DAY }), async (after) => {
      await portWith(async (harness) => {
        const { port, run, at } = harness;
        await at(T + after);
        await run(port.paired("mini", FACTS, "p1"));

        expect((await run(port.machine("mini")))?.seenAt).toBe(T + after);
      });
    }));

  it("lists a sandbox from the Clock's time", () =>
    property(fc.integer({ min: 0, max: DAY }), async (after) => {
      await portWith(async (harness) => {
        const { port, run, at } = harness;
        await at(T + after);
        await run(port.listSandboxes);

        expect((await run(port.machine("cloud")))?.seenAt).toBe(T + after);
      });
    }));

  it("sweeps the token of a task that ended within ISSUED_TTL_MS by the Clock", () =>
    property(fc.oneof(fc.integer({ min: 0, max: 2 * DAY }), fc.constantFrom(DAY - 1, DAY, DAY + 1)), async (after) => {
      await portWith(async (harness) => {
        const { port, run, world, at } = harness;
        vi.setSystemTime(T);
        await run(port.paired("mini", FACTS, "p1"));
        await run(port.start("mini", "A task", "Do it", "t1", "s1", "chat", "claude"));
        // SAFETY: start made the task.
        await run(port.stop(world.feed.get("t1")!));
        await at(T + after);
        await run(port.sweepTokens);
        vi.setSystemTime(DATE);

        expect(world.effects.vault.at(-1)).toEqual({ revokeAll: after <= DAY ? ["t1"] : [] });
      });
    }));
});

type Step =
  | { readonly do: "start"; readonly task: string; readonly parent: string; readonly agent: "claude" | "codex" }
  | { readonly do: "send" | "stop"; readonly task: string; readonly parent: string }
  | { readonly do: "hello" | "close" }
  | { readonly do: "ack"; readonly pick: number }
  | { readonly do: "result"; readonly task: string; readonly ok: boolean }
  | { readonly do: "late"; readonly task: string; readonly kind: "result" | "session" | "step" }
  | { readonly do: "login"; readonly login: "own" | "ky" }
  | { readonly do: "tick"; readonly ms: number };

const task = fc.constantFrom("t1", "t2", "t3");

const steps: fc.Arbitrary<Step[]> = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: fc.record({ do: fc.constant("start" as const), task, parent: fc.constantFrom("s1", "s2"), agent: fc.constantFrom("claude" as const, "codex" as const) }) },
    { weight: 2, arbitrary: fc.record({ do: fc.constantFrom("send" as const, "stop" as const), task, parent: fc.constantFrom("s1", "s2") }) },
    { weight: 3, arbitrary: fc.record({ do: fc.constantFrom("hello" as const, "close" as const) }) },
    { weight: 4, arbitrary: fc.record({ do: fc.constant("ack" as const), pick: fc.nat(8) }) },
    { weight: 3, arbitrary: fc.record({ do: fc.constant("result" as const), task, ok: fc.boolean() }) },
    { weight: 2, arbitrary: fc.record({ do: fc.constant("late" as const), task, kind: fc.constantFrom("result" as const, "session" as const, "step" as const) }) },
    { weight: 1, arbitrary: fc.record({ do: fc.constant("login" as const), login: fc.constantFrom("own" as const, "ky" as const) }) },
    { weight: 1, arbitrary: fc.record({ do: fc.constant("tick" as const), ms: fc.constantFrom(1_000, 60_000) }) }
  ),
  { maxLength: budget().maxCommands }
);

type Runner = { readonly ran: number[]; readonly acked: Set<number>; readonly resent: number[]; readonly lateChanged: string[] };

async function drive(harness: Harness, run: readonly Step[]): Promise<Runner> {
  const { port, world } = harness;
  const runner: Runner = { ran: [], acked: new Set(), resent: [], lateChanged: [] };
  let connections = 0;
  let read = 0;

  const observe = () => {
    for (const effect of world.effects.runner.slice(read)) {
      // SAFETY: the world records each frame as its connection and the command sent.
      const { command } = effect as { command: { seq: number } };

      if (runner.acked.has(command.seq)) runner.resent.push(command.seq);
      else if (!runner.ran.includes(command.seq)) runner.ran.push(command.seq);
    }

    read = world.effects.runner.length;
  };

  await harness.run(port.paired("mini", FACTS, "p1"));

  for (const step of run) {
    const row = "task" in step ? world.feed.get(step.task) : undefined;
    const turns = "task" in step ? world.rows("SELECT turn, closed FROM ky_machine_turns WHERE task = ?", step.task)[0] : undefined;

    switch (step.do) {
      case "start":
        await harness.run(port.start("mini", "A task", "Do it", step.task, step.parent, "chat", step.agent));
        await harness.run(port.deliver("mini"));
        break;
      case "send":
        if (row) {
          await harness.run(port.send(row, "More", step.parent));
          await harness.run(port.deliver("mini"));
        }

        break;
      case "stop":
        if (row) await harness.run(port.stop(row));
        break;
      case "hello":
        for (const socket of world.sockets.values()) socket.readyState = 3;
        connections += 1;
        await hello(harness, `c${connections}`, world.feed.open("machine", "mini").map((open) => open.id));
        break;
      case "close":
        for (const socket of world.sockets.values()) socket.readyState = 3;
        await harness.run(port.seen("mini", 1006));
        break;
      case "ack": {
        const unacked = runner.ran.filter((seq) => !runner.acked.has(seq));
        const seq = unacked[step.pick % Math.max(unacked.length, 1)];

        if (seq !== undefined) {
          runner.acked.add(seq);
          await harness.run(port.onReport("mini", { type: "ack", seq }, `c${connections}`));
        }

        break;
      }

      case "result":
        if (turns) await harness.run(port.onReport("mini", { type: "result", task: step.task, turn: Number(turns.turn), ok: step.ok, text: "Ended.", session: "r1", agent: "claude" }, `c${connections}`));
        break;
      case "late":
        if (turns && Number(turns.closed) > 0) {
          const before = JSON.stringify([world.rows("SELECT * FROM ky_tasks WHERE id = ?", step.task), world.rows("SELECT * FROM ky_task_steps"), world.effects.pi]);
          const turn = Number(turns.closed);

          const late: TaskReport =
            step.kind === "result"
              ? { type: "result", task: step.task, turn, ok: true, text: "Late.", session: "r9", agent: "claude", turns: 3, costUsd: 1 }
              : step.kind === "session"
                ? { type: "session", task: step.task, turn, session: "r9" }
                : { type: "step", task: step.task, turn, text: "Late step" };

          await harness.run(port.onReport("mini", late, `c${connections}`));
          const after = JSON.stringify([world.rows("SELECT * FROM ky_tasks WHERE id = ?", step.task), world.rows("SELECT * FROM ky_task_steps"), world.effects.pi]);

          if (after !== before) runner.lateChanged.push(`${step.kind} for ${step.task} turn ${turn}`);
        }

        break;
      case "login":
        await harness.run(port.configure("mini", { login: step.login }));
        break;
      case "tick":
        await harness.at(T + step.ms);
        break;
    }

    observe();
  }

  return runner;
}

describe("the port's inbox and tokens", () => {
  it("runs each command once, in the order it was queued, and never sends one the runner acked", () =>
    property(steps, async (run) => {
      await portWith(async (harness) => {
        const runner = await drive(harness, run);

        expect(runner.resent).toEqual([]);
        expect(runner.ran).toEqual([...runner.ran].sort((a, b) => a - b));
      });
    }));

  it("drops what a runner says about a turn already reported over", () =>
    property(steps, async (run) => {
      await portWith(async (harness) => {
        expect((await drive(harness, run)).lateChanged).toEqual([]);
      });
    }));

  it("revokes a task's token once no turn of it is left to run", () =>
    property(steps, async (run) => {
      await portWith(async (harness) => {
        const { world } = harness;
        await drive(harness, run);

        for (const { task, turn, closed } of world.rows("SELECT task, turn, closed FROM ky_machine_turns")) {
          const queued = world.rows("SELECT 1 FROM ky_machine_inbox WHERE json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.task') = ?", String(task));
          // SAFETY: the vault's effects are each one call, keyed by its name.
          const calls = world.effects.vault.filter((call) => Object.values(call as object).includes(task)).map((call) => Object.keys(call as object)[0]);

          if (Number(closed) >= Number(turn) && queued.length === 0 && calls.includes("issue")) expect(calls.at(-1)).toBe("revoke");
        }
      });
    }));
});

const Int = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Text = Schema.String;

const STORED = {
  ky_machines: Schema.Struct({
    name: Text,
    seen_at: Int,
    state: Schema.Literals(["on", "paused", "off"]),
    note: Text.check(Schema.isMaxLength(200)),
    facts: Schema.NullOr(Schema.fromJsonString(Schema.Struct({ kind: Schema.Literals(["computer", "cloud"]) }))),
    pairing: Schema.NullOr(Text),
    login: Schema.Literals(["own", "ky"]),
    hello: Schema.NullOr(Text),
    reason: Schema.NullOr(Text),
    turns_ended: Int
  }),
  ky_machine_inbox: Schema.Struct({
    seq: Int,
    machine: Text,
    payload: Schema.fromJsonString(Schema.Struct({ type: Schema.Literals(["run", "stop", "creds"]), task: Text })),
    sent: Schema.Literals([0, 1])
  }),
  ky_machine_turns: Schema.Struct({ task: Text, turn: Int, closed: Int, sent: Int, stopping: Int }),
  ky_machine_senders: Schema.Struct({ task: Text, turn: Int, session: Text }),
  ky_machine_logins: Schema.Struct({ task: Text, expires_at: Int }),
  ky_machine_reports: Schema.Struct({ task: Text, turn: Int, session: Text, text: Text })
};

describe("the port's stored rows", () => {
  const stored = async (run: readonly Step[]) => {
    let rows: { [K in keyof typeof STORED]: (typeof STORED)[K]["Type"][] } | undefined;
    let ran: readonly number[] = [];

    await portWith(async (harness) => {
      ran = (await drive(harness, run)).ran;
      // SAFETY: each table is decoded by its own oracle just below.
      rows = Object.fromEntries(Object.entries(STORED).map(([table, row]) => [table, harness.world.rows(`SELECT * FROM ${table}`).map((each) => Schema.decodeUnknownSync(row as Schema.Codec<unknown, unknown>)(each))])) as typeof rows;
    });

    // SAFETY: portWith ran the test, which set them.
    return { ...rows!, ran };
  };

  it("keeps each machine as B's columns hold it, its turns ended counted once per close", () =>
    property(steps, async (run) => {
      const { ky_machines, ky_machine_turns } = await stored(run);
      const closes = ky_machine_turns.filter((row) => row.closed > 0).length;

      expect(ky_machines.map((row) => row.name)).toEqual(["mini"]);
      expect(ky_machines[0]?.pairing).toBe("p1");
      expect(ky_machines[0]?.turns_ended).toBeGreaterThanOrEqual(closes);
      expect(ky_machines[0]?.turns_ended).toBeLessThanOrEqual(ky_machine_turns.reduce((sum, row) => sum + row.closed, 0));
    }));

  it("marks a command sent exactly when it went out on the hello socket", () =>
    property(steps, async (run) => {
      const { ky_machine_inbox, ran } = await stored(run);

      for (const row of ky_machine_inbox) expect([row.seq, row.sent]).toEqual([row.seq, ran.includes(row.seq) ? 1 : 0]);
    }));

  it("keeps each task's turns in order: closed, sent and stopping at most its latest", () =>
    property(steps, async (run) => {
      for (const row of (await stored(run)).ky_machine_turns) {
        expect(Math.max(row.closed, row.sent, row.stopping)).toBeLessThanOrEqual(row.turn);
      }
    }));

  it("keeps who sent each turn of a task, and only its turns", () =>
    property(steps, async (run) => {
      const { ky_machine_turns, ky_machine_senders } = await stored(run);

      for (const { task, turn } of ky_machine_turns) {
        expect(ky_machine_senders.filter((row) => row.task === task).map((row) => row.turn).sort((a, b) => a - b)).toEqual(Array.from({ length: turn }, (_, at) => at + 1));
      }
    }));

  it("keeps a handed login only while its task has a turn to run, at the expiry it was sent", () =>
    property(steps, async (run) => {
      const { ky_machine_turns, ky_machine_logins } = await stored(run);

      for (const login of ky_machine_logins) {
        const turns = ky_machine_turns.find((row) => row.task === login.task);

        expect(login.expires_at).toBe(1_000);
        expect(turns && turns.closed < turns.turn).toBe(true);
      }
    }));

  it("forgets a report once its conversation has it", () =>
    property(steps, async (run) => {
      expect((await stored(run)).ky_machine_reports).toEqual([]);
    }));
});
