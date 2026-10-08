/**
 * `ky init`: from a Cloudflare login to ky running behind Access. It signs in, picks the account,
 * makes sure Zero Trust and a workers.dev subdomain are on, asks for the Worker's name and the
 * owner's email, writes the overlay (cli/config.ts) and deploys.
 *
 * Each answer can come as a flag instead; without a terminal, as when an agent runs it, a missing
 * one is an error that names its flag.
 */
import { execFile } from "node:child_process";
import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { isCancel, password, select, text } from "@clack/prompts";
import { Cloudflare, CloudflareError, tokenPage } from "./cloudflare.ts";
import type { Context } from "./commands.ts";
import { merged, overlayFor, readOverlay, writeOverlay } from "./config.ts";
import { deploy, deployedRelease, teamDomain } from "./deployer.ts";

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
  const url = `https://one.dash.cloudflare.com/${account}`;

  for (;;) {
    const team = await teamDomain(cloudflare, account);

    if (team) return team;

    if (!interactive()) throw new Error(`Turn on Zero Trust at ${url} (the free plan is enough), then run \`ky init\` again`);
    context.print(`ky signs you in with Cloudflare Access, part of Zero Trust. Turn it on at ${url} (the free plan is enough).`);
    await ask(undefined, "", () => text({ message: "Press Enter once it's on", defaultValue: "" }));
  }
}

export async function initCommand(context: Context, flags: InitFlags): Promise<number> {
  if (await readOverlay(context.overlay)) throw new Error(`ky is already set up (${context.overlay}); run \`ky deploy\`, or \`ky teardown\` first`);
  const release = await context.release();
  let cloudflare: Cloudflare;

  try {
    cloudflare = await context.login();
  } catch (error) {
    if (!interactive()) throw error;
    cloudflare = new Cloudflare(
      await ask(undefined, "", () => password({ message: `Create a Cloudflare API token at ${tokenPage()} and paste it here` })),
      "a pasted token"
    );
  }

  const account = await pickAccount(cloudflare, flags.account);
  let team: string;

  try {
    team = await zeroTrust(context, cloudflare, account);
  } catch (error) {
    // wrangler's login can deploy Workers but not manage Access; a token for this run can.
    if (!(error instanceof CloudflareError && error.tag === "Forbidden" && cloudflare.login === "wrangler login" && interactive())) throw error;
    cloudflare = new Cloudflare(
      await ask(undefined, "", () => password({ message: `wrangler's login can't set up Access. Create a token at ${tokenPage()} and paste it here` })),
      "a pasted token"
    );
    team = await zeroTrust(context, cloudflare, account);
  }

  context.print(`· Access team: ${team}`);

  if (!(await cloudflare.find(Workers.getSubdomain({ accountId: account }), "SubdomainNotFound"))?.subdomain) {
    const subdomain = await ask(flags.subdomain, "--subdomain <name>", () =>
      text({ message: "Your workers.dev subdomain (ky lives at <name>.<subdomain>.workers.dev)", validate: (value) => validName(value ?? "") })
    );

    await cloudflare.run(Workers.putSubdomain({ accountId: account, subdomain }));
  }

  const name = await ask(flags.name, "--name <worker>", () =>
    text({ message: "Name the Worker", defaultValue: "ky", placeholder: "ky", validate: (value) => (value ? validName(value) : undefined) })
  );

  const invalid = validName(name);

  if (invalid) throw new Error(`${name}: ${invalid}`);

  const email = await ask(flags.email, "--email <you@example.com>", () =>
    text({ message: "Your email: Access lets only it in", validate: (value) => (value?.includes("@") ? undefined : "An email address") })
  );

  const overlay = overlayFor(account, name, [email]);
  const target = { cloudflare, config: merged(release, overlay) };

  // Refuses a Worker of this name that ky didn't deploy, before anything is written.
  await deployedRelease(target);
  await writeOverlay(context.overlay, overlay);
  const deployed = await deploy(target, release, (step) => context.print(`· ${step}`));

  context.print(`ky is live at ${deployed.url}, behind Access for ${email}`);

  if (deployed.token) context.print(`Your KY_TOKEN, shown once (sign in with it): ${deployed.token}`);
  context.print(`Settings: ${context.overlay}`);
  open(deployed.url);

  return 0;
}
