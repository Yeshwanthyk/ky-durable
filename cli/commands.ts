/**
 * `ky deploy`, `ky upgrade`, `ky doctor`, `ky teardown` and `ky skill`. Each takes the run's
 * context, so the tests run them in-process against test/fakes/cloudflare.ts, and returns the
 * process's exit code.
 */
import { rm } from "node:fs/promises";
import type { Unstable_RawConfig } from "wrangler";
import { type Cloudflare, tokenPage } from "./cloudflare.ts";
import { incomplete, merged, readOverlay } from "./config.ts";
import { type Check, deploy, deployedRelease, inspect, leftovers, type Target, teardown } from "./deployer.ts";
import { bold, dim, green, type Output, output, red } from "./output.ts";
import type { Release } from "./release.ts";

export type Context = {
  /** The overlay `ky init` writes (cli/config.ts). */
  overlay: string;
  release: () => Promise<Release>;
  login: () => Promise<Cloudflare>;
  print: (line: string) => void;
  /** Where a failure is reported. */
  fail: (line: string) => void;
};

/** The `ky init` that fills in what the overlay lacks. */
function initFor(overlay: Unstable_RawConfig): string {
  return ["ky init", ...incomplete(overlay).map((setting) => setting.flag)].join(" ");
}

/** What the overlay lacks for a deploy, as a sentence, or undefined when it lacks nothing. */
function lacking(file: string, overlay: Unstable_RawConfig): string | undefined {
  const missing = incomplete(overlay);

  return missing.length > 0 ? `${file} has no ${missing.map((setting) => setting.setting).join(", ")}` : undefined;
}

/** The deploy the overlay describes; `ky init` makes one. */
async function target(context: Context): Promise<{ target: Target; release: Release }> {
  const overlay = await readOverlay(context.overlay);

  if (!overlay) throw new Error(`ky isn't set up here (no ${context.overlay}); run \`${initFor({})}\``);
  const lacks = lacking(context.overlay, overlay);

  if (lacks) throw new Error(`${lacks}; run \`${initFor(overlay)}\``);
  const release = await context.release();

  return { target: { cloudflare: await context.login(), config: merged(release, overlay), settings: context.overlay }, release };
}

/** Deploys, and shows the URL. */
async function deployTo(out: Output, to: Target, release: Release): Promise<number> {
  const deployed = await out.steps("Stopped. Run `ky deploy` to finish the deploy.", (say) => {
    say("Checking what's in the account");

    return deploy(to, release, say);
  });

  const live = `${green(`ky ${release.version} is live`)} at ${bold(deployed.url)}`;

  out.outro(deployed.from ? `${live} (was ${deployed.from})` : live);

  return 0;
}

export async function deployCommand(context: Context): Promise<number> {
  const out = output(context.print);

  out.intro("ky deploy");
  const { target: to, release } = await target(context);

  return deployTo(out, to, release);
}

/** Deploys this ky's release over the Worker, when it runs another one. */
export async function upgradeCommand(context: Context): Promise<number> {
  const out = output(context.print);

  out.intro("ky upgrade");
  const { target: to, release } = await target(context);
  const from = await out.waiting("Reading the Worker's release", () => deployedRelease(to));

  if (!from) throw new Error("There's no ky Worker to upgrade; run `ky deploy`");

  if (from === release.version) {
    out.outro(`Already on ${release.version}`);

    return 0;
  }

  return deployTo(out, to, release);
}

/** The overlay, checked: there, readable, and with everything a deploy needs. */
async function configCheck(file: string): Promise<{ check: Check; overlay?: Unstable_RawConfig }> {
  const name = "Config";
  let overlay: Unstable_RawConfig | undefined;

  try {
    overlay = await readOverlay(file);
  } catch (error) {
    return { check: { name, ok: false, detail: error instanceof Error ? error.message : String(error), next: `fix ${file}, then run \`ky doctor\`` } };
  }

  if (!overlay) return { check: { name, ok: false, detail: `no ${file}`, next: initFor({}) } };
  const lacks = lacking(file, overlay);

  if (lacks) return { check: { name, ok: false, detail: lacks, next: initFor(overlay) } };

  return { check: { name, ok: true, detail: file }, overlay };
}

/** The config, the release, the login, then each piece of the deploy, as far as each lets the next be checked. */
async function doctor(context: Context): Promise<Check[]> {
  const { check: config, overlay } = await configCheck(context.overlay);

  if (!overlay) return [config];
  let release: Release;
  let cloudflare: Cloudflare;

  try {
    release = await context.release();
  } catch (error) {
    return [config, { name: "Release", ok: false, detail: error instanceof Error ? error.message : String(error), next: "pnpm compile" }];
  }

  try {
    cloudflare = await context.login();
  } catch (error) {
    return [
      config,
      { name: "Cloudflare login", ok: false, detail: error instanceof Error ? error.message : String(error), next: `wrangler login, or set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}` }
    ];
  }

  return [
    config,
    { name: "Cloudflare login", ok: true, detail: cloudflare.login },
    ...(await inspect({ cloudflare, config: merged(release, overlay), settings: context.overlay }, release))
  ];
}

/** Each check as a line, its details lined up, with what fixes each failed one. */
function checkLines(checks: Check[]): string[] {
  const width = Math.max(...checks.map((check) => check.name.length));

  return checks.map(
    (check) => `${check.ok ? green("✓") : red("✗")} ${check.name.padEnd(width)}  ${check.detail}${!check.ok && check.next ? dim(`  → ${check.next}`) : ""}`
  );
}

/** Checks each piece of the deploy, and prints the command that fixes the first one missing. */
export async function doctorCommand(context: Context, json: boolean): Promise<number> {
  const checks = json ? await doctor(context) : await output(context.print).waiting("Checking each piece of the deploy", () => doctor(context));
  const next = checks.find((check) => !check.ok)?.next;

  if (json) context.print(JSON.stringify({ checks, next }, null, 2));
  else {
    for (const line of checkLines(checks)) context.print(line);
    context.print(next ? `${bold("Next:")} ${next}` : green("All good"));
  }

  return next ? 1 : 0;
}

/** Removes the deploy, once `confirm` is its name, then the overlay. */
export async function teardownCommand(context: Context, confirm: string | undefined): Promise<number> {
  const { target: from } = await target(context);
  const name = from.config.name;

  if (confirm !== name) throw new Error(`This deletes the ${name} Worker, its chats and files, and its Access apps. Run \`ky teardown --confirm ${name}\``);
  const out = output(context.print);

  out.intro("ky teardown");

  const left = await out.steps(`Stopped. Run \`ky teardown --confirm ${name}\` again to finish.`, async (say) => {
    say("Checking what's in the account");
    await teardown(from, say);

    say("Checking nothing is left");

    return leftovers(from);
  });

  if (left.length > 0) {
    out.outro(`Still in the account: ${left.join(", ")}. Run \`ky teardown --confirm ${name}\` again`);

    return 1;
  }

  await rm(context.overlay);
  out.outro(`${green("Removed")} ${name}`);

  return 0;
}

/** The guide for agents that run `ky`. */
export async function skillCommand(context: Context): Promise<number> {
  context.print((await context.release()).skill);

  return 0;
}
