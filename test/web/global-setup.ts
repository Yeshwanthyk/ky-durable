import path from "node:path";
import { machine } from "../harness/runner.ts";
import { REPO, useStack } from "../harness/stack.ts";

/**
 * Starts the local stack (unless KY_STACK_URL points at one) and a real
 * runner as the machine `webmac`, and returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const out = path.join(REPO, "test-results/web-stack");
  const stack = await useStack(out);

  process.env.KY_STACK_URL = stack.url;

  const runner = machine("webmac", out).launch(stack.url);

  return async () => {
    await runner.stop();
    await stack.stop();
  };
}
