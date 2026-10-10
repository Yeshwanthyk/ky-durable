/**
 * The machine token pairing gives a runner: all it takes to run work as this machine and read
 * what ky sends it. On macOS it is kept in the login Keychain, through `security`; elsewhere, or
 * with KY_RUNNER_TOKEN_FILE, in a file only its user can read.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TokenStore } from "./settings.ts";
import type { System } from "./system.ts";

/** The Keychain item's service; its account is the machine and ky's host. */
const SERVICE = "ky runner";

/** Where `ky runner add` keeps the token of `name` paired with `url`. */
export function tokenStore(system: System, name: string, url: string, env: NodeJS.ProcessEnv): TokenStore {
  if (env.KY_RUNNER_TOKEN_FILE) return { file: env.KY_RUNNER_TOKEN_FILE };

  if (system.platform === "darwin") return { keychain: { service: SERVICE, account: `${name}@${new URL(url).host}` } };

  return { file: path.join(system.config, "ky", "runner-token") };
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
