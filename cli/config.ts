/**
 * The CLI user's owner overlay (C6): what a checkout keeps in wrangler.local.jsonc, `ky init`
 * writes to ~/.config/ky/wrangler.local.jsonc. Same format, same merge: `ky deploy` lays it over
 * the release's generic wrangler.jsonc with wrangler-overlay.ts, as vite.config.ts does for
 * `pnpm run deploy`. It names the account and the Worker, and holds the owner's vars (who Access
 * lets in among them) and VPC services: the two things the overlay merges rather than replaces. The
 * Worker's bindings stay the release's, so a release that changes them reaches every `ky upgrade`.
 * It holds no token.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Unstable_RawConfig } from "wrangler";
import { applyOverlay } from "../wrangler-overlay.ts";
import type { Release } from "./release.ts";

/** ~/.config/ky/wrangler.local.jsonc, under XDG_CONFIG_HOME when it's set. */
export function overlayPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "ky", "wrangler.local.jsonc");
}

/** What the CLI's overlay may set: anything else would replace the release's own. */
const SETTINGS = new Set(["$schema", "account_id", "name", "vars", "vpc_services"]);

/** The overlay `ky init` writes: what was saved, with the account, the Worker's name and who Access lets in. */
export function overlayFor(saved: Unstable_RawConfig, account: string, name: string, allowed: string): Unstable_RawConfig {
  return { ...saved, account_id: account, name, vars: { ...saved.vars, ACCESS_EMAILS: allowed } };
}

/** The emails Access lets in: ACCESS_EMAILS (C3). */
export function emails(config: Unstable_RawConfig): string[] {
  const value = config.vars?.ACCESS_EMAILS;

  return Value.Check(Type.String(), value) ? value.split(",").map((email) => email.trim()).filter(Boolean) : [];
}

/** What the overlay lacks for a deploy, each with the `ky init` flag that fills it in. */
export function incomplete(overlay: Unstable_RawConfig): { setting: string; flag: string }[] {
  return [
    ...(overlay.account_id ? [] : [{ setting: "account_id", flag: "--account <id or name>" }]),
    ...(overlay.name ? [] : [{ setting: "name", flag: "--name <worker>" }]),
    ...(emails(overlay).length > 0 ? [] : [{ setting: "ACCESS_EMAILS", flag: "--email <you@example.com>" }])
  ];
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
  const other = Object.keys(overlay).find((key) => !SETTINGS.has(key));

  if (other)
    throw new Error(`${file} sets \`${other}\`, which would replace ky's own; remove it (ky's settings are account_id, name, vars and vpc_services)`);

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
