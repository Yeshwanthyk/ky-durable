import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatList } from "../../src/chats/chats";
import { chatsExtension } from "../../src/chats/tool";
import { budget, type Json } from "../parity/kit";
import { storageOf, StoredRow } from "../parity/skills/storage";

const START = Date.UTC(2026, 0, 1);

const ROOT = "1";

const NOT_A_CHAT_SESSION = "7";

const SESSIONS = [ROOT, "2", "3", NOT_A_CHAT_SESSION, "20", "21", "22"] as const;

const TEXTS = ["", "   ", "gate", "  Plan the trip  \nthen book it", "\n\nsecond line first", "x".repeat(59), "y".repeat(61), "Yesterday's top stories."] as const;

const LONG_SAID = "z".repeat(16_001);

type Opener = { readonly by: string; readonly request: string };

type ToolArgs = { readonly action: "create" | "steer" | "inspect"; readonly chat?: string; readonly message?: string; readonly title?: string };

type ListAction =
  | { readonly op: "add"; readonly session: string; readonly opener?: Opener }
  | { readonly op: "touch"; readonly session: string; readonly text: string }
  | { readonly op: "answered"; readonly session: string }
  | { readonly op: "retitle"; readonly session: string; readonly was: string; readonly title: string }
  | { readonly op: "rename"; readonly session: string; readonly title: string }
  | { readonly op: "archive"; readonly session: string; readonly archived: boolean };

const aSession = fc.constantFrom(...SESSIONS);

const aText = fc.constantFrom(...TEXTS);

const anOpener = fc.record({ by: aSession, request: fc.constantFrom("chat-create:1:7", "chat-create:2:1", "chat-create:1:8") });

const someArgs: fc.Arbitrary<ToolArgs> = fc.record(
  { action: fc.constantFrom("create" as const, "steer" as const, "inspect" as const), chat: aSession, message: aText, title: aText },
  { requiredKeys: ["action"] }
);

const listActions: fc.Arbitrary<ListAction> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant("add" as const), session: aSession, opener: anOpener }, { requiredKeys: ["op", "session"] }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("touch" as const), session: aSession, text: aText }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("answered" as const), session: aSession }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("retitle" as const), session: aSession, was: aText, title: aText }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("rename" as const), session: aSession, title: aText }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("archive" as const), session: aSession, archived: fc.boolean() }) }
);

type Seen = { changes: number; readonly named: Json[]; readonly steers: Json[]; readonly opened: Json[] };

const Rows = Schema.Array(StoredRow);

function tablesOf(db: DatabaseSync): Json {
  const read = (query: string) => Schema.decodeUnknownSync(Rows)(db.prepare(query).all().map((row) => ({ ...row })));

  return { ky_chats: [...read("SELECT * FROM ky_chats ORDER BY session")], ky_main_chat: [...read("SELECT * FROM ky_main_chat")] };
}

function partsFor(chats: ChatList, seen: Seen) {
  let next = 20;

  return {
    chats,
    openedFor: (request: string) => chats.openedFor(request),
    openedBy: (session: string) => chats.openedBy(session),
    open: async (opener: Opener) => {
      const session = String(next++);
      chats.add(session, opener);
      seen.opened.push([session, opener.by, opener.request]);

      return session;
    },
    steer: async (session: string, content: string, requestId: string) => void seen.steers.push([session, content, requestId]),
    busy: async (session: string) => Number(session) % 2 === 0,
    latest: (session: string) => (session === "3" ? null : session === "21" ? LONG_SAID : `said in ${session}`),
    chat: (session: string) => session !== NOT_A_CHAT_SESSION
  };
}

const ToolReply = Schema.Struct({ output: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })), isError: Schema.optional(Schema.Boolean) });

async function runTool(extension: Extension, from: string, task: number, args: ToolArgs) {
  const tool = extension.tools?.[0];

  if (!tool) throw new Error("the chats extension has no tool");
  // SAFETY: the chats tool reads the calling conversation and the call's task, nothing else of the api.
  const api = { conversationId: Number(from), taskId: task, callId: "call-1" } as ToolExecutionApi;
  const result = Schema.decodeUnknownSync(ToolReply)(await tool.execute(args, api, BACKGROUND_CONTEXT));

  return { text: result.output.map((part) => part.text ?? "").join(""), failed: result.isError === true };
}

function applyToList(chats: ChatList, action: ListAction): void {
  if (action.op === "add") chats.add(action.session, action.opener);
  else if (action.op === "touch") chats.touch(action.session, action.text);
  else if (action.op === "answered") chats.answered(action.session);
  else if (action.op === "retitle") chats.retitle(action.session, action.was, action.title);
  else if (action.op === "rename") chats.rename(action.session, action.title);
  else chats.archive(action.session, action.archived);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function titleFrom(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  const line = lines.find((each) => each.length > 0) ?? "";

  return line.length <= 60 ? line : line.slice(0, 59) + "…";
}

type ModelRow = { session: string; title: string; created_at: number; updated_at: number; archived_at: number | null; opened_by: string | null; opened_request: string | null };

class Model {
  readonly rows = new Map<string, ModelRow>();
  main: number | null = null;
  changes = 0;
  readonly named: Json[] = [];

  apply(action: ListAction, now: number): void {
    if (this.changed(action, this.rows.get(action.session), now)) this.changes++;
  }

  changed(action: ListAction, row: ModelRow | undefined, now: number): boolean {
    switch (action.op) {
      case "add":
        return this.add(action.session, action.opener, now);
      case "touch":
        return this.touch(action.session, action.text, row, now);
      case "answered":
        return this.answered(action.session, row, now);
      case "retitle":
        return this.retitle(row, action.was, action.title);
      case "rename":
        return this.title(row, titleFrom(action.title));
      case "archive":
        return this.archive(row, action.archived, now);
    }
  }

  add(session: string, opener: Opener | undefined, now: number): boolean {
    if (!this.rows.has(session)) this.rows.set(session, { session, title: "", created_at: now, updated_at: now, archived_at: null, opened_by: opener?.by ?? null, opened_request: opener?.request ?? null });

    return true;
  }

  touch(session: string, text: string, row: ModelRow | undefined, now: number): boolean {
    const title = titleFrom(text);

    if (row && row.title === "" && title !== "") this.named.push([session, text]);

    if (row) Object.assign(row, { updated_at: now, title: row.title === "" ? title : row.title });

    return true;
  }

  answered(session: string, row: ModelRow | undefined, now: number): boolean {
    if (session === ROOT) this.main = now;
    else if (row) row.updated_at = now;

    return session === ROOT || row !== undefined;
  }

  retitle(row: ModelRow | undefined, was: string, title: string): boolean {
    const matches = row?.title === was;

    if (row && matches) row.title = title;

    return matches;
  }

  title(row: ModelRow | undefined, title: string): boolean {
    if (row && title !== "") row.title = title;

    return row !== undefined && title !== "";
  }

  archive(row: ModelRow | undefined, archived: boolean, now: number): boolean {
    if (row) row.archived_at = archived ? now : null;

    return row !== undefined;
  }

  tables(): Json {
    const chats = [...this.rows.values()].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));

    return { ky_chats: chats, ky_main_chat: this.main === null ? [] : [{ id: 1, updated_at: this.main }] };
  }
}

describe("the chat list", () => {
  it("stores each chat's session, title, times, archive and opener, and the main chat's last answer, as the model says, at the clock's time", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(listActions, fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 600_000 }))), { maxLength: budget().maxCommands, size: "large" }), (steps) => {
        let at = START;
        vi.spyOn(Date, "now").mockImplementation(() => at);
        const db = new DatabaseSync(":memory:");
        const chats = new ChatList(storageOf(db));
        const model = new Model();
        let changes = 0;
        const named: Json[] = [];
        chats.onChange(() => changes++);
        chats.onNamed((session, text) => void named.push([session, text]));

        for (const [action, advance] of steps) {
          at += advance;
          model.apply(action, at);
          applyToList(chats, action);

          expect(tablesOf(db)).toEqual(model.tables());
          expect(changes).toBe(model.changes);
          expect(named).toEqual(model.named);
          expect(chats.mainUpdatedAt()).toBe(model.main ?? 0);
        }

        db.close();
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

const REFUSED = {
  notAChat: "Only a chat with the user runs other chats.",
  openedByAnother: "Another chat opened this one, so this one runs none: answer here.",
  nothingToStart: "Nothing to start it on: give a message.",
  nothingToSteer: "Nothing to steer it with: give a message.",
  notOpenedHere: (chat: string) => `No chat "${chat}" that this chat opened: inspect lists them.`
};

type Setup = { readonly session: string; readonly by: string | null; readonly archived: boolean };

const aSetup = fc.uniqueArray(fc.record({ session: fc.constantFrom("2", "3", "20", "21", "22"), by: fc.constantFrom(null, ROOT, "2", "3"), archived: fc.boolean() }), { selector: (each) => each.session, maxLength: 5 });

function toolWorld(setup: readonly Setup[]) {
  vi.spyOn(Date, "now").mockImplementation(() => START);
  const db = new DatabaseSync(":memory:");
  const seen: Seen = { changes: 0, named: [], steers: [], opened: [] };
  const chats = new ChatList(storageOf(db));

  for (const { session, by, archived } of setup) {
    chats.add(session, by === null ? undefined : { by, request: `chat-create:${by}:${session}` });
    chats.archive(session, archived);
  }

  const extension = chatsExtension(partsFor(chats, seen));
  const ownedBy = (from: string) => new Set(setup.flatMap((each) => (each.by === from ? [each.session] : [])));
  const openedBy = (session: string) => setup.find((each) => each.session === session)?.by ?? null;

  return {
    seen,
    ownedBy,
    openedBy,
    call: (from: string, args: ToolArgs) => runTool(extension, from, 1, args),
    [Symbol.dispose]: () => {
      db.close();
      vi.restoreAllMocks();
    }
  };
}

const quiet = (seen: Seen) => seen.steers.length === 0 && seen.opened.length === 0;

const aBlank = fc.constantFrom(undefined, "", "   ", "\n\t ");

const runs = () => ({ numRuns: budget().numRuns * 4, seed: budget().seed });

describe("the chats tool", () => {
  it("runs only from a chat with the user: elsewhere it refuses and opens and steers nothing", async () => {
    await fc.assert(
      fc.asyncProperty(aSetup, aSession, someArgs, async (setup, from, args) => {
        using world = toolWorld(setup);
        const said = await world.call(from, args);

        expect(said.text === REFUSED.notAChat).toBe(from === NOT_A_CHAT_SESSION);

        if (from === NOT_A_CHAT_SESSION) expect(said.failed && quiet(world.seen)).toBe(true);
      }),
      runs()
    );
  });

  it("runs from no chat another chat opened: it refuses and opens and steers nothing", async () => {
    await fc.assert(
      fc.asyncProperty(aSetup, aSession.filter((session) => session !== NOT_A_CHAT_SESSION), someArgs, async (setup, from, args) => {
        using world = toolWorld(setup);
        const said = await world.call(from, args);
        const opened = world.openedBy(from) !== null;

        expect(said.text === REFUSED.openedByAnother).toBe(opened);

        if (opened) expect(said.failed && quiet(world.seen)).toBe(true);
      }),
      runs()
    );
  });

  it("creates a chat only with a message that isn't blank", async () => {
    await fc.assert(
      fc.asyncProperty(aSetup, fc.oneof(aBlank, aText), fc.option(aText, { nil: undefined }), async (setup, message, title) => {
        using world = toolWorld(setup);
        const said = await world.call(ROOT, { action: "create", message, title });
        const blank = (message ?? "").trim() === "";

        expect(said.text === REFUSED.nothingToStart).toBe(blank);
        expect(said.failed).toBe(blank);
        expect(world.seen.opened).toHaveLength(blank ? 0 : 1);
      }),
      runs()
    );
  });

  it("steers or inspects only a chat this chat opened", async () => {
    await fc.assert(
      fc.asyncProperty(aSetup, fc.constantFrom(ROOT, "2", "3"), fc.constantFrom("steer" as const, "inspect" as const), fc.option(aSession, { nil: undefined }), aText, async (setup, from, action, chat, message) => {
        using world = toolWorld(setup.filter((each) => each.session !== from || each.by === null));
        const said = await world.call(from, { action, chat, message });
        const refused = (action === "steer" || chat !== undefined) && !world.ownedBy(from).has(chat ?? "");

        expect(said.text === REFUSED.notOpenedHere(chat ?? "")).toBe(refused);

        if (refused) expect(said.failed && quiet(world.seen)).toBe(true);
      }),
      runs()
    );
  });

  it("steers a chat only with a message that isn't blank", async () => {
    await fc.assert(
      fc.asyncProperty(aSetup, fc.oneof(aBlank, aText), async (setup, message) => {
        using world = toolWorld([...setup.filter((each) => each.session !== "22"), { session: "22", by: ROOT, archived: false }]);
        const said = await world.call(ROOT, { action: "steer", chat: "22", message });
        const blank = (message ?? "").trim() === "";

        expect(said.text === REFUSED.nothingToSteer).toBe(blank);
        expect(said.failed).toBe(blank);
        expect(world.seen.steers).toHaveLength(blank ? 0 : 1);
      }),
      runs()
    );
  });
});
