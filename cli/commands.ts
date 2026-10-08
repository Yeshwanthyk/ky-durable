/**
 * `ky deploy`, `ky upgrade`, `ky doctor`, `ky teardown` and `ky skill`. Each takes the run's
 * context, so the tests run them in-process against test/fakes/cloudflare.ts, and returns the
 * process's exit code.
 */
import { rm } from "node:fs/promises";
import type { Cloudflare } from "./cloudflare.ts";
import { merged, readOverlay } from "./config.ts";
import { type Check, deploy, deployedRelease, inspect, leftovers, type Target, teardown } from "./deployer.ts";
import type { Release } from "./release.ts";

export type Context = {
  /** The overlay `ky init` writes (cli/config.ts). */
  overlay: string;
  release: () => Promise<Release>;
  login: () => Promise<Cloudflare>;
  print: (line: string) => void;
};

/** The deploy the overlay describes; `ky init` makes one. */
async function target(context: Context): Promise<{ target: Target; release: Release }> {
  const overlay = await readOverlay(context.overlay);

  if (!overlay) throw new Error(`ky isn't set up here (no ${context.overlay}); run \`ky init\``);
  const release = await context.release();

  return { target: { cloudflare: await context.login(), config: merged(release, overlay) }, release };
}

/** Deploys, and shows the URL and, once, a KY_TOKEN the deploy set. */
async function deployTo(context: Context, to: Target, release: Release): Promise<number> {
  const deployed = await deploy(to, release, (step) => context.print(`· ${step}`));

  context.print(deployed.from ? `ky ${release.version} is live at ${deployed.url} (was ${deployed.from})` : `ky ${release.version} is live at ${deployed.url}`);

  if (deployed.token) context.print(`Your KY_TOKEN, shown once (sign in with it): ${deployed.token}`);

  return 0;
}

export async function deployCommand(context: Context): Promise<number> {
  const { target: to, release } = await target(context);

  return deployTo(context, to, release);
}

/** Deploys this ky's release over the Worker, when it runs another one. */
export async function upgradeCommand(context: Context): Promise<number> {
  const { target: to, release } = await target(context);
  const from = await deployedRelease(to);

  if (!from) throw new Error("There's no ky Worker to upgrade; run `ky deploy`");

  if (from === release.version) {
    context.print(`Already on ${release.version}`);

    return 0;
  }

  return deployTo(context, to, release);
}

/** The config, the login, then each piece of the deploy, as far as each lets the next be checked. */
async function doctor(context: Context): Promise<Check[]> {
  const overlay = await readOverlay(context.overlay);
  const config: Check = { name: "Config", ok: Boolean(overlay), detail: overlay ? context.overlay : `no ${context.overlay}`, next: "ky init" };

  if (!overlay) return [config];
  const release = await context.release();
  let cloudflare: Cloudflare;

  try {
    cloudflare = await context.login();
  } catch (error) {
    return [config, { name: "Cloudflare login", ok: false, detail: error instanceof Error ? error.message : String(error), next: "wrangler login" }];
  }

  return [
    config,
    { name: "Cloudflare login", ok: true, detail: cloudflare.login },
    ...(await inspect({ cloudflare, config: merged(release, overlay) }, release))
  ];
}

/** Checks each piece of the deploy, and prints the command that fixes the first one missing. */
export async function doctorCommand(context: Context, json: boolean): Promise<number> {
  const checks = await doctor(context);
  const next = checks.find((check) => !check.ok)?.next;

  if (json) context.print(JSON.stringify({ checks, next }, null, 2));
  else {
    for (const check of checks) context.print(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    context.print(next ? `Next: ${next}` : "All good");
  }

  return next ? 1 : 0;
}

/** Removes the deploy, once `confirm` is its name, then the overlay. */
export async function teardownCommand(context: Context, confirm: string | undefined): Promise<number> {
  const { target: from } = await target(context);
  const name = from.config.name;

  if (confirm !== name) throw new Error(`This deletes the ${name} Worker, its chats and files, and its Access apps. Run \`ky teardown --confirm ${name}\``);
  await teardown(from, (step) => context.print(`· ${step}`));
  const left = await leftovers(from);

  if (left.length > 0) {
    context.print(`Still in the account: ${left.join(", ")}. Run \`ky teardown --confirm ${name}\` again`);

    return 1;
  }

  await rm(context.overlay);
  context.print(`Removed ${name}`);

  return 0;
}

/** The guide for agents that run `ky`. */
export async function skillCommand(context: Context): Promise<number> {
  context.print((await context.release()).skill);

  return 0;
}
