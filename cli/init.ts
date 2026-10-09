/**
 * `ky init`: from a Cloudflare login to ky running behind Access. It signs in, picks the account,
 * makes sure Zero Trust and a workers.dev subdomain are on, asks for the Worker's name and the
 * owner's email, writes the overlay (cli/config.ts) and deploys. Run again, it keeps what the
 * overlay has and asks only for what it lacks, so it's also how `ky doctor` fixes a missing setting.
 *
 * Each answer can come as a flag instead; without a terminal, as when an agent runs it, a missing
 * one is an error that names its flag.
 */
import { execFile } from "node:child_process";
import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { isCancel, password, select, text } from "@clack/prompts";
import type { Unstable_RawConfig } from "wrangler";
import { Cloudflare, refused, tokenPage } from "./cloudflare.ts";
import type { Context } from "./commands.ts";
import { emails, merged, overlayFor, readOverlay, writeOverlay } from "./config.ts";
import { claim, type Deployed, deploy, NameTaken, teamDomain, zeroTrustPage } from "./deployer.ts";

export type InitFlags = { account?: string; name?: string; email?: string; subdomain?: string };

/** A Worker name whose bucket, `<name>-files`, is a valid bucket name too. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,55}[a-z0-9])?$/;

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** The flag's value, or the prompt's answer in a terminal. */
async function ask(given: string | undefined, flag: string, prompt: () => ReturnType<typeof text>): Promise<string> {
  if (given !== undefined) return given;

  if (!interactive()) throw new Error(`Pass ${flag}`);
  const answer = await prompt();

  if (isCancel(answer)) throw new Error("Cancelled");

  return answer;
}

function validName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "Lowercase letters, digits and dashes, at most 57";
}

/** Opens the URL in the browser, when there's one to open it in. */
function open(url: string): void {
  if (!interactive()) return;
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

/** The account the flag names (by id or name), the only one, or the one picked. */
async function pickAccount(cloudflare: Cloudflare, given: string | undefined): Promise<string> {
  const accounts = await cloudflare.list(Accounts.listAccounts.items({}));
  const named = accounts.find((account) => account.id === given || account.name === given);

  if (given !== undefined && !named) throw new Error(`No account ${given}: this login has ${accounts.map((account) => account.name).join(", ")}`);

  if (named) return named.id;

  const [only, ...others] = accounts;

  if (only && others.length === 0) return only.id;

  return ask(undefined, "--account <id or name>", () =>
    select({ message: "Which Cloudflare account?", options: accounts.map((account) => ({ value: account.id, label: account.name })) })
  );
}

/** The Access team domain, waiting for the user to turn Zero Trust on. */
async function zeroTrust(context: Context, cloudflare: Cloudflare, account: string): Promise<string> {
  const url = zeroTrustPage(account);

  for (;;) {
    const team = await teamDomain(cloudflare, account);

    if (team) return team;

    if (!interactive()) throw new Error(`Turn on Zero Trust at ${url} (the free plan is enough), then run \`ky init\` again`);
    context.print(`ky signs you in with Cloudflare Access, part of Zero Trust. Turn it on at ${url} (the free plan is enough).`);
    await ask(undefined, "", () => text({ message: "Press Enter once it's on", defaultValue: "" }));
  }
}

/** This run's login, or in a terminal without one, a pasted token. */
async function signIn(context: Context): Promise<Cloudflare> {
  try {
    return await context.login();
  } catch (error) {
    if (!interactive()) throw error;

    return new Cloudflare(
      await ask(undefined, "", () => password({ message: `Create a Cloudflare API token at ${tokenPage()} and paste it here` })),
      "a pasted token"
    );
  }
}

/** The Access team, with a login that can manage Access: in a terminal, a token pasted when wrangler's can't. */
async function accessLogin(context: Context, cloudflare: Cloudflare, account: string): Promise<{ cloudflare: Cloudflare; team: string }> {
  try {
    return { cloudflare, team: await zeroTrust(context, cloudflare, account) };
  } catch (error) {
    // wrangler's login can deploy Workers but not manage Access; a token for this run can.
    if (!(refused(error) && cloudflare.login === "wrangler login" && interactive())) throw error;

    const token = new Cloudflare(
      await ask(undefined, "", () => password({ message: `wrangler's login can't set up Access. Create a token at ${tokenPage()} and paste it here` })),
      "a pasted token"
    );

    return { cloudflare: token, team: await zeroTrust(context, token, account) };
  }
}

async function ensureSubdomain(cloudflare: Cloudflare, account: string, given: string | undefined): Promise<void> {
  if ((await cloudflare.find(Workers.getSubdomain({ accountId: account }), "SubdomainNotFound"))?.subdomain) return;

  const subdomain = await ask(given, "--subdomain <name>", () =>
    text({ message: "Your workers.dev subdomain (ky lives at <name>.<subdomain>.workers.dev)", validate: (value) => validName(value ?? "") })
  );

  await cloudflare.run(Workers.putSubdomain({ accountId: account, subdomain }));
}

/** The saved value; else the flag's, or the prompt's. A flag that contradicts the saved value is refused. */
async function settle(saved: string | undefined, given: string | undefined, setting: string, file: string, answer: () => Promise<string>): Promise<string> {
  if (saved === undefined) return answer();

  if (given !== undefined && (await answer()) !== saved) throw new Error(`${file} already sets ${setting} to ${saved}; edit it there to change it`);

  return saved;
}

/** The overlay to deploy: what's saved, with what it lacks asked for. */
async function settings(context: Context, saved: Unstable_RawConfig, account: string, flags: InitFlags) {
  const name = await settle(saved.name, flags.name, "name", context.overlay, () =>
    ask(flags.name, "--name <worker>", () =>
      text({ message: "Name the Worker", defaultValue: "ky", placeholder: "ky", validate: (value) => (value ? validName(value) : undefined) })
    )
  );

  const invalid = validName(name);

  if (invalid) throw new Error(`${name}: ${invalid}`);

  const allowed = await settle(emails(saved).join(",") || undefined, flags.email, "ACCESS_EMAILS", context.overlay, () =>
    ask(flags.email, "--email <you@example.com>", () =>
      text({ message: "Your email: Access lets only it in", validate: (value) => (value?.includes("@") ? undefined : "An email address") })
    )
  );

  return overlayFor(saved, account, name, allowed);
}

/**
 * Sets ky up, or picks up where an earlier `ky init` left off: what the overlay already has is
 * kept, and only what it lacks is asked for.
 */
export async function initCommand(context: Context, flags: InitFlags): Promise<number> {
  const saved = (await readOverlay(context.overlay)) ?? {};
  const release = await context.release();
  const signedIn = await signIn(context);
  const account = await settle(saved.account_id, flags.account, "account_id", context.overlay, () => pickAccount(signedIn, flags.account));
  const { cloudflare, team } = await accessLogin(context, signedIn, account);

  context.print(`· Access team: ${team}`);
  await ensureSubdomain(cloudflare, account, flags.subdomain);
  const overlay = await settings(context, saved, account, flags);
  const target = { cloudflare, config: merged(release, overlay), settings: context.overlay };

  try {
    // Refuses a Worker or bucket of this name that ky didn't make, before anything is written.
    await claim(target);
  } catch (error) {
    if (error instanceof NameTaken && !saved.name) throw new Error(`${error.taken}; pick another name: run \`ky init\` again with another --name`);
    throw error;
  }

  await writeOverlay(context.overlay, overlay);
  let deployed: Deployed;

  try {
    deployed = await deploy(target, release, (step) => context.print(`· ${step}`));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nYour settings are saved in ${context.overlay}: run \`ky deploy\` to retry`);
  }

  context.print(`ky is live at ${deployed.url}, behind Access for ${emails(overlay).join(", ")}`);

  if (deployed.token) context.print(`Your KY_TOKEN, shown once (sign in with it): ${deployed.token}`);
  context.print(`Settings: ${context.overlay}`);
  open(deployed.url);

  return 0;
}
