import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineDoc, type EntryRecord, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { type Archive, readArchive, readTar, restoreArchive } from "../archive";
import { backupRoute } from "../backup";
import { CARD_ANSWER } from "../cards/contract";
import { withoutLateNote } from "../core/late";
import { MIGRATION_TABLE } from "../core/migrate";
import { makeSql, Sql } from "../core/sql";
import { LOOK_POST, projectEntry, SPECIALIST_REPLY, TO_SPECIALISTS } from "../core/transcript";
import { readMedia, withCurrentMediaTags } from "../files/media";
import { MIGRATIONS } from "../migrations";
import type { PiAgent } from "../server";
import { agent, inside, until } from "./drive";

/**
 * Migration 1 (src/migrations.ts): a ky whose data the release before it wrote wakes, through PiAgent's own
 * constructor, with every stored kind and tag renamed; its task runs, its document is found, its thread reads as
 * it did. A restore of an archive from before it (format 1) migrates the archive's data the same way.
 */

const FILE = "0123456789abcdef0123456789abcdef";

const OLD_CLIP = `<ky-media kind="audio" file="${FILE}" type="audio/webm" name="Voice note">hello there</ky-media>`;

const OLD_LATE = "<ky-late>(written 3h ago while offline, delivered now)</ky-late>";

const USER_TEXT = `listen\n\n${OLD_CLIP}\n\n${OLD_LATE}`;

/** What the model said about the old tag: history as it was, never rewritten. */
const SAID = "The page writes <ky-media> around a clip.";

// SAFETY: each caller's query selects exactly the columns of its T.
const all = <T>(state: DurableObjectState, query: string, ...bindings: SqlStorageValue[]) => state.storage.sql.exec(query, ...bindings).toArray() as T[];

/** The subagent registry (src/skills/subagents.ts) under `kind`. */
const registry = (kind: string) =>
  defineDoc<{ agents: Record<string, { reported: string[] }> }>({
    kind,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ agents: {} })
  });

/** The kind the release before kept it under, and its kind now. */
const OldRegistry = registry("ky.subagents");

const Registry = registry("subagents");

/** Migration 1 run again, straight on the storage. */
const runAgain = (state: DurableObjectState) => Effect.runSync(Effect.provideService(MIGRATIONS[0]!.run, Sql, makeSql(state.storage)));

/** A pending, background task row of `kind`, as pi writes one (its record and its JSON-quoted kind column). */
function pendingTask(state: DurableObjectState, kind: string): number {
  const [{ next_id: next } = { next_id: "0" }] = all<{ next_id: string }>(state, "SELECT next_id FROM pi_durable_metadata");
  const id = Number(next);
  const record = { id, conversationId: ROOT_CONVERSATION_ID, kind, version: 1, input: null, background: true, abortRequested: false, state: { status: "pending", checkpoint: { phase: "done" } } };

  state.storage.sql.exec("INSERT INTO pi_record_ids (id, record_type) VALUES (?, 'task')", id);
  state.storage.sql.exec("INSERT INTO pi_tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, ?, 'pending', 0, 1, ?)", id, ROOT_CONVERSATION_ID, JSON.stringify(kind), JSON.stringify(record));
  state.storage.sql.exec("UPDATE pi_durable_metadata SET next_id = ?", String(id + 1));

  return id;
}

/**
 * The agent `name`'s data as the release before migration 1 left it, at level 0: entries, a document and tasks of
 * the old kinds, and a user's message with the old tags. The tasks are written after pi is idle, so none runs yet:
 * the anchor ky defines (under its old name), and one no release defines.
 */
async function seedLevel0(name: string): Promise<{ anchor: number; stray: number }> {
  return inside(name, async (instance, state) => {
    const pi = await instance.harness.pi();

    await pi.commit(async (tx) => {
      const at = (timestamp: number) => ({ timestamp });

      await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { model: [{ role: "user", content: USER_TEXT, ...at(1) }] });
      // SAFETY: an assistant message as pi stores one; the entry draft type asks for more than this test needs.
      await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, {
        model: [{ role: "assistant", content: [{ type: "text", text: SAID }], api: "", provider: "", model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", ...at(2) }]
      } as never);
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ky.look", data: { text: "a look" }, model: [{ role: "user", content: "[ky posted to the user, unasked] a look", ...at(3) }] });
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ky.to-specialists", data: { to: ["fin"] }, model: [{ role: "user", content: "[for @fin] the numbers", ...at(4) }] });
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ky.specialist-reply", data: { specialist: "fin", text: "they add up", failed: false }, model: [{ role: "user", content: "[@fin replied to the user] they add up", ...at(5) }] });
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ky.card-answer", data: { card: "c1", answer: "yes" } });
      (await tx.doc(OldRegistry, ROOT_CONVERSATION_ID)).agents.scout = { reported: ["7"] };
    }, BACKGROUND_CONTEXT);

    const tasks = { anchor: pendingTask(state, "ky.subagent-anchor"), stray: pendingTask(state, "no-release-defines-this") };
    state.storage.sql.exec(`DELETE FROM ${MIGRATION_TABLE}`);

    return tasks;
  });
}

const kindsOf = (state: DurableObjectState) => ({
  tasks: all<{ kind: string; record: string }>(state, "SELECT kind, json_extract(record, '$.kind') AS record FROM pi_tasks ORDER BY id"),
  documents: all<{ kind: string; record: string }>(state, "SELECT kind, json_extract(record, '$.kind') AS record FROM pi_documents ORDER BY id"),
  entries: all<{ kind: string }>(state, "SELECT json_extract(record, '$.kind') AS kind FROM pi_entries ORDER BY id").map((row) => row.kind)
});

/** The root conversation's entries, through pi, oldest first. */
const entriesOf = (instance: PiAgent): Promise<EntryRecord[]> =>
  instance.harness.pi().then((pi) => pi.commit(async (tx) => [...(await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100)).items].reverse(), BACKGROUND_CONTEXT));

const taskStatus = (instance: PiAgent, id: number) =>
  // SAFETY: a task's id is the number pi minted for it.
  instance.harness.pi().then((pi) => pi.commit(async (tx) => (await tx.task(id as never))?.state.status, BACKGROUND_CONTEXT));

/** What the migrated data must read as, through pi and the thread's projection. */
async function expectMigrated(instance: PiAgent, state: DurableObjectState) {
  const kinds = kindsOf(state);
  expect(JSON.stringify(kinds)).not.toMatch(/ky\./);
  expect(kinds.documents).toContainEqual({ kind: '"subagents"', record: "subagents" });

  const entries = await entriesOf(instance);
  const user = entries.find((entry) => entry.kind === "pi.user")!;
  // SAFETY: the user entry seeded above holds its message as one string.
  const text = user.model?.[0]?.content as string;
  expect(text).not.toMatch(/ky-/);
  expect(readMedia(withoutLateNote(text))).toEqual({ clips: [expect.objectContaining({ file: FILE, transcript: "hello there" })], text: "listen" });
  // The model's words, and the prose line, stay as written.
  expect(JSON.stringify(entries.find((entry) => entry.kind === "pi.assistant")?.model)).toContain(SAID);
  expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", LOOK_POST, TO_SPECIALISTS, SPECIALIST_REPLY, CARD_ANSWER]);
  expect(projectEntry(entries[2]!)).toMatchObject({ posted: true, parts: [{ type: "text", text: "a look" }] });
  expect(projectEntry(entries[3]!)).toMatchObject({ role: "user", to: ["fin"] });
  expect(projectEntry(entries[4]!)).toMatchObject({ role: "specialist", from: "fin" });
  expect(JSON.stringify(entries[2]!.model)).toContain("[ky posted to the user, unasked]");

  // pi finds the document by its kind now.
  const found = await instance.harness.pi().then((pi) => pi.commit(async (tx) => [...((await tx.doc(Registry, ROOT_CONVERSATION_ID)).agents.scout?.reported ?? [])], BACKGROUND_CONTEXT));
  expect(found).toEqual(["7"]);
}

describe("migration 1: neutral stored kinds and tags", () => {
  it("wakes a ky at level 0 renamed: its task runs, its document is found, its thread reads as before", async () => {
    const name = `level0-${crypto.randomUUID().slice(0, 8)}`;
    const { anchor, stray } = await seedLevel0(name);

    // A restart: the next call makes the object again, and its constructor migrates before pi opens.
    await inside(name, (_instance, state) => state.abort("deployed")).catch(() => undefined);

    await inside(name, async (instance, state) => {
      expect(all(state, `SELECT level, name, ran FROM ${MIGRATION_TABLE}`)).toEqual([{ level: 1, name: MIGRATIONS[0]!.name, ran: 1 }]);
      await expectMigrated(instance, state);

      // Again, it finds nothing left to rename.
      const once = { kinds: kindsOf(state), entries: all(state, "SELECT record FROM pi_entries ORDER BY id") };
      runAgain(state);
      expect({ kinds: kindsOf(state), entries: all(state, "SELECT record FROM pi_entries ORDER BY id") }).toEqual(once);
    });

    // The anchor's kind is one pi has a definition for, so it runs to its end; a kind none defines stays parked.
    await until(async () => (await inside(name, (instance) => taskStatus(instance, anchor))) === "terminal", "the anchor ran");
    expect(await inside(name, (instance) => taskStatus(instance, stray))).not.toBe("terminal");
  });

  it("is recorded unrun on a fresh ky, and changes nothing there when run", async () => {
    const name = `fresh-${crypto.randomUUID().slice(0, 8)}`;

    await inside(name, async (instance, state) => {
      expect(all(state, `SELECT level, ran FROM ${MIGRATION_TABLE}`)).toEqual([{ level: 1, ran: 0 }]);
      await instance.harness.pi();
      const before = kindsOf(state);

      runAgain(state);
      expect(kindsOf(state)).toEqual(before);
    });
  });

  it("restores an archive from before it (format 1) with its data renamed", async () => {
    const source = `format1-${crypto.randomUUID().slice(0, 8)}`;
    await seedLevel0(source);

    const request = new Request("https://ky.test/api/backup");
    const response = (await backupRoute(request, env, new URL(request.url), agent(source)))!;
    const archive = readArchive(readTar(new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())));

    // As a release before migrations wrote it: format 1, no data level, no record of migrations.
    const { data: _data, ...schemas } = archive.manifest.schemas;

    const { [MIGRATION_TABLE]: _rows, ...rows } = archive.end.rows;

    const format1: Archive = {
      ...archive,
      manifest: { ...archive.manifest, version: 1, schemas, tables: archive.manifest.tables.filter((table) => table.name !== MIGRATION_TABLE) },
      parts: archive.parts.filter((part) => part.table !== MIGRATION_TABLE),
      end: { ...archive.end, rows }
    };

    expect(JSON.stringify(format1.parts)).toMatch(/ky\.subagent-anchor/);

    const target = `restored-${crypto.randomUUID().slice(0, 8)}`;

    const send = (path: string, init?: RequestInit) => {
      const sent = new Request(`https://restored.test${path}`, init);

      return backupRoute(sent, env, new URL(sent.url), agent(target))!;
    };

    await restoreArchive(format1, send, true);
    await inside(target, (_instance, state) => state.abort("restored")).catch(() => undefined);

    await inside(target, async (instance, state) => {
      expect(all(state, `SELECT level, ran FROM ${MIGRATION_TABLE}`)).toEqual([{ level: 1, ran: 1 }]);
      await expectMigrated(instance, state);
    });
  });

  it("renames the old media tag a page from before the deploy still sends", () => {
    expect(withCurrentMediaTags(`hi ${OLD_CLIP}`)).toBe(`hi ${OLD_CLIP.replaceAll("ky-media", "media-clip")}`);
    expect(withCurrentMediaTags([{ type: "text", text: OLD_CLIP }])).toEqual([{ type: "text", text: OLD_CLIP.replaceAll("ky-media", "media-clip") }]);
  });
});

