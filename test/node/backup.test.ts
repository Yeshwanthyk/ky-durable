import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END, FORMAT, FORMAT_VERSION, MANIFEST, type Manifest, partPath, type Restored, tarEnd, tarEntry } from "../../src/archive.ts";
import type { Context } from "../../cli/commands.ts";
import { ky } from "../../cli/ky.ts";
import { writeDeployed, writeOverlay } from "../../cli/config.ts";
import { type FakeSystem, fakeSystem } from "../fakes/system.ts";

/**
 * `ky backup` and `ky restore` against a stand-in ky: an HTTP server that serves a built archive
 * at /api/backup and takes /api/restore, both only with the fake `cloudflared`'s Access token.
 */

const UPLOAD = `files/${"a".repeat(32)}`;

const encode = (text: string) => new TextEncoder().encode(text);

const MANIFEST_: Manifest = {
  format: FORMAT,
  version: FORMAT_VERSION,
  createdAt: "2026-10-10T12:00:00.000Z",
  source: { origin: "https://ky.old.workers.dev", worker: "v1" },
  schemas: { pi: 1, workspace: 8 },
  tables: [{ name: "memo_log", sql: "CREATE TABLE memo_log (id INTEGER PRIMARY KEY, text TEXT)", indexes: [], columns: ["id", "text"], rowid: false, sequence: null }],
  skipped: { ky_providers: "keys are in the Vault" },
  files: [{ key: UPLOAD, size: 5, type: "image/png" }],
  leftOut: [{ what: "API key for openai", why: "secrets stay in the Vault", next: "add it again in Settings, under Models" }],
  summary: { chats: 3, messages: 42, notes: 2, skills: 1, specialists: 1, automations: 1, workspaceFiles: 4, uploads: 1, uploadBytes: 5 },
  unfinished: 0
};

/** A gzipped archive; `cut` leaves off end.json, as a dropped download would. */
function archive(cut = false): Uint8Array {
  const rows = '[1,"likes oolong"]\n[2,"deploys on Fridays"]\n';

  const entries = [
    ...tarEntry(MANIFEST, encode(JSON.stringify(MANIFEST_))),
    ...tarEntry(partPath("memo_log", 0), encode(rows)),
    ...tarEntry(UPLOAD, encode("bytes")),
    ...(cut ? [] : [...tarEntry(END, encode(JSON.stringify({ rows: { memo_log: 2 }, files: 1 }))), tarEnd()])
  ];

  return gzipSync(Buffer.concat(entries));
}

let server: Server;

let url: string;

let served: Uint8Array;

let requests: string[];

let output: string[];

let system: FakeSystem;

function context(): Context {
  return {
    system,
    env: {},
    sleep: async () => {},
    overlay: path.join(system.home, "no-overlay.jsonc"),
    release: async () => {
      throw new Error("no release");
    },
    login: async () => {
      throw new Error("no login");
    },
    print: (line) => output.push(line),
    fail: (line) => output.push(line)
  };
}

beforeEach(async () => {
  system = await fakeSystem();
  served = archive();
  requests = [];
  output = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(`${request.method} ${request.url} ${Buffer.concat(chunks).length}`);

      if (request.headers["cf-access-token"] !== "access-token") {
        response.writeHead(302, { Location: "https://team.cloudflareaccess.com/login" }).end();
      } else if (request.url === "/api/backup") {
        response.writeHead(200, { "Content-Type": "application/gzip" }).end(served);
      } else if (request.url === "/api/restore/finish") {
        const restored: Restored = { summary: MANIFEST_.summary, rows: 2, files: 1, leftOut: MANIFEST_.leftOut };
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(restored));
      } else if (request.url?.startsWith("/api/restore/rows")) {
        response.writeHead(200, { "Content-Type": "application/json" }).end('{"rows":2}');
      } else {
        response.writeHead(204).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port has an AddressInfo address.
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("ky backup", () => {
  it("downloads the archive to ~/ky-backups, readable by the owner only, and says what it holds and left out", async () => {
    expect(await ky(["backup", "--url", url], context())).toBe(0);

    const folder = path.join(system.home, "ky-backups");
    const [file] = await readdir(folder);
    expect(file).toMatch(/^127-\d{8}T\d{6}Z\.tar\.gz$/);
    expect(statSync(path.join(folder, file!)).mode & 0o777).toBe(0o600);
    expect(system.ran).toContain(`cloudflared access token -app=${url}`);
    const said = output.join("\n");
    expect(said).toContain("3 chats, 42 messages");
    expect(said).toContain("2 memory notes, 1 skill");
    expect(said).toContain("4 workspace files, 1 shared file (5 B)");
    expect(said).toContain("API key for openai");
  });

  it("writes to --out, and takes KY_URL for the ky", async () => {
    const out = path.join(await mkdtemp(path.join(tmpdir(), "ky-backup-")), "mine.tar.gz");

    expect(await ky(["backup", "--out", out], { ...context(), env: { KY_URL: `${url}/chat` } })).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("finds the ky at the address its last deploy saved, with no Cloudflare login", async () => {
    const overlay = path.join(system.home, ".config", "ky", "wrangler.local.jsonc");
    await writeOverlay(overlay, { account_id: "acc", name: "ky" });
    await writeDeployed(overlay, { account: "acc", name: "ky", url });

    expect(await ky(["backup"], { ...context(), overlay })).toBe(0);
    expect(system.ran).toContain(`cloudflared access token -app=${url}`);
  });

  it("looks the deploy up, as before, when the saved address is another deploy's", async () => {
    const overlay = path.join(system.home, ".config", "ky", "wrangler.local.jsonc");
    await writeOverlay(overlay, { account_id: "acc", name: "ky-renamed", vars: { ACCESS_EMAILS: "owner@example.com" } });
    await writeDeployed(overlay, { account: "acc", name: "ky", url });

    expect(await ky(["backup"], { ...context(), overlay })).toBe(1);
    // The context has no release or login to look it up with; what matters is the saved address went unused.
    expect(output.join("\n")).toContain("no release");
    expect(system.ran.some((command) => command.includes(url))).toBe(false);
  });

  it("keeps no archive that was cut off", async () => {
    served = archive(true);

    expect(await ky(["backup", "--url", url], context())).toBe(1);
    expect(output.join("\n")).toMatch(/cut off/);
    expect(await readdir(path.join(system.home, "ky-backups"))).toEqual([]);
  });

  it("signs in with cloudflared access login when Access has no token, then backs up", async () => {
    system.accessToken = undefined;

    expect(await ky(["backup", "--url", url], context())).toBe(0);
    expect(system.ran.filter((command) => command.startsWith("cloudflared"))).toEqual([
      `cloudflared access token -app=${url}`,
      `cloudflared access login ${url}`,
      `cloudflared access token -app=${url}`
    ]);
    expect(output.join("\n")).toContain("opens your browser");
  });

  it("says how to sign in when the sign-in fails, and sends nothing", async () => {
    system.accessToken = undefined;
    system.accessLogin = undefined;

    expect(await ky(["backup", "--url", url], context())).toBe(1);
    expect(output.join("\n")).toContain(`cloudflared access login ${url}`);
    expect(system.ran.filter((command) => command.includes("access login"))).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  it("says how to install cloudflared when it isn't there", async () => {
    system.exec = async (command, args) => {
      system.ran.push([command, ...args].join(" "));

      return { code: 127, stdout: "", stderr: `${command}: not found` };
    };

    expect(await ky(["backup", "--url", url], context())).toBe(1);
    expect(output.join("\n")).toContain("brew install cloudflared");
    expect(requests).toEqual([]);
  });
});

describe("ky restore", () => {
  it("uploads the files and rows, finishes, and lists what to add again", async () => {
    const file = path.join(system.home, "backup.tar.gz");
    await writeFile(file, archive());

    expect(await ky(["restore", file, "--url", url, "--force"], context())).toBe(0);
    expect(requests.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "POST /api/restore",
      `PUT /api/restore/${UPLOAD}`,
      "POST /api/restore/rows?table=memo_log",
      "POST /api/restore/finish"
    ]);
    expect(requests[0]).not.toMatch(/ 0$/);
    expect(output.join("\n")).toContain("add it again in Settings, under Models");
  });

  it("signs in with cloudflared access login when Access has no token", async () => {
    const file = path.join(system.home, "backup.tar.gz");
    await writeFile(file, archive());
    system.accessToken = undefined;

    expect(await ky(["restore", file, "--url", url, "--force"], context())).toBe(0);
    expect(system.ran).toContain(`cloudflared access login ${url}`);
    expect(requests.at(-1)).toMatch(/^POST \/api\/restore\/finish/);
  });

  it("refuses a cut-off backup before it sends anything", async () => {
    const file = path.join(system.home, "cut.tar.gz");
    await writeFile(file, archive(true));

    expect(await ky(["restore", file, "--url", url], context())).toBe(1);
    expect(output.join("\n")).toMatch(/cut off/);
    expect(requests).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
