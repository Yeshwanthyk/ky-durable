import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Fills in public/sw.js's `const BUILD = …;` line in a client build with the build's version and every file
 * the browser can fetch from it, so the service worker caches them all on install and ky starts offline with
 * any part of it, not only the parts already visited. The version hashes every file's name and content, the
 * page's included, so a deploy that changes anything ships a new sw.js, which the browser installs.
 */

/** What the build leaves next to the app that the browser never fetches: the worker itself, the page (cached as `/`), and the deploy's own files. */
const SKIP = new Set(["sw.js", "index.html", ".assetsignore", "wrangler.json", ".dev.vars"]);

const BUILD_LINE = /^const BUILD = .*;$/m;

export type Build = { version: string; files: string[] };

function walk(dir: string, under = ""): string[] {
  return readdirSync(path.join(dir, under), { withFileTypes: true }).flatMap((entry) => {
    const name = path.posix.join(under, entry.name);

    // Dot directories (Vite's .vite manifest) and source maps are never asked for by the app.
    if (entry.name.startsWith(".") && entry.isDirectory()) return [];

    if (entry.isDirectory()) return walk(dir, name);

    return SKIP.has(name) || name.endsWith(".map") ? [] : [name];
  });
}

/** The build in the client output `dir`: its version and its files' URLs. */
export function precacheList(dir: string): Build {
  const names = walk(dir).sort();
  const hash = createHash("sha256");

  for (const name of [...names, "index.html"]) hash.update(`${name}\0`).update(readFileSync(path.join(dir, name)));

  return { version: hash.digest("hex").slice(0, 16), files: names.map((name) => `/${name}`) };
}

/** Write the build in `dir` into its sw.js, and return it. */
export function writePrecache(dir: string): Build {
  const file = path.join(dir, "sw.js");
  const source = readFileSync(file, "utf8");

  if (!BUILD_LINE.test(source)) throw new Error(`${file} has no \`const BUILD = …;\` line for the build to fill in`);
  const build = precacheList(dir);
  writeFileSync(file, source.replace(BUILD_LINE, () => `const BUILD = ${JSON.stringify(build)};`));

  return build;
}

/** The Vite plugin: after the client's build is written (public/ copied in first), its sw.js gets the build. */
export function precache(): Plugin {
  return {
    name: "ky:precache",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle(options) {
      writePrecache(options.dir ?? path.resolve(this.environment.config.root, this.environment.config.build.outDir));
    }
  };
}
