import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Archive, readArchive, readTar, restoreArchive, type Send } from "../archive";
import { backupRoute } from "../backup";
import { ASSERTION } from "../access/contract";
import { CLOUD } from "../cloud-facts";
import { saveKey } from "../sandboxes";
import { restores } from "../tables";
import { agent, call, connect, connectExecutor, inside, pairing, prompt, said, until } from "./drive";

/**
 * B1: `ky backup` and `ky restore`, through the Worker's routes and the
 * client the CLI drives them with (src/archive.ts). The Worker serves the one
 * agent "me", so a restore here goes to another agent by the route's target.
 */

const SECRET = "sk-test-never-in-a-backup";

/** The archive GET /api/backup streams for "me", read and checked whole. */
async function backUp(): Promise<{ archive: Archive; tar: Uint8Array }> {
  const response = await call("/api/backup");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/gzip");
  const tar = new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

  return { archive: readArchive(readTar(tar)), tar };
}

/** Requests to the backup and restore routes of the agent `name`, as the CLI sends them to its ky. */
const routeTo =
  (name: string): Send =>
  async (path, init) => {
    const request = new Request(`https://restored.test${path}`, init);

    return (await backupRoute(request, env, new URL(request.url), agent(name)))!;
  };

const restoreInto = routeTo;

/** Every row of `table` in the agent `name`, as the backup dumps it. */
async function rows(name: string, table: string): Promise<string> {
  let text = "";
  let after = null;

  do {
    const page = await agent(name).backupRows(table, after);
    text += page.text;
    after = page.after;
  } while (after !== null);

  return text;
}

const ask = (name: string, session: string, text: string) => inside(name, async (instance) => (await instance.harness.prompt(text, { session })).text ?? "");

/** Fill "me" through ky's own tools, as the owner and ky would. */
async function fill(): Promise<{ chat: string; upload: string }> {
  const tool = (name: string, args: Readonly<Record<string, string>>) => prompt("me", `tool ${name} ${JSON.stringify(args)}`);

  await tool("memory_note", { text: "The user drinks oolong, never coffee." });
  await tool("memory_note", { text: "Deploys happen on Fridays." });
  await tool("skill_manage", { action: "create", name: "brew", description: "Brew tea", body: "Steep for three minutes." });
  await tool("skill_manage", { action: "patch", name: "brew", old: "three", new: "four" });
  await tool("soul_edit", { action: "edit", body: "# SOUL.md\nDry, brief, kind." });
  await tool("specialist", { action: "create", id: "gardener", description: "Tends the garden", brief: "Water the basil." });
  await tool("specialist", { action: "edit", id: "gardener", brief: "Water the basil and the mint." });
  await tool("automation", { action: "create", title: "Morning tea", prompt: "Remind me to brew", cron: "0 8 * * *" });
  await tool("write", { path: "/workspace/notes.txt", content: "kept across deploys" });

  const chat = await inside("me", (instance) => instance.newChat());
  await ask("me", chat, "Plan a trip to Kyoto in spring");

  // A file a machine task shared: its bytes in the bucket, its row in the agent.
  const upload = `files/${crypto.randomUUID().replaceAll("-", "")}`;
  await env.FILES.put(upload, "a shared screenshot", { httpMetadata: { contentType: "image/png" } });
  await inside("me", (instance) =>
    instance.files.record({ id: upload.slice("files/".length), task: "t1", name: "shot.png", type: "image/png", size: 19, caption: "the bug" })
  );

  await pairing("me", "laptop");

  // A second sandbox, and a saved disk for each: the disks stay in the old deploy's bucket.
  const web = await inside("me", (instance) => instance.createSandbox({ name: "web", repos: ["me/web"] }));
  await Promise.all([CLOUD, web.id].map((id) => env.FILES.put(saveKey(id), "a disk")));
  await env.Vault.getByName("owner").put("provider", "openai", { apiKey: SECRET });

  return { chat, upload };
}

describe("backup and restore", () => {
  it("backs a ky up whole and restores it into a fresh one, with every version, file and chat", async () => {
    const { chat, upload } = await fill();
    const { archive, tar } = await backUp();
    const { manifest } = archive;

    expect(manifest.summary).toMatchObject({ chats: 2, notes: 2, skills: 1, specialists: 1, uploads: 1, uploadBytes: 19 });
    expect(manifest.summary.messages).toBeGreaterThanOrEqual(4);
    expect(manifest.summary.workspaceFiles).toBe(1);
    // Secrets stay in the Vault; the manifest says which there were.
    expect(new TextDecoder().decode(tar)).not.toContain(SECRET);
    expect(manifest.leftOut.map((each) => each.what)).toEqual(
      expect.arrayContaining(["API key for openai", "Machine laptop", `Sandbox ${CLOUD}'s saved disk`, "Sandbox web's saved disk"])
    );
    // A sandbox isn't a computer to pair again.
    expect(manifest.leftOut.map((each) => each.what)).not.toContain("Machine web");
    expect(Object.keys(manifest.skipped)).toEqual(expect.arrayContaining(["ky_machines", "ky_providers", "ky_history", "cf_agents_jobs"]));
    expect(manifest.tables.map((table) => table.name)).toEqual(expect.arrayContaining(["pi_entries", "memo_log", "ky_skill_versions", "vfs_nodes", "ky_sandboxes"]));
    // Every table a lived-in ky backs up is one a restore puts back: none is dropped on the way.
    expect(manifest.tables.map((table) => table.name).filter((table) => !restores(table))).toEqual([]);

    // A new deploy's bucket: the upload isn't there until the restore puts it back.
    await env.FILES.delete(upload);
    const target = "fresh-restored";
    const restored = await restoreArchive(archive, restoreInto(target), false);
    expect(restored.summary).toEqual(manifest.summary);
    expect(restored.leftOut).toEqual(manifest.leftOut);

    // Every table restored row for row, but those the restore sets right for its new deploy.
    const fixed = ["ky_setup", "ky_automations", "ky_tasks", "ky_sandboxes_seeded"];

    for (const table of manifest.tables.filter((each) => !fixed.includes(each.name))) {
      expect(await rows(target, table.name), table.name).toBe(await rows("me", table.name));
    }

    expect(await (await env.FILES.get(upload))!.text()).toBe("a shared screenshot");

    // And ky works on them: search is rebuilt, versions kept, the automation booked again, the workspace there.
    expect((await prompt(target, 'tool chat_search {"query":"Kyoto"}')).text).toContain("user: Plan a trip to [Kyoto] in spring");
    expect((await prompt(target, 'tool memory_recall {"regex":"oolong"}')).text).toContain("never coffee");

    const view = await inside(target, async (instance) => ({
      skill: instance.skills.history("brew").map((version) => version.body),
      soul: instance.soul.current().body,
      brief: instance.specialists.brief("gardener").history().length,
      automations: (await instance.automations.list()).map((automation) => [automation.title, automation.status]),
      chats: instance.chats.list().map((each) => each.session)
    }));

    expect(view).toEqual({
      skill: ["Steep for four minutes.", "Steep for three minutes."],
      soul: "# SOUL.md\nDry, brief, kind.",
      brief: 2,
      automations: [["Morning tea", "active"]],
      chats: [chat]
    });
    expect(await inside(target, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM ky_automations WHERE schedule_id IS NULL").one().n)).toBe(0);
    expect((await prompt(target, 'tool read {"path":"/workspace/notes.txt"}')).text).toContain("kept across deploys");
    expect(await inside(target, (instance) => instance.setup.origin())).toBe(null);
  });

  it("keeps the sandboxes of the deploy it restores over as kept disks, and sets its machines right", async () => {
    const web = `web-${crypto.randomUUID().slice(0, 8)}`;
    const backedUp = await inside("me", (instance) => instance.createSandbox({ name: web, repos: [`me/${web}`] }));
    const { archive } = await backUp();
    const target = "sandboxed-target";

    // The deploy restored over: a sandbox with a saved disk, a kept disk with none, and a computer named as the backup's sandbox.
    const own = await inside(target, (instance) => {
      const api = instance.createSandbox({ name: "api" });
      const old = instance.createSandbox({ name: "old" });

      instance.sandboxes.delete(old.id);

      return { api: api.id, old: old.id };
    });

    await env.FILES.put(saveKey(own.api), "the api's disk");
    await pairing(target, web);
    await restoreArchive(archive, restoreInto(target), true);

    // The object starts when the browser opens it.
    const socket = await connect(target);

    const state = () =>
      inside(target, (instance) => ({
        live: instance.sandboxes.live().map((each) => each.id),
        kept: instance.sandboxes.kept().map((each) => each.id),
        api: instance.machines.machine("api")?.name ?? null
      }));

    // The backup's sandboxes; this deploy's api kept with its disk, the old one dropped with none, and api no machine now.
    await until(async () => {
      const now = await state();

      return now.api === null && !now.kept.includes(own.old);
    }, "the stale machine removed, the lost disk dropped");
    expect(await state()).toEqual({ live: expect.arrayContaining([CLOUD, backedUp.id]), kept: [own.api], api: null });
    expect(await rows(target, "ky_sandboxes")).toContain(`"${own.api}"`);
    expect(await inside(target, (instance) => instance.sandboxes.get(own.api))).toMatchObject({ name: "api", isDefault: false, deletedAt: expect.any(Number) });
    // The computer keeps its name, and the restart says so.
    expect(await inside(target, (instance) => instance.machines.listSandboxes().clashes)).toEqual([web]);
    socket.close();
    await env.FILES.delete(saveKey(own.api));
  });

  it("restores only the tables ky names, and a corrupt cell it restores reads as its default", async () => {
    const name = "stray-source";
    await prompt(name, 'tool memory_note {"text":"Kept through the restore."}');
    await inside(name, (_instance, state) => {
      const sql = state.storage.sql;

      // A table no contract names, as an old version or a hand edit might leave, and a choice that isn't JSON.
      sql.exec("CREATE TABLE ky_stray (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      sql.exec("INSERT INTO ky_stray (note) VALUES ('left behind')");
      sql.exec("INSERT INTO ky_purposes (purpose, value) VALUES ('main', '{broken') ON CONFLICT(purpose) DO UPDATE SET value = excluded.value");
    });

    const response = await routeTo(name)("/api/backup", { method: "GET" });
    const archive = readArchive(readTar(new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())));
    expect(archive.manifest.tables.map((table) => table.name)).toEqual(expect.arrayContaining(["ky_stray", "ky_purposes"]));

    const target = "stray-target";
    const restored = await restoreArchive(archive, restoreInto(target), false);
    // Left out, and said so.
    expect(restored.leftOut.map((each) => each.what)).toContain("Table ky_stray");

    const tables = await inside(target, (_instance, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name)
    );

    expect(tables).not.toContain("ky_stray");
    expect(tables.filter((table) => table.startsWith("ky_restore__"))).toEqual([]);
    // The damaged cell came across as it was, and reads as no choice: the purpose's default runs.
    expect(await rows(target, "ky_purposes")).toBe(await rows(name, "ky_purposes"));
    expect(await rows(target, "ky_purposes")).toContain("{broken");
    expect(await inside(target, (instance) => instance.models.settings.get("main") ?? null)).toBeNull();
    expect(await rows(target, "memo_log")).toContain("Kept through the restore.");
  });

  it("restores the user's tool policies, and a pending approval that expires cleanly on its tap", async () => {
    const name = `approvals-${crypto.randomUUID().slice(0, 8)}`;
    await connectExecutor(name);
    await prompt(name, 'tool executor_execute {"code":"approve gmail.send send mail to sam"}');
    await inside(name, (instance) => instance.executorApprovals.setPolicy("drive.delete", "block"));

    const response = await routeTo(name)("/api/backup", { method: "GET" });
    const archive = readArchive(readTar(new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())));
    const target = `${name}-restored`;
    await restoreArchive(archive, restoreInto(target), false);

    // The new deploy's Executor never had the request: the tap expires it, and the chat is told.
    await connectExecutor(target);
    const [card] = await inside(target, (instance) => instance.approvals.pending());
    expect(card).toMatchObject({ kind: "executor", subject: "gmail.send", summary: "send mail to sam" });
    expect(await inside(target, (instance) => instance.approvals.onDecision(card!.id, "accept"))).toEqual({});
    await said(target, "Executor no longer has request request-1: it expired");
    expect(await inside(target, (instance) => instance.approvals.pending())).toEqual([]);
    expect(await inside(target, (instance) => instance.executorApprovals.policyFor("drive.delete"))).toBe("block");
  });

  it("refuses to restore over a ky with chats or memory, unless forced", async () => {
    const { archive } = await backUp();
    const target = "used-target";
    await prompt(target, 'tool memory_note {"text":"Mine, not the backup\'s."}');

    await expect(restoreArchive(archive, restoreInto(target), false)).rejects.toThrow(/already has chats or memory/);
    await restoreArchive(archive, restoreInto(target), true);
    expect(await rows(target, "memo_log")).toBe(await rows("me", "memo_log"));
  });

  it("refuses to finish a restore whose rows didn't all arrive", async () => {
    await prompt("me", 'tool memory_note {"text":"One note at least."}');
    const { archive } = await backUp();
    const send = restoreInto("cut-target");
    expect((await send("/api/restore", { method: "POST", body: JSON.stringify({ manifest: archive.manifest, end: archive.end }) })).status).toBe(204);
    const finish = await send("/api/restore/finish", { method: "POST", body: "{}" });
    expect(finish.status).toBe(409);
    expect(await finish.text()).toMatch(/cut off/);
  });

  it("keeps backup and restore behind the owner's sign-in", async () => {
    const signedOut = { headers: { [ASSERTION]: "" } };

    expect((await call("/api/backup", signedOut)).ok).toBe(false);
    expect((await call("/api/restore", { ...signedOut, method: "POST", body: "{}" })).ok).toBe(false);
  });

  it("backs up completely a ky that ran main's schema, once the new code has migrated it", async () => {
    const name = "main-schema";
    const tool = (tool: string, args: Readonly<Record<string, string>>) => prompt(name, `tool ${tool} ${JSON.stringify(args)}`);
    await tool("memory_note", { text: "Production has run since spring." });
    await tool("skill_manage", { action: "create", name: "deploy", description: "Ship ky", body: "Run the gate first." });
    await tool("skill_manage", { action: "patch", name: "deploy", old: "first", new: "before anything" });
    await tool("soul_edit", { action: "edit", body: "# SOUL.md\nTerse." });
    await tool("automation", { action: "create", title: "Nightly", prompt: "Check the deploys", cron: "0 2 * * *" });
    await tool("write", { path: "/workspace/plan.md", content: "the plan" });
    const chat = await inside(name, (instance) => instance.newChat());
    await ask(name, chat, "What shipped last week?");

    // Turn its tables back into main's (55b79e7): what the setup work added gone, ky_settings there.
    await inside(name, (_instance, state) => {
      const sql = state.storage.sql;

      for (const table of ["ky_setup", "ky_providers", "ky_purposes", "ky_machine_logins"]) sql.exec(`DROP TABLE IF EXISTS ${table}`);
      sql.exec("ALTER TABLE ky_tasks DROP COLUMN agent");
      sql.exec("ALTER TABLE ky_machines DROP COLUMN pairing");
      sql.exec("ALTER TABLE ky_machines DROP COLUMN login");
      sql.exec("CREATE TABLE ky_settings (slot TEXT PRIMARY KEY, value TEXT NOT NULL)");
      sql.exec("INSERT INTO ky_settings (slot, value) VALUES ('main', 'anthropic/claude-sonnet')");
      sql.exec(
        `INSERT INTO ky_tasks (id, kind, worker, title, status, summary, session, created_at, updated_at, source, steps, started_at, finished_at, turns, cost_usd)
         VALUES ('t-main', 'machine', 'laptop', 'Fix the build', 'done', 'Fixed', NULL, 1, 2, 'chat', '[]', 1, 2, 3, 0.25)`
      );
    });

    const before = Object.fromEntries(
      await Promise.all(["pi_entries", "memo_log", "ky_skill_versions", "ky_soul_versions", "ky_automations", "ky_chats", "ky_tasks", "vfs_nodes"].map(async (table) => [table, (await rows(name, table)).split("\n").length] as const))
    );

    // Production upgrades: the object restarts under the new code, which migrates it on start.
    await expect(inside(name, (_instance, state) => state.abort("deployed"))).rejects.toThrow();

    const response = await routeTo(name)("/api/backup", { method: "GET" });
    expect(response.status).toBe(200);
    const archive = readArchive(readTar(new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())));
    const tables = archive.manifest.tables.map((table) => table.name);

    expect(tables).not.toContain("ky_settings");
    expect(tables).toEqual(expect.arrayContaining(["ky_setup", "ky_purposes"]));
    expect(archive.manifest.tables.find((table) => table.name === "ky_tasks")!.columns).toContain("agent");

    for (const [table, count] of Object.entries(before)) {
      expect(archive.end.rows[table], table).toBe(count - 1);
    }

    const tasks = archive.parts.filter((part) => part.table === "ky_tasks").map((part) => part.text).join("");
    expect(tasks).toContain("Fix the build");
    expect(archive.manifest.summary).toMatchObject({ chats: 2, notes: 1, skills: 1, automations: 1, workspaceFiles: 1 });

    // And it restores into a fresh ky of the new code.
    await restoreArchive(archive, restoreInto("fresh-from-main"), false);
    expect((await prompt("fresh-from-main", 'tool memory_recall {"regex":"Production"}')).text).toContain("run since spring");
    expect(await inside("fresh-from-main", (instance) => instance.skills.history("deploy").map((version) => version.body))).toEqual([
      "Run the gate before anything.",
      "Run the gate first."
    ]);
  });
});
