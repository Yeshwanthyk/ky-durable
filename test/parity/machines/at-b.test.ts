import * as Schema from "effect/Schema";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskFeed } from "../../../src/automations/tasks";
import { FileStore } from "../../../src/files";
import * as B from "../../../src/machines/legacy/runner-protocol";
import type { Harness } from "../../../src/machines/machines";
import * as Port from "../../../src/machines/runner-protocol";
import { MachineHub } from "../../../src/machines/wiring";
import { Sandboxes } from "../../../src/sandboxes";
import { assertParity, budget } from "../kit";
import { FRAMES, PAIRS, REPORTS, texts } from "./wire";
import { actions, advances, legacy, next, settle, storageOf } from "./world";

const StoredRow = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number])));

const AtB = Schema.fromJsonString(Schema.Struct({ schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown }));

const atB = Schema.decodeUnknownSync(AtB)(readFileSync(new URL("at-b.json", import.meta.url), "utf8"));

const T = 1_760_000_000_000;

const MINI = {
  os: "darwin",
  chrome: true,
  repos: [{ name: "api", remote: "https://github.com/acme/api.git" }],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } },
  ports: [3000],
  kind: "computer" as const
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
});

describe("machines parity with B", () => {
  it("the port answers, stores and sends as B did", async () => {
    await assertParity({ domain: "machines", actions, advances, legacy, next, start: 1_760_000_000_000 });
  }, 600_000);
});

describe("machine rows written at B", () => {
  it("open under the port, read as B read them, and deliver and post what B owed", async () => {
    vi.setSystemTime(T + 70_000);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema.filter((each) => !each.includes("sqlite_sequence"))) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const { storage, sql } = storageOf(db);
    const feed = new TaskFeed(sql());
    const files = new FileStore(sql());
    const sandboxes = new Sandboxes(sql());
    const sent: Schema.Json[] = [];
    const posted: Schema.Json[] = [];

    const sockets = (tag: string) => {
      if (tag !== "c2") return [];

      const send = (text: string) => {
        sent.push(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text));
      };

      // SAFETY: the hub reads readyState and calls send; nothing else of a socket.
      return [{ readyState: 1, send } as WebSocket];
    };

    const tokens = { issue: async (task: string) => `tok-${task}`, revoke: async () => {}, revokeAll: async () => {} };

    const creds = async (agent: "claude" | "codex") =>
      agent === "codex" ? { codex: { accessToken: "at", refreshToken: null, idToken: "it", accountId: "acct", expiresAt: T + 3_600_000 } } : { claude: { oauthToken: "oauth" } };

    const harness: Harness = {
      submit: async (input, options = {}) => {
        posted.push({ text: Schema.decodeUnknownSync(Schema.String)(input), options: { session: options.session ?? null, operationId: options.operationId ?? null, whenBusy: options.whenBusy ?? null } });

        return { operationId: options.operationId ?? "", session: options.session ?? "", accepted: true };
      }
    };

    const hub = new MachineHub(storage(), feed, sockets, files, tokens, creds, sandboxes);
    const names = ["mini", "box", "old", "restored", "cloud", "lab", "none"];

    const reads = {
      machines: hub.machines(),
      machine: names.map((name) => hub.machine(name) ?? null),
      online: names.map((name) => hub.online(name)),
      busy: names.map((name) => hub.busy(name)),
      turnsEnded: names.map((name) => hub.turnsEnded(name)),
      defaultAgent: names.map((name) => hub.defaultAgent(name)),
      pairedAs: [hub.pairedAs("mini", "p1"), hub.pairedAs("box", "p2"), hub.pairedAs("box", "p1"), hub.pairedAs("old", "p3"), hub.pairedAs("restored", undefined)],
      sandboxFor: ["acme/api", "acme/web"].map((repo) => hub.sandboxFor(repo) ?? null),
      cloudOn: hub.cloudOn() ?? null
    };

    hub.attach(harness, () => true);
    await hub.onReport("mini", { type: "hello", protocol: 4, version: "1.0.0", active: ["t1"], facts: MINI }, "c2");
    await settle();
    await hub.post();
    await settle();

    const owed = { sent, posted, onlineAfter: names.map((name) => hub.online(name)), busyAfter: names.map((name) => hub.busy(name)) };

    expect(JSON.stringify({ ...reads, ...owed }, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});

describe("the runner's wire, read as B read it", () => {
  const runs = { numRuns: budget().numRuns * 20, seed: budget().seed };

  it("takes, refuses and reads a runner's report as B did", () => {
    fc.assert(
      fc.property(texts(REPORTS), ({ text }) => {
        const was = B.decodeReport(text);
        const is = Port.decodeReport(text);

        expect(is.kind).toBe(was.kind);
        expect(was).toMatchObject(is);
      }),
      runs
    );
  });

  it("takes, refuses and reads the object's frame as B did", () => {
    fc.assert(
      fc.property(texts(FRAMES), ({ text }) => {
        const was = B.decodeObjectFrame(text);
        const is = Port.decodeObjectFrame(text);

        expect(is === undefined).toBe(was === undefined);

        if (was && is) expect(was).toMatchObject(is);
      }),
      runs
    );
  });

  it("takes a pairing request, its facts and its name as B did", () => {
    fc.assert(
      fc.property(texts(PAIRS), fc.oneof(fc.string(), fc.stringMatching(/^[a-z0-9-]{0,34}$/u)), ({ value }, name) => {
        expect(Port.isPairRequest(value)).toBe(B.isPairRequest(value));
        expect(Port.isMachineFacts(value)).toBe(B.isMachineFacts(value));
        expect(Port.isMachineFacts(B.isPairRequest(value) ? value.facts : value)).toBe(B.isMachineFacts(B.isPairRequest(value) ? value.facts : value));
        expect(Port.isMachineName(name)).toBe(B.isMachineName(name));
      }),
      runs
    );
  });
});
