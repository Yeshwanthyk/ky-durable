/**
 * The CLI user's owner overlay (C6): what a checkout keeps in wrangler.local.jsonc, `ky init`
 * writes to ~/.config/ky/wrangler.local.jsonc. Same format, same merge: `ky deploy` lays it over
 * the release's generic wrangler.jsonc with wrangler-overlay.ts, as vite.config.ts does for
 * `pnpm run deploy`. It names the account, the Worker, its bucket and who Access lets in; it holds
 * no token.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Unstable_RawConfig } from "wrangler";
import { applyOverlay } from "../wrangler-overlay.ts";
import type { Release } from "./release.ts";

/** ~/.config/ky/wrangler.local.jsonc, under XDG_CONFIG_HOME when it's set. */
export function overlayPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "ky", "wrangler.local.jsonc");
}

/** The overlay `ky init` writes for one deploy. */
export function overlayFor(account: string, name: string, emails: string[]): Unstable_RawConfig {
  return {
    account_id: account,
    name,
    r2_buckets: [{ binding: "FILES", bucket_name: `${name}-files` }],
    vars: { ACCESS_EMAILS: emails.join(",") }
  };
}

/**
 * The overlay at `file`, or undefined when there's none. Parsed with jsonc-parser, not wrangler's
 * experimental_readRawConfig as vite.config.ts does: the compiled `ky` doesn't carry wrangler.
 */
export async function readOverlay(file: string): Promise<Unstable_RawConfig | undefined> {
  if (!existsSync(file)) return undefined;
  const errors: ParseError[] = [];
  const overlay: Unstable_RawConfig = parse(await readFile(file, "utf8"), errors, { allowTrailingComma: true });

  if (errors[0]) throw new Error(`${file} isn't valid JSONC: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);

  return overlay;
}

export async function writeOverlay(file: string, overlay: Unstable_RawConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "// ky's owner overlay, written by `ky init`; `ky deploy` merges it over ky's wrangler.jsonc.",
      "// Same format as a checkout's wrangler.local.jsonc (see wrangler.local.example.jsonc).",
      JSON.stringify(overlay, null, 2),
      ""
    ].join("\n")
  );
}

/** The release's generic config with the overlay over it. */
export function merged(release: Release, overlay: Unstable_RawConfig): Unstable_RawConfig {
  const config: Unstable_RawConfig = structuredClone(release.config);

  applyOverlay(config, overlay);

  return config;
}
