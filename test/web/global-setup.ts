import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { machine } from "../harness/runner.ts";
import { ready, REPO, startStack } from "../harness/stack.ts";

/**
 * Starts the local stack (unless KY_STACK_URL points at one) and a real
 * runner as the machine `webmac`, and returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const out = path.join(REPO, "test-results/web-stack");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const stack = process.env.KY_STACK_URL ? undefined : await startStack(path.join(out, "stack.log"));
  const url = process.env.KY_STACK_URL ?? stack!.url;
  await ready(url);
  process.env.KY_STACK_URL = url;

  const runner = machine("webmac", out).launch(url);

  return async () => {
    await runner.stop();
    await stack?.stop();
  };
}
