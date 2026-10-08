/**
 * Who a runner is to ky: its machine's name, and the machine token pairing
 * gave it, kept in a file only its user can read. runner/pair.ts writes the
 * token; runner/ky-runner.ts reads it.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

/** This machine's name in ky: KY_MACHINE, else the host's name, as a runner path allows it. */
export function machineName(): string {
  return (process.env.KY_MACHINE ?? hostname().split(".")[0]!)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 32);
}

/** Where the machine token is kept: KY_RUNNER_TOKEN_FILE, else ~/.config/ky/runner-token. */
export function tokenFile(): string {
  return process.env.KY_RUNNER_TOKEN_FILE ?? join(homedir(), ".config", "ky", "runner-token");
}

/**
 * The machine token in `file`. A file that others can read or write is
 * refused, as ssh refuses such a key: the token is all it takes to run
 * work as this machine and read what ky sends it.
 */
export function readToken(file: string): string {
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
export function writeToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}`;
  writeFileSync(next, `${token}\n`, { mode: 0o600 });
  renameSync(next, file);
}
