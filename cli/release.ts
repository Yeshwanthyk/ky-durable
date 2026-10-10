/**
 * The release a deploy uploads: the Worker's modules, the web app's files, the
 * generic wrangler.jsonc they were built with, and the guide for agents. The
 * compiled `ky` carries one (cli/binary.ts hands it over); run from a checkout,
 * `ky` reads the one `pnpm compile` left in dist/release.
 *
 * On disk and in the pack the layout is the same:
 *   release.json   { version, config, image? }
 *   worker/…       the Worker's modules, the config's `main` among them
 *   assets/…       the web app
 *   SKILL.md       `ky skill`
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Unstable_RawConfig } from "wrangler";

/**
 * release.json. `config` is wrangler.jsonc as built: generic, no owner overlay, its `main` the
 * built entry module. `image` is the cloud machine's image, `ghcr.io/…@sha256:…`, from
 * container/image.digest; a release without one deploys no cloud machine.
 */
type Manifest = { version: string; config: Unstable_RawConfig; image?: string };

export type Release = Manifest & {
  /** Module name (`index.js`, `assets/models-….js`) to content. */
  modules: Map<string, Uint8Array>;
  /** Asset path (`/index.html`) to content. */
  assets: Map<string, Uint8Array>;
  skill: string;
};

/** The release in dist/release when `ky` runs from a checkout. */
export const CHECKOUT = path.resolve(import.meta.dirname, "../dist/release");

let packed: string | undefined;

/** cli/binary.ts: the path Bun gives the pack embedded in the binary. */
export function useRelease(pack: string): void {
  packed = pack;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
  );

  return nested.flat();
}

/** Every file of a release folder, by its path in the folder. */
export async function releaseFiles(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  for (const file of await walk(dir)) files.set(path.relative(dir, file), await readFile(file));

  return files;
}

function fromFiles(files: Map<string, Uint8Array>): Release {
  const text = (name: string) => {
    const file = files.get(name);

    if (!file) throw new Error(`The release has no ${name}`);

    return new TextDecoder().decode(file);
  };

  const manifest: Manifest = JSON.parse(text("release.json"));

  const under = (prefix: string, key: (name: string) => string) =>
    new Map([...files].flatMap(([name, content]) => (name.startsWith(prefix) ? [[key(name.slice(prefix.length)), content] as const] : [])));

  return {
    ...manifest,
    modules: under("worker/", (name) => name),
    assets: under("assets/", (name) => `/${name}`),
    skill: text("SKILL.md")
  };
}

/** The pack: each file of a release, by path, base64. */
export function packOf(files: Map<string, Uint8Array>): string {
  return JSON.stringify(Object.fromEntries([...files].map(([name, content]) => [name, Buffer.from(content).toString("base64")])));
}

/** The release this `ky` carries, or the checkout's. */
export async function loadRelease(): Promise<Release> {
  if (!packed) {
    if (!existsSync(CHECKOUT)) throw new Error(`There's no release in ${CHECKOUT}: run \`pnpm compile\` first`);

    return fromFiles(await releaseFiles(CHECKOUT));
  }

  const pack: Record<string, string> = JSON.parse(await readFile(packed, "utf8"));

  return fromFiles(new Map(Object.entries(pack).map(([name, base64]) => [name, Buffer.from(base64, "base64")])));
}
