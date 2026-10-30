import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

/**
 * Starts and stops the local stack (`pnpm stack`, test/stack/vite.config.ts)
 * for the CLI harness and the Playwright suite, on a free port, logging to a
 * file so a failed run can be read afterwards.
 */

export const REPO = path.resolve(import.meta.dirname, "../..");

export type Stack = { url: string; log: string; stop: () => Promise<void> };

/** A TCP port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && address instanceof Object ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once the manifest, which Access lets through signed out, answers 200: that needs the Worker up. */
async function ready(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/manifest.webmanifest`)).status === 200) return;
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The local stack at ${url} never answered GET /manifest.webmanifest`);
}

/**
 * Start the stack, wait until it is ready, and return how to stop it. With `built`, a directory `buildStack`
 * built into, it serves that build as production does (`vite preview`), service worker and all, at `port`.
 */
export async function startStack(log: string, { built, port: given }: { built?: string; port?: number } = {}): Promise<Stack> {
  const port = given ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const out = createWriteStream(log);
  // A preview's root is the build: the Cloudflare plugin finds the Worker it built there (`buildStack`).
  const command = built ? ["preview", built, "--config", "test/stack/vite.config.ts"] : ["dev", "--config", "test/stack/vite.config.ts"];

  const child: ChildProcess = spawn(path.join(REPO, "node_modules/.bin/vite"), command, {
    cwd: REPO,
    env: { ...process.env, KY_STACK_PORT: String(port), ...(built && { KY_STACK_OUT: built }) },
    // Its own process group, so stopping it also stops workerd.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);

    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  };

  try {
    await ready(url);
  } catch (error) {
    await stop();
    throw error;
  }

  return { url, log, stop };
}

/** Where the Cloudflare plugin's build says which Worker it built, under a build's root. */
const DEPLOY_CONFIG = ".wrangler/deploy/config.json";

/**
 * Build the stack into `dir` (absolute, never dist/), as `vite build` builds ky for a deploy, logging to `log`.
 * The plugin notes the Worker it built in the repo's .wrangler/deploy/; that note moves into `dir`, where
 * `startStack(log, { built: dir })` reads it, and the repo's own is put back as it was.
 */
export function buildStack(dir: string, log: string): void {
  const note = path.join(REPO, DEPLOY_CONFIG);
  const before = existsSync(note) ? readFileSync(note, "utf8") : null;

  rmSync(dir, { recursive: true, force: true });

  const built = spawnSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", "test/stack/vite.config.ts"], {
    cwd: REPO,
    env: { ...process.env, KY_STACK_OUT: dir },
    encoding: "utf8"
  });

  writeFileSync(log, `${built.stdout}${built.stderr}`);

  try {
    if (built.status !== 0) throw new Error(`Building the stack failed; see ${log}`);
    mkdirSync(path.join(dir, path.dirname(DEPLOY_CONFIG)), { recursive: true });
    // The Worker's output sits next to the client's, under `dir`.
    writeFileSync(path.join(dir, DEPLOY_CONFIG), JSON.stringify({ configPath: "../../ky_stack/wrangler.json", auxiliaryWorkers: [] }));
  } finally {
    if (before === null) rmSync(note, { force: true });
    else writeFileSync(note, before);
  }
}

/**
 * Empty the output directory `out` and return a ready stack: the one at
 * KY_STACK_URL if set (stopping it is then a no-op), else a new one logging
 * to `out`/stack.log.
 */
export async function useStack(out: string): Promise<Pick<Stack, "url" | "stop">> {
  rmSync(out, { recursive: true, force: true });

  mkdirSync(out, { recursive: true });

  const given = process.env.KY_STACK_URL;

  if (!given) return startStack(path.join(out, "stack.log"));

  await ready(given);

  return { url: given, stop: async () => {} };
}
