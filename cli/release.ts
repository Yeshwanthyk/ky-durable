/**
 * The release a deploy uploads: the Worker's modules, the web app's files, the
 * generic wrangler.jsonc they were built with, and the guide for agents. The
 * compiled `ky` carries one (cli/binary.ts hands it over); run from a checkout,
 * `ky` reads the one `pnpm compile` left in dist/release.
 *
 * On disk and in the pack the layout is the same:
 *   release.json   { version, bundle, config, image? | imageFrom? }
 *   worker/…       the Worker's modules, the config's `main` among them
 *   assets/…       the web app
 *   SKILL.md       `ky skill`
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Unstable_RawConfig } from "wrangler";

/**
 * release.json. `version` is the release's (`v<version>` is its tag), or the commit it was built
 * from. `bundle` pins the rest of the release: bundleOf every other file. `config` is wrangler.jsonc
 * as built: generic, no owner overlay, its `main` the built entry module.
 *
 * The cloud machine's image, `ghcr.io/…@sha256:…`, is `image` in a checkout's build, from
 * container/image.digest. A published release's binary can't carry it: the image holds that
 * binary, so the image's digest can't be inside it. Its `imageFrom` is the URL of the release.json
 * published beside it, which names the image (releaseImage). A release with neither deploys no
 * cloud machine.
 */
type Manifest = { version: string; bundle: string; config: Unstable_RawConfig; image?: string; imageFrom?: string };

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

/**
 * `sha256:<hex>` over every file of a release but release.json: each file's path and its own sha-256,
 * in path order. release.json's `bundle`, and what the release's page lists, so anyone can check
 * that a `ky` deploys the Worker and web app it says it does.
 */
export function bundleOf(files: Map<string, Uint8Array>): string {
  const hash = createHash("sha256");

  for (const name of [...files.keys()].filter((name) => name !== "release.json").sort()) {
    hash.update(`${name}\0${createHash("sha256").update(files.get(name)!).digest("hex")}\n`);
  }

  return `sha256:${hash.digest("hex")}`;
}

function fromFiles(files: Map<string, Uint8Array>): Release {
  const text = (name: string) => {
    const file = files.get(name);

    if (!file) throw new Error(`The release has no ${name}`);

    return new TextDecoder().decode(file);
  };

  const manifest: Manifest = JSON.parse(text("release.json"));

  if (manifest.bundle !== bundleOf(files)) throw new Error(`The release's files aren't the ones its release.json pins (${manifest.bundle})`);

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

/** How long a deploy waits for the published release.json. */
const PUBLISHED_TIMEOUT_MS = 30_000;

/**
 * The cloud machine's image the release deploys: its own `image`, or the one its published
 * release.json names, which must be this release's (the same version and bundle). Undefined when
 * the release has none. A published release.json that can't be read is an error, not "no image":
 * a deploy without the image would turn the cloud machine off.
 */
export async function releaseImage(release: Manifest): Promise<string | undefined> {
  if (release.image || !release.imageFrom) return release.image;
  const url = release.imageFrom;
  let published: Partial<Manifest>;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PUBLISHED_TIMEOUT_MS) });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    published = await response.json();
  } catch (error) {
    throw new Error(`Couldn't read the cloud machine's image from ${url} (${error instanceof Error ? error.message : String(error)}); check the network, then run it again`);
  }

  if (published.version !== release.version || published.bundle !== release.bundle) {
    throw new Error(`${url} is another release's (${published.version}, ${published.bundle}), not ky ${release.version}'s`);
  }

  return published.image;
}
