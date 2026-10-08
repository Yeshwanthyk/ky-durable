import path from "node:path";
import { machine, pairingCode } from "../harness/runner.ts";
import { REPO, useStack } from "../harness/stack.ts";

/**
 * Starts the local stack (unless KY_STACK_URL points at one) and a real
 * runner as the machine `webmac`, paired as the user pairs one, and returns
 * the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const out = path.join(REPO, "test-results/web-stack");
  const stack = await useStack(out);

  process.env.KY_STACK_URL = stack.url;

  const webmac = machine("webmac", out);
  const paired = await webmac.pair(stack.url, await pairingCode(stack.url));

  if (paired.code !== 0) throw new Error(`webmac did not pair: ${paired.output}`);
  const runner = webmac.launch(stack.url);

  return async () => {
    await runner.stop();
    await stack.stop();
  };
}
