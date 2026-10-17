/**
 * `ky login` and `ky logout`: the Cloudflare token `ky deploy`, `ky upgrade` and `ky teardown` sign
 * in with, so a release is one command. `ky login` checks the token has every permission a deploy
 * needs before it keeps it: in the login Keychain on macOS (`ky` runs it only in the user's own
 * terminal, which can unlock it), elsewhere in ~/.config/ky/cloudflare-token, which only the user
 * reads. CLOUDFLARE_API_TOKEN, when set, still comes first (cli/cloudflare.ts).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import { isCancel, password } from "@clack/prompts";
import { Cloudflare, lacks, missingPermissions, tokenPage } from "./cloudflare.ts";
import type { Context } from "./commands.ts";
import { mailAddress, readOverlay } from "./config.ts";
import { bold, cancelled, green, open, output, terminal } from "./output.ts";
import type { TokenStore } from "./runner/settings.ts";
import type { System } from "./runner/system.ts";
import { deleteToken, describeStore, readToken, writeToken } from "./runner/token.ts";

/** What Cloudflare's API tokens are made of; anything else never reaches `security`'s command line. */
const TOKEN = /^[A-Za-z0-9_-]{20,}$/;

/** Where `ky login` keeps the token on this computer: one for every ky here. */
export function cloudflareStore(system: System): TokenStore {
  return system.platform === "darwin"
    ? { keychain: { service: "ky cloudflare", account: system.user } }
    : { file: path.join(system.config, "ky", "cloudflare-token") };
}

/** The token `ky login` kept; undefined when there's none. */
export async function savedToken(system: System): Promise<string | undefined> {
  const store = cloudflareStore(system);

  // A file others can read is refused, not skipped.
  if ("file" in store) return existsSync(store.file) ? readToken(system, store) : undefined;

  return readToken(system, store).catch(() => undefined);
}

/** The token: `given` (piped in), or in a terminal, pasted from the page that makes one. */
async function tokenFrom(given: string | undefined): Promise<string> {
  if (given !== undefined) return given.trim();

  if (!terminal()) throw new Error("Pipe the token in, as `… | ky login`, or run `ky login` in a terminal");
  const page = tokenPage();

  open(page);

  const answer = await password({
    message: `Create a Cloudflare API token at ${page} (opened in your browser) and paste it here`,
    validate: (value) => (value?.trim() ? undefined : "Paste the token")
  });

  if (isCancel(answer)) cancelled();

  return answer.trim();
}

/** The accounts to check the token on, with this ky's mail address: the account it deploys to, else every one the token reaches. */
async function accountsFor(context: Context, cloudflare: Cloudflare): Promise<{ accounts: string[]; mail?: string }> {
  const overlay = await readOverlay(context.overlay).catch(() => undefined);

  if (overlay?.account_id) return { accounts: [overlay.account_id], mail: mailAddress(overlay) };

  return { accounts: (await cloudflare.list(Accounts.listAccounts.items({}))).map((account) => account.id) };
}

/** Checks the token can deploy ky, then keeps it. */
export async function loginCommand(context: Context, given: string | undefined): Promise<number> {
  const out = output(context.print);

  out.intro("ky login");
  const token = await tokenFrom(given);

  if (!TOKEN.test(token)) throw new Error("That isn't a Cloudflare API token: copy it again from the page that showed it");
  const cloudflare = new Cloudflare(token, "a pasted token");

  const missing = await out.waiting("Checking what the token can do", async () => {
    const { accounts, mail } = await accountsFor(context, cloudflare);
    const each = await Promise.all(accounts.map((account) => missingPermissions(cloudflare, account, mail)));

    // Enough when one account has everything; else what the first lacks.
    return each.some((lacks) => lacks.length === 0) ? [] : (each[0] ?? ["Account Settings: Read"]);
  });

  if (missing.length > 0) throw new Error(`${lacks("a pasted token", missing)}. Nothing was saved`);
  const store = cloudflareStore(context.system);

  await writeToken(context.system, store, token);
  out.outro(`${green("Saved")} in ${describeStore(store)}. ${bold("ky deploy")} and ${bold("ky upgrade")} sign in with it`);

  return 0;
}

/** Forgets the token `ky login` kept. */
export async function logoutCommand(context: Context): Promise<number> {
  const store = cloudflareStore(context.system);

  await deleteToken(context.system, store);
  context.print(`Removed the Cloudflare token from ${describeStore(store)}`);

  return 0;
}
