import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

/**
 * Starts and stops the local stack (`pnpm stack`, test/stack/vite.config.ts)
 * for the CLI harness and the Playwright suite, on a free port, logging to a
 * file so a failed run can be read afterwards.
 */

export const REPO = path.resolve(import.meta.dirname, "../..");

export const TOKEN = "ky-stack-token";

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

/** Resolves once `GET /login` answers 200, which needs the Worker up. */
export async function ready(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/login`)).status === 200) return;
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The local stack at ${url} never answered GET /login`);
}

/** Start the stack, wait until it is ready, and return how to stop it. */
export async function startStack(log: string): Promise<Stack> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const out = createWriteStream(log);

  const child: ChildProcess = spawn(path.join(REPO, "node_modules/.bin/vite"), ["dev", "--config", "test/stack/vite.config.ts"], {
    cwd: REPO,
    env: { ...process.env, KY_STACK_PORT: String(port) },
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
