/**
 * The machine token pairing gives a runner: all it takes to run work as this machine and read
 * what ky sends it. It is kept in a file only its user can read: ~/.config/ky/runner-token, or
 * KY_RUNNER_TOKEN_FILE. A runner paired before ky kept it there has it in the login Keychain, and
 * runner.json says so: it is read from there, through `security`, until the next `ky runner add`
 * moves it to the file. ky never deletes that item itself; it says how.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TokenStore } from "./settings.ts";
import { kyConfig, type System } from "./system.ts";

/** Where `ky runner add` keeps the token: KY_RUNNER_TOKEN_FILE, else runner-token beside runner.json, on every OS. */
export function tokenStore(system: System, env: NodeJS.ProcessEnv): TokenStore {
  return { file: env.KY_RUNNER_TOKEN_FILE || path.join(kyConfig(system), "runner-token") };
}

/** The command that removes an earlier pairing's Keychain item, which ky leaves for the user to remove. */
export function keychainRemoval(store: TokenStore): string | undefined {
  if ("file" in store) return undefined;

  return `security delete-generic-password -s "${store.keychain.service}" -a "${store.keychain.account}"`;
}

/** Where the token is, as a person reads it. */
export function describeStore(store: TokenStore): string {
  return "file" in store ? store.file : `the Keychain, as "${store.keychain.service}" for ${store.keychain.account}`;
}

/**
 * The machine token in `file`. A file that others can read or write is refused, as ssh refuses
 * such a key.
 */
function readTokenFile(file: string): string {
  let mode: number;

  try {
    mode = statSync(file).mode;
  } catch {
    throw new Error(`No machine token at ${file}. In ky, open Settings, Machines, Add a machine, and run the command it shows.`);
  }

  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} can be read by others (mode ${(mode & 0o777).toString(8)}); run chmod 600 ${file}.`);
  }

  const token = readFileSync(file, "utf8").trim();

  if (token === "") throw new Error(`${file} is empty; pair this machine again.`);

  return token;
}

/** Keep `token` in `file`, readable by this user only; a reader never sees half of it. */
function writeTokenFile(file: string, token: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}`;
  // `mode` applies only to a file the write creates: a file left at this path by a crashed run is gone first, and the chmod sets the mode whatever was there.
  rmSync(next, { force: true });
  writeFileSync(next, `${token}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(next, 0o600);
  renameSync(next, file);
}

/** `security`'s arguments naming the item, quoted for its interactive mode. */
const item = ({ service, account }: { service: string; account: string }) => `-s "${service}" -a "${account}"`;

export async function readToken(system: System, store: TokenStore): Promise<string> {
  if ("file" in store) return readTokenFile(store.file);

  const { service, account } = store.keychain;
  const found = await system.exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);

  if (found.code !== 0 || found.stdout.trim() === "") {
    throw new Error(`No machine token in the Keychain for ${account} (${found.stderr.trim() || `security exited ${found.code}`}). Pair this machine again with \`ky runner add\`.`);
  }

  return found.stdout.trim();
}

/** Keep `token`. The Keychain's is written through `security -i`'s stdin, so it is never in a process's arguments. */
export async function writeToken(system: System, store: TokenStore, token: string): Promise<void> {
  if ("file" in store) {
    writeTokenFile(store.file, token);

    return;
  }

  const added = await system.exec("security", ["-i"], `add-generic-password -U ${item(store.keychain)} -w "${token}"\n`);

  if (added.code !== 0 || added.stderr.trim() !== "") throw new Error(`Couldn't keep the token in the Keychain: ${added.stderr.trim() || `security exited ${added.code}`}`);
}

export async function deleteToken(system: System, store: TokenStore): Promise<void> {
  if ("file" in store) {
    rmSync(store.file, { force: true });

    return;
  }

  await system.exec("security", ["delete-generic-password", "-s", store.keychain.service, "-a", store.keychain.account]);
}
