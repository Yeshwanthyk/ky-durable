/**
 * Builds the `ky` binary for each platform, with the release inside it (cli/binary.ts): `pnpm
 * compile [darwin-arm64 …]`, after `vite build`. The release is gathered in dist/release, packed
 * into dist/release.pack, and the binaries land in dist/bin. The macOS ones are signed only when
 * this runs on macOS. KY_VERSION names the release; without it, the release is the commit's.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { experimental_readRawConfig } from "wrangler";
import { bundleOf, CHECKOUT, packOf, releaseFiles } from "./release.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const BUILT = path.join(REPO, "dist/ky");

const CLIENT = path.join(REPO, "dist/client");

const targets = process.argv.slice(2);

const platforms = targets.length > 0 ? targets : ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

// The generic wrangler.jsonc, not the build's resolved one, which holds this checkout's overlay.
const config = experimental_readRawConfig({ config: path.join(REPO, "wrangler.jsonc") }).rawConfig;

const built: { main: string } = JSON.parse(await readFile(path.join(BUILT, "wrangler.json"), "utf8"));

// A release's own (.github/workflows/release.yml sets it from the tag), else the commit.
const version = process.env.KY_VERSION || execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();

// The cloud machine's image. A release's binary names the release.json published beside it, which
// names the image (cli/release.ts): the image holds this binary, so it can't hold the image's digest.
// A checkout's build carries container/image.digest's: the file's first line that isn't a comment.
const digestFile = path.join(REPO, "container/image.digest");

const cloud = process.env.KY_VERSION
  ? { imageFrom: `https://github.com/${process.env.GITHUB_REPOSITORY || "Yeshwanthyk/ky-durable"}/releases/download/v${version}/release.json` }
  : {
      image: existsSync(digestFile)
        ? (await readFile(digestFile, "utf8")).split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("#"))
        : undefined
    };

// What the web app's build marks as never served: the resolved config and .dev.vars.
const ignored = new Set([".assetsignore", ...(await readFile(path.join(CLIENT, ".assetsignore"), "utf8")).split("\n").filter(Boolean)]);

await rm(CHECKOUT, { recursive: true, force: true });

await mkdir(CHECKOUT, { recursive: true });

await writeFile(path.join(CHECKOUT, "SKILL.md"), await readFile(path.join(import.meta.dirname, "SKILL.md")));

// The Worker's modules, without the build's resolved config and Vite's manifest.
await cp(BUILT, path.join(CHECKOUT, "worker"), { recursive: true, filter: (file) => ![".vite", "wrangler.json"].includes(path.basename(file)) });

await cp(CLIENT, path.join(CHECKOUT, "assets"), { recursive: true, filter: (file) => !ignored.has(path.relative(CLIENT, file)) });

// Last, as it pins every file above.
const manifest = { version, bundle: bundleOf(await releaseFiles(CHECKOUT)), config: { ...config, main: built.main }, ...cloud };

await writeFile(path.join(CHECKOUT, "release.json"), JSON.stringify(manifest, null, 2));

await writeFile(path.join(REPO, "dist/release.pack"), packOf(await releaseFiles(CHECKOUT)));

for (const platform of platforms) {
  const out = `dist/bin/ky-${platform}`;

  execFileSync("bun", ["build", "--compile", `--target=bun-${platform}`, "cli/binary.ts", "--outfile", out], { cwd: REPO, stdio: "inherit" });

  // A binary built for the other Mac architecture carries a broken signature, and macOS on Apple
  // silicon runs nothing unsigned.
  if (platform.startsWith("darwin-") && process.platform === "darwin") execFileSync("codesign", ["--force", "--sign", "-", out], { cwd: REPO, stdio: "inherit" });
}
