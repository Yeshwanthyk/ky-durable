import type { AgentEvent } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";
import { inside, snapshotView, submit, wait } from "./drive";

/** Watch the root session's events until a run ends: the folded view and the event types. */
function watch(name: string): Promise<{ view: PiSessionView; types: string[] }> {
  return inside(name, async (agent) => {
    const stream = await agent.harness.session().events();
    let view = reduceEvents(EMPTY_VIEW, [stream.snapshot]);
    const types: string[] = ["snapshot"];

    await new Promise<void>((resolve) => {
      stream.start(async (events: readonly AgentEvent[]) => {
        types.push(...events.map((event) => event.type));
        view = reduceEvents(view, events);

        if (events.some((event) => event.type === "run_end")) resolve();
      });
    });

    await stream.stop();

    return { view, types };
  });
}

/**
 * `reduceEvents` folds pi's agent events into this app's view, on the server
 * for a snapshot and in the browser for streamed batches. A client that
 * follows a run and one that joins after it must end up with the same view.
 */
describe("the session view", () => {
  it("folds a run's events into the same view a late joiner gets", async () => {
    const name = crypto.randomUUID();
    const watching = watch(name);
    const receipt = await submit(name, "multiply 5");
    await wait(name, receipt.operationId);
    const { view, types } = await watching;

    for (const type of ["run_start", "tool_execution_start", "tool_execution_end", "run_end"]) {
      expect(types).toContain(type);
    }

    const late = await snapshotView(name);
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
  });
});
