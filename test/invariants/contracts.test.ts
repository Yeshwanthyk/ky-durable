import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Asks } from "../../src/asks";
import { automationRows, CHECK_IN_TOOLS, AUTOMATION_TABLES, taskRows } from "../../src/automations/contract";
import { ClientMessageSchema, refusedFrame } from "../../src/client-messages";
import { DREAM_MEMORY_TOOLS, DREAMING_TABLES, markOf, MEMORY_WRITE_TOOLS } from "../../src/dreaming/contract";
import { MACHINE_TABLES } from "../../src/machines/contract";
import { PEER_TOOLS, PEERS_TABLES } from "../../src/peers/contract";
import type { ServerMessage } from "../../src/protocol";
import { ServerFrameSchema, type ServerFrame } from "../../src/server-frames";
import { REVIEW_ALLOWED, SKILL_TABLES, specialistOf, TOOLS } from "../../src/skills/contract";
import { restores } from "../../src/tables";

/**
 * The gate's cross-cutting promises: the socket's two edges, what storage survives, and the tool
 * allowlists. The worker tests drive the same edges end to end (src/tests/sockets.test.ts,
 * src/tests/backup.test.ts); these hold the shape of each, without a Worker.
 */
const SRC = path.join(import.meta.dirname, "../../src");

const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");

/** Every .ts file under src, relative to it, tests left out. */
function sources(dir = ""): string[] {
  return readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "tests" ? [] : sources(at);

    return /\.tsx?$/.test(entry.name) ? [at] : [];
  });
}

/** The keys of the object literal that starts after `opening` in `text`: one level deep, as `name:` or `"name":`. */
function keysAfter(text: string, opening: string): string[] {
  const start = text.indexOf(opening);
  expect(start, opening).toBeGreaterThan(-1);
  const keys: string[] = [];
  let depth = 0;

  for (const line of text.slice(start + opening.length).split("\n")) {
    if (depth === 0) {
      const key = /^\s*(?:"([a-z-]+)"|([a-z][A-Za-z]*)):/.exec(line);

      if (key) keys.push(key[1] ?? key[2] ?? "");
    }

    depth += (line.match(/[{([]/g) ?? []).length - (line.match(/[})\]]/g) ?? []).length;

    if (depth < 0) break;
  }

  return keys;
}

/** Each variant's `type` literal, in order. */
const typesOf = (schema: { anyOf: readonly { properties: { type: { const: string } } }[] }) => schema.anyOf.map((variant) => variant.properties.type.const);

// Type-level: the page's frame schemas and the server's frame type name the same types, both ways.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const FRAMES_MATCH: Same<ServerFrame["type"], ServerMessage["type"]> = true;

describe("the socket edge", () => {
  it("gives every client message type a schema and a handler", () => {
    const types = typesOf(ClientMessageSchema);

    expect(new Set(types).size).toBe(types.length);
    expect(keysAfter(read("sockets.ts"), "readonly #handlers: Handlers = {").sort()).toEqual([...types].sort());
    // The schema is the edge: what passes is a message, what doesn't isn't.
    expect(Value.Check(ClientMessageSchema, { type: "rename-chat", id: "1", session: "s", title: "t" })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { type: "rename-chat", id: "1", session: 7, title: "t" })).toBe(false);
    expect(Value.Check(ClientMessageSchema, null)).toBe(false);
  });

  it("answers a message type it doesn't know with an error frame, not a close", () => {
    expect(refusedFrame("null")).toEqual({ type: "error", message: "ky can't read that message." });
    expect(refusedFrame("{")).toEqual({ type: "error", message: "ky can't read that message." });
    const future = refusedFrame(JSON.stringify({ type: "from-the-future", id: "a1" }));

    expect(future).toMatchObject({ type: "error", id: "a1" });
    expect(future.type === "error" && future.message).toContain("from-the-future");

    // The socket edge decodes once, answers a frame that fails with refusedFrame, and never closes for it.
    const sockets = read("sockets.ts");
    const onMessage = sockets.slice(sockets.indexOf("async #onMessage("), sockets.indexOf("#handle<"));
    expect(onMessage).toContain("parseOr(ClientMessageSchema, raw, undefined)");
    expect(onMessage).toContain("send(connection, refusedFrame(raw))");
    expect(onMessage).not.toMatch(/\.close\(|JSON\.parse| as PiClientMessage/);
  });

  it("handles every server message type in the client", () => {
    expect(FRAMES_MATCH).toBe(true);
    const types = typesOf(ServerFrameSchema);

    expect(new Set(types).size).toBe(types.length);
    const page = read("use-pi-session.ts");
    const handled = keysAfter(page.slice(page.indexOf("function frameHandlers(")), "return {");
    expect(handled.sort()).toEqual([...types].sort());
  });

  describe("asks", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("settles every ask on its answer, an error frame, the socket closing or a timeout", async () => {
      vi.useFakeTimers();
      const asks = new Asks(1_000);

      const answered = asks.wait("new-chat", "a");
      asks.answer("a", { session: "s1" });
      await expect(answered).resolves.toEqual({ session: "s1" });

      // An answer that isn't the ask's shape is a failure, not a cast.
      const wrong = asks.wait("new-chat", "b");
      asks.answer("b", { nope: true });
      await expect(wrong).rejects.toThrow(/new-chat/);

      const refused = asks.wait("set-repo", "c");
      asks.fail("c", "No such repo");
      await expect(refused).rejects.toThrow("No such repo");

      const first = asks.wait("peer-list", "d");
      const second = asks.wait("soul-history", "e");
      asks.close();
      await expect(first).rejects.toThrow(/closed/);
      await expect(second).rejects.toThrow(/closed/);

      const slow = asks.wait("withdraw", "f");
      const late = expect(slow).rejects.toThrow(/didn't answer/);
      await vi.advanceTimersByTimeAsync(1_000);
      await late;

      expect(asks.size).toBe(0);
      // A fire-and-forget command's result has no ask: nothing to settle, nothing thrown.
      asks.answer("none", null);
    });
  });
});

describe("storage", () => {
  it("decodes a corrupt JSON column from a restore to its default", () => {
    const specialist = { id: "eng", description: "Engineer", model: "{broken", machine: null, session: null, created_at: 1 };
    expect(specialistOf(specialist).model).toBeNull();
    expect(specialistOf({ ...specialist, model: JSON.stringify({ provider: "p", modelId: "m", thinkingLevel: "loud" }) }).model).toBeNull();

    const automation = {
      id: "a1", title: "T", prompt: "P", cron: null, at: 1, model: "{broken", machine: null, chat: "main",
      gate: null, gate_checked_at: null, gate_note: null, gate_errors: 0, watch: null,
      created_by: "user", status: "active", schedule_id: null, created_at: 1, updated_at: 1
    };

    expect(automationRows([automation])[0]?.model).toBeNull();

    const task = {
      id: "t1", kind: "machine", source: "chat", worker: "laptop", title: "T", status: "done", summary: "", steps: "[{",
      session: null, agent: null, chat: null, created_at: 1, updated_at: 1, started_at: null, finished_at: null, turns: null, cost_usd: null
    };

    expect(taskRows([task])[0]?.steps).toEqual([]);
    expect(markOf({ memories: "lots", at: 1 })).toEqual(markOf(undefined));
  });

  it("restores only tables a contract names, round-tripping a corrupt cell", () => {
    for (const table of [...Object.values(DREAMING_TABLES), ...Object.values(PEERS_TABLES), ...Object.values(SKILL_TABLES), ...Object.values(AUTOMATION_TABLES)]) {
      expect(restores(table), table).toBe(true);
    }

    for (const table of ["pi_entries", "vfs_nodes", "_vfs_mounts", "ky_chats", "ky_purposes"]) expect(restores(table), table).toBe(true);

    // Pairings are the deploy's; a stray or retired table, or a restore's own, is left out.
    for (const table of [...Object.values(MACHINE_TABLES), "ky_stray", "ky_settings", "ky_restore__memo_log", "sqlite_sequence"]) {
      expect(restores(table), table).toBe(false);
    }

    // begin stages only what `restores` takes, and stage drops the rows of the rest; the corrupt cell's round trip is
    // src/tests/backup.test.ts's "restores only the tables ky names".
    const backup = read("backup.ts");
    expect(backup).toContain("manifest.tables.filter((table) => restores(table.name))");
    expect(backup).toContain("if (!dump && !restores(table))");
  });

  it("migrates idempotently and never drops a table on start", () => {
    for (const file of sources()) {
      // backup.ts makes and drops its own staging tables, and replays an archive's CREATE statements.
      if (file === "backup.ts") continue;
      const text = read(file);

      expect(text, file).not.toMatch(/DROP\s+(TABLE|INDEX)/i);

      for (const [statement] of text.matchAll(/CREATE\s+(?:UNIQUE\s+|VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER)\b[^(]*/gi)) {
        // A doc comment's mention isn't a statement.
        if (/^CREATE TABLE statement|^CREATE INDEX statements/i.test(statement)) continue;
        expect(statement, file).toMatch(/IF NOT EXISTS/i);
      }
    }
  });
});

describe("domains", () => {
  /** Every tool ky registers: each `defineTool({ name })`, its name a literal or a constant resolved from the source. */
  function registered(): Set<string> {
    const texts = sources().map(read);
    const constants = new Map(texts.flatMap((text) => [...text.matchAll(/const ([A-Z_]+) = "([a-z_]+)"/g)].map(([, name = "", value = ""]) => [name, value] as const)));
    const names = new Set<string>();

    for (const text of texts) {
      for (const [, expression = ""] of text.matchAll(/defineTool\(\{\s*name: ([^,\n]+),/g)) {
        const literal = /^"([a-z_]+)"$/.exec(expression)?.[1];
        const tool = /^TOOLS\.(\w+)$/.exec(expression)?.[1];
        const name = literal ?? (tool === undefined ? constants.get(expression) : Object.entries(TOOLS).find(([key]) => key === tool)?.[1]);

        expect(name, `a tool named ${expression}`).toBeDefined();
        names.add(name ?? "");
      }
    }

    return names;
  }

  it("allows only registered tools in each allowlist", () => {
    const tools = registered();

    const allowlists = {
      MEMORY_WRITE_TOOLS,
      DREAM_MEMORY_TOOLS,
      PEER_TOOLS,
      CHECK_IN_TOOLS,
      "REVIEW_ALLOWED.review": REVIEW_ALLOWED.review,
      "REVIEW_ALLOWED.dream": REVIEW_ALLOWED.dream
    } satisfies Record<string, readonly string[]>;

    expect(tools.size).toBeGreaterThan(10);

    for (const [list, names] of Object.entries<readonly string[]>(allowlists)) {
      expect(names.filter((name) => !tools.has(name)), list).toEqual([]);
    }
  });
});
