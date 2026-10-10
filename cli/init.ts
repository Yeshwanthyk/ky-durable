/**
 * `ky init`: from a Cloudflare login to ky running behind Access. It signs in, picks the account,
 * makes sure Zero Trust is on, asks for a workers.dev subdomain when the account has none, the
 * Worker's name and the owner's email; then, with every question answered so the slow part runs
 * unattended, it turns the subdomain on, writes the overlay (cli/config.ts) and deploys. Run again,
 * it keeps what the overlay has and asks only for what it lacks, so it's also how `ky doctor` fixes a
 * missing setting.
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
import { bold, cancelled, dim, green, type Output, output, qr, terminal } from "./output.ts";

export type InitFlags = { account?: string; name?: string; email?: string; subdomain?: string };

/** A Worker name whose bucket, `<name>-files`, is a valid bucket name too. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,55}[a-z0-9])?$/;

/** The flag's value, or the prompt's answer in a terminal. */
async function ask(given: string | undefined, flag: string, prompt: () => ReturnType<typeof text>): Promise<string> {
  if (given !== undefined) return given;

  if (!terminal()) throw new Error(`Pass ${flag}`);
  const answer = await prompt();

  if (isCancel(answer)) cancelled();

  return answer;
}

function validName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "Lowercase letters, digits and dashes, at most 57";
}

/** Opens the URL in the browser, when there's one to open it in. */
function open(url: string): void {
  if (!terminal()) return;
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

/** The account the flag names (by id or name), the only one, or the one picked. */
async function pickAccount(out: Output, cloudflare: Cloudflare, given: string | undefined): Promise<string> {
  const accounts = await out.waiting("Reading your Cloudflare accounts", () => cloudflare.list(Accounts.listAccounts.items({})));
  const named = accounts.find((account) => account.id === given || account.name === given);

  if (given !== undefined && !named) throw new Error(`No account ${given}: this login has ${accounts.map((account) => account.name).join(", ")}`);

  const [only, ...others] = accounts;
  const picked = named ?? (only && others.length === 0 ? only : undefined);

  if (picked) {
    out.done(`Cloudflare account ${bold(picked.name)}`);

    return picked.id;
  }

  return ask(undefined, "--account <id or name>", () =>
    select({ message: "Which Cloudflare account?", options: accounts.map((account) => ({ value: account.id, label: account.name })) })
  );
}

/** The Access team domain, waiting for the user to turn Zero Trust on. */
async function zeroTrust(out: Output, cloudflare: Cloudflare, account: string): Promise<string> {
  const url = zeroTrustPage(account);

  for (;;) {
    const team = await out.waiting("Checking Zero Trust", () => teamDomain(cloudflare, account));

    if (team) return team;

    if (!terminal()) throw new Error(`Turn on Zero Trust at ${url} (the free plan is enough), then run \`ky init\` again`);
    out.note("Turn on Zero Trust", ["ky signs you in with Cloudflare Access, part of Zero Trust.", `Turn it on at ${url} (the free plan is enough).`]);
    await ask(undefined, "", () => text({ message: "Press Enter once it's on", defaultValue: "" }));
  }
}

/** This run's login, or in a terminal without one, a pasted token. */
async function signIn(context: Context, out: Output): Promise<Cloudflare> {
  try {
    const cloudflare = await out.waiting("Signing in to Cloudflare", context.login);

    out.done(`Signed in with ${cloudflare.login}`);

    return cloudflare;
  } catch (error) {
    if (!terminal()) throw error;

    return new Cloudflare(
      await ask(undefined, "", () => password({ message: `Create a Cloudflare API token at ${tokenPage()} and paste it here` })),
      "a pasted token"
    );
  }
}

/** The Access team, with a login that can manage Access: in a terminal, a token pasted when wrangler's can't. */
async function accessLogin(out: Output, cloudflare: Cloudflare, account: string): Promise<{ cloudflare: Cloudflare; team: string }> {
  try {
    return { cloudflare, team: await zeroTrust(out, cloudflare, account) };
  } catch (error) {
    // wrangler's login can deploy Workers but not manage Access; a token for this run can.
    if (!(refused(error) && cloudflare.login === "wrangler login" && terminal())) throw error;

    const token = new Cloudflare(
      await ask(undefined, "", () => password({ message: `wrangler's login can't set up Access. Create a token at ${tokenPage()} and paste it here` })),
      "a pasted token"
    );

    return { cloudflare: token, team: await zeroTrust(out, token, account) };
  }
}

/** The account's workers.dev subdomain, or the one to turn on (`missing`) once every question is answered. */
async function subdomainFor(out: Output, cloudflare: Cloudflare, account: string, given: string | undefined): Promise<{ subdomain: string; missing: boolean }> {
  const found = await out.waiting("Reading your workers.dev subdomain", () =>
    cloudflare.find(Workers.getSubdomain({ accountId: account }), "SubdomainNotFound")
  );

  if (found?.subdomain) return { subdomain: found.subdomain, missing: false };

  const subdomain = await ask(given, "--subdomain <name>", () =>
    text({
      message: `Your workers.dev subdomain ${dim("— ky lives at <name>.<subdomain>.workers.dev")}`,
      validate: (value) => validName(value ?? "")
    })
  );

  return { subdomain, missing: true };
}

/** The saved value; else the flag's, or the prompt's. A flag that contradicts the saved value is refused. */
async function settle(saved: string | undefined, given: string | undefined, setting: string, file: string, answer: () => Promise<string>): Promise<string> {
  if (saved === undefined) return answer();

  if (given !== undefined && (await answer()) !== saved) throw new Error(`${file} already sets ${setting} to ${saved}; edit it there to change it`);

  return saved;
}

/** The Worker's name and the overlay to deploy: what's saved, with what it lacks asked for. */
async function settings(context: Context, saved: Unstable_RawConfig, account: string, flags: InitFlags) {
  const name = await settle(saved.name, flags.name, "name", context.overlay, () =>
    ask(flags.name, "--name <worker>", () =>
      text({
        message: `Name the Worker ${dim("— its address starts with it")}`,
        defaultValue: "ky",
        placeholder: "ky",
        validate: (value) => (value ? validName(value) : undefined)
      })
    )
  );

  const invalid = validName(name);

  if (invalid) throw new Error(`${name}: ${invalid}`);

  const allowed = await settle(emails(saved).join(",") || undefined, flags.email, "ACCESS_EMAILS", context.overlay, () =>
    ask(flags.email, "--email <you@example.com>", () =>
      text({
        message: `Your email ${dim("— the only one Cloudflare Access lets in")}`,
        validate: (value) => (value?.includes("@") ? undefined : "An email address")
      })
    )
  );

  return { name, overlay: overlayFor(saved, account, name, allowed) };
}

/** A setting for the summary, marked when it was already in the overlay. */
function setting(label: string, value: string, saved: boolean): string {
  return `${dim(label.padEnd(7))} ${value}${saved ? dim("  (saved)") : ""}`;
}

/**
 * Sets ky up, or picks up where an earlier `ky init` left off: what the overlay already has is
 * kept, and only what it lacks is asked for.
 */
export async function initCommand(context: Context, flags: InitFlags): Promise<number> {
  const out = output(context.print);
  const saved = (await readOverlay(context.overlay)) ?? {};

  out.intro("your own durable agent, on your Cloudflare account", true);
  const release = await context.release();
  const signedIn = await signIn(context, out);
  const account = await settle(saved.account_id, flags.account, "account_id", context.overlay, () => pickAccount(out, signedIn, flags.account));
  const { cloudflare, team } = await accessLogin(out, signedIn, account);

  out.done(`Access team: ${team}`);
  const { subdomain, missing } = await subdomainFor(out, cloudflare, account, flags.subdomain);
  const { name, overlay } = await settings(context, saved, account, flags);
  const target = { cloudflare, config: merged(release, overlay), settings: context.overlay };
  const allowed = emails(overlay).join(", ");

  out.note("Ready to deploy", [
    setting("Worker", name, Boolean(saved.name)),
    setting("Release", release.version, false),
    setting("Address", `https://${name}.${subdomain}.workers.dev`, false),
    setting("Access", allowed, emails(saved).length > 0)
  ]);

  const deployed: Deployed = await out.steps(`Stopped. Run \`ky init\` again to pick up where it left off.`, async (say) => {
    if (missing) {
      say(`Turning on ${subdomain}.workers.dev`);
      await cloudflare.run(Workers.putSubdomain({ accountId: account, subdomain }));
    }

    say("Checking the names are free");

    try {
      // Refuses a Worker or bucket of this name that ky didn't make, before anything is written.
      await claim(target);
    } catch (error) {
      if (error instanceof NameTaken && !saved.name) throw new Error(`${error.taken}; pick another name: run \`ky init\` again with another --name`);
      throw error;
    }

    await writeOverlay(context.overlay, overlay);

    try {
      return await deploy(target, release, say);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nYour settings are saved in ${context.overlay}: run \`ky deploy\` to retry`);
    }
  });

  if (deployed.token) out.note("Your KY_TOKEN, shown once (sign in with it)", [deployed.token]);

  if (terminal()) out.note("Scan to open it on your phone", [qr(deployed.url)]);
  out.outro(`${green("ky is live")} at ${bold(deployed.url)}, behind Access for ${allowed}`);
  context.print(dim(`Settings: ${context.overlay}`));
  open(deployed.url);

  return 0;
}
