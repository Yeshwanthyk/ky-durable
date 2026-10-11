/**
 * `ky backup` and `ky restore` (B1): the owner's copy of their ky, memory and all, from the
 * Worker's /api/backup, and the same copy put back into a fresh deploy through /api/restore.
 * Both sign in as the owner the way the live scripts do (test/live-access.ts): Access takes a
 * `cloudflared access token` in place of the browser's cookie. The archive's format is
 * src/archive.ts, which the Worker shares.
 */
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { type Archive, type LeftOut, readArchive, readTar, restoreArchive, type Send, type Summary } from "../src/archive.ts";
import { type Context, target } from "./commands.ts";
import { readDeployed, readOverlay } from "./config.ts";
import { address } from "./deployer.ts";
import { bold, dim, green } from "./output.ts";

type Flags = { url?: string; out?: string; force?: boolean };

/**
 * The ky to back up or restore into: --url, else KY_URL, else the deploy `ky init` set up here, at the address
 * its last deploy saved. Only a deploy from before ky saved it asks Cloudflare, which needs a Cloudflare login.
 */
async function kyUrl(context: Context, flags: Flags): Promise<string> {
  const given = flags.url ?? context.env.KY_URL;

  if (given) return new URL(given).origin;
  const overlay = await readOverlay(context.overlay);
  const saved = overlay && (await readDeployed(context.overlay, overlay));

  return saved ?? address((await target(context)).target);
}

/** The Access token `cloudflared` has for `url`, or "" when it has none. */
async function accessToken(context: Context, url: string): Promise<string> {
  const ran = await context.system.exec("cloudflared", ["access", "token", `-app=${url}`]);

  if (ran.code === 127) throw new Error("ky signs in to your ky with cloudflared: install it (`brew install cloudflared`), then try again");

  return ran.code === 0 ? ran.stdout.trim() : "";
}

/**
 * The headers that sign in to `url` as its owner, from `cloudflared access token`. With no token
 * yet, `cloudflared access login` signs in first: it opens the browser and waits for the sign-in.
 */
async function signIn(context: Context, url: string): Promise<Record<string, string>> {
  let token = await accessToken(context, url);

  if (!token) {
    context.print(`Signing in to ${bold(url)}: cloudflared opens your browser`);
    const login = await context.system.exec("cloudflared", ["access", "login", url]);

    token = login.code === 0 ? await accessToken(context, url) : "";
  }

  if (!token) throw new Error(`Couldn't sign in to ${url}: run \`cloudflared access login ${url}\`, then try again`);

  return { "cf-access-token": token };
}

/** A request to the ky at `url`, signed in; a redirect is Access asking for a sign-in it didn't get. */
function sender(url: string, headers: Record<string, string>): Send {
  return async (route, init) => {
    const signed = new Headers(init.headers);

    for (const [name, value] of Object.entries(headers)) signed.set(name, value);
    const response = await fetch(`${url}${route}`, { ...init, headers: signed, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`${url} sent ky to sign in: run \`cloudflared access login ${url}\`, then try again`);
    }

    return response;
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  const units = ["KB", "MB", "GB"];
  let value = count / 1024;
  let unit = 0;

  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;

  return `${value.toFixed(1)} ${units[unit]}`;
}

function summaryLines(summary: Summary): string[] {
  return [
    `  ${plural(summary.chats, "chat")}, ${plural(summary.messages, "message")}`,
    `  ${plural(summary.notes, "memory note")}, ${plural(summary.skills, "skill")}, ${plural(summary.specialists, "specialist")}, ${plural(summary.automations, "automation")}`,
    `  ${plural(summary.workspaceFiles, "workspace file")}, ${plural(summary.uploads, "shared file")} (${bytes(summary.uploadBytes)})`
  ];
}

function leftOutLines(leftOut: readonly LeftOut[], next: boolean): string[] {
  return leftOut.map((each) => `  - ${each.what}${dim(`: ${next && each.next ? each.next : each.why}`)}`);
}

/** The archive in a .tar.gz, checked whole. */
function readBackup(gzipped: Uint8Array): Archive {
  let tar: Uint8Array<ArrayBuffer>;

  try {
    tar = new Uint8Array(gunzipSync(gzipped));
  } catch {
    throw new Error("This backup is cut off or isn't a ky backup: it doesn't unzip. Take the backup again.");
  }

  return readArchive(readTar(tar));
}

/** `<worker>-<UTC time>.tar.gz`, the worker named by the address's first label. */
function fileName(url: string, at: Date): string {
  const worker = new URL(url).hostname.split(".")[0] || "ky";
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "").replaceAll("-", "");

  return `${worker}-${stamp}.tar.gz`;
}

/** Writes the backup `response` streams to `out`, checked whole first: a cut-off one is never kept. */
async function save(response: Response, out: string): Promise<Archive> {
  if (!response.ok || !response.body) throw new Error(`The backup failed (${response.status}): ${(await response.text()).trim()}`);
  const partial = `${out}.partial`;

  // Only the owner reads it: it holds every chat and note, if no key.
  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  const file = await open(partial, "w", 0o600);

  try {
    for await (const chunk of response.body) await file.write(chunk);
  } finally {
    await file.close();
  }

  let archive: Archive;

  try {
    archive = readBackup(await readFile(partial));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  await chmod(partial, 0o600);
  await rename(partial, out);

  return archive;
}

export async function backupCommand(context: Context, flags: Flags): Promise<number> {
  const url = await kyUrl(context, flags);
  const send = sender(url, await signIn(context, url));
  const out = path.resolve(flags.out ?? path.join(context.system.home, "ky-backups", fileName(url, new Date())));

  context.print(`Backing up ${bold(url)}`);
  const { manifest } = await save(await send("/api/backup", { method: "GET" }), out);
  const size = (await readFile(out)).length;

  context.print(`${green("Backed up")} to ${bold(out)} ${dim(`(${bytes(size)})`)}`);

  for (const line of summaryLines(manifest.summary)) context.print(line);

  if (manifest.unfinished > 0) {
    context.print(`${plural(manifest.unfinished, "run was", "runs were")} still going; back up again when ky is idle to keep what they finish.`);
  }

  if (manifest.leftOut.length > 0) {
    context.print("Not in the backup:");

    for (const line of leftOutLines(manifest.leftOut, false)) context.print(line);
  }

  return 0;
}

export async function restoreCommand(context: Context, file: string | undefined, flags: Flags): Promise<number> {
  if (!file) throw new Error("usage: ky restore <backup.tar.gz> [--url <ky>] [--force]");
  const archive = readBackup(await readFile(file));
  const url = await kyUrl(context, flags);
  const send = sender(url, await signIn(context, url));

  context.print(`Restoring ${bold(path.basename(file))} ${dim(`(from ${archive.manifest.source.origin}, ${archive.manifest.createdAt})`)} into ${bold(url)}`);
  const restored = await restoreArchive(archive, send, flags.force ?? false);

  context.print(`${green("Restored")} ${plural(restored.rows, "row")} and ${plural(restored.files, "file")}:`);

  for (const line of summaryLines(restored.summary)) context.print(line);

  if (restored.leftOut.length > 0) {
    context.print("Add these again, which a backup never holds:");

    for (const line of leftOutLines(restored.leftOut, true)) context.print(line);
  }

  return 0;
}
