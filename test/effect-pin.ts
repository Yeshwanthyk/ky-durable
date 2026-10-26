/**
 * `pnpm effect:pin`, part of `pnpm check`: effect and every @effect/* package are one version, and
 * vendor/effect is Effect's source at that version.
 *
 * Agents read vendor/effect for Effect's real API rather than guessing it from memory, so a submodule
 * one release behind the lockfile teaches them the wrong API. Four things must agree:
 *
 *   package.json   effect and each @effect/* pinned exactly, all to the same version V
 *   lockfile       resolves effect and each @effect/* to V and nothing else
 *   vendor/effect  checked out at the commit the repo records for it
 *   vendor/effect  packages/effect/package.json says V
 *
 * To move the pin: bump package.json, `pnpm install`, then
 * `git -C vendor/effect fetch --depth 1 origin tag effect@V && git -C vendor/effect checkout effect@V`
 * and `git add vendor/effect`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Type from "typebox";
import { parseAs } from "../src/core/decode.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const VENDOR = path.join(REPO, "vendor/effect");

const Manifest = Type.Object({
  version: Type.Optional(Type.String()),
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String()))
});

/** Whether `name` is one of the packages that move together. */
function isEffect(name: string): boolean {
  return name === "effect" || name.startsWith("@effect/");
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });

  return result.status === 0 ? result.stdout.trim() : "";
}

const problems: string[] = [];

const manifest = parseAs(Manifest, readFileSync(path.join(REPO, "package.json"), "utf8"), "package.json");

const pinned = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) => isEffect(name));

const versions = new Set(pinned.map(([, version]) => version));

const [version] = versions;

if (version === undefined) problems.push("package.json has no effect dependency");

if (versions.size > 1) problems.push(`package.json pins effect packages to ${[...versions].join(", ")}: pin them all to one version`);

for (const [name, range] of pinned) if (!/^\d+\.\d+\.\d+$/.test(range)) problems.push(`package.json: ${name} is "${range}", not an exact version`);

// The lockfile's package keys: `effect@4.0.6:` and `'@effect/vitest@4.0.6':` at two-space indent.
const lock = readFileSync(path.join(REPO, "pnpm-lock.yaml"), "utf8");

const resolved = new Set([...lock.matchAll(/^ {2}'?((?:@effect\/[a-z-]+)|effect)@([^(':]+)/gm)].map((match) => `${match[1]}@${match[2]}`));

for (const entry of resolved) if (version !== undefined && !entry.endsWith(`@${version}`)) problems.push(`pnpm-lock.yaml resolves ${entry}, not ${version}`);

const recorded = git("ls-files", "-s", "vendor/effect").split(/\s+/)[1];

const vendorManifest = path.join(VENDOR, "packages/effect/package.json");

if (!recorded) problems.push("vendor/effect isn't a submodule of this repo");
else if (!existsSync(vendorManifest)) problems.push("vendor/effect isn't checked out: run `git submodule update --init vendor/effect`");
else {
  const head = spawnSync("git", ["-C", VENDOR, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  if (head !== recorded) problems.push(`vendor/effect is at ${head.slice(0, 7)}, but the repo records ${recorded.slice(0, 7)}: run \`git submodule update vendor/effect\``);

  const vendored = parseAs(Manifest, readFileSync(vendorManifest, "utf8"), "vendor/effect/packages/effect/package.json").version;

  if (version !== undefined && vendored !== version) problems.push(`vendor/effect is effect ${vendored}, but package.json pins ${version}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.log(`effect pin: ${problem}`);
  process.exit(1);
}

console.log(`effect pin: effect ${version}, ${pinned.length} packages, lockfile and vendor/effect agree`);
