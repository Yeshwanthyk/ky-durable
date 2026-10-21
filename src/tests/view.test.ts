import type { AgentEvent } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";
import { inside, snapshotView, submit, wait } from "./drive";

/**
 * Watch the root session's events until a run ends: the folded view and the
 * event types. `subscribed` settles once the watcher listens, so a run
 * submitted after it is seen from its start.
 */
type Watch = { subscribed: Promise<void>; done: Promise<{ view: PiSessionView; types: string[]; drafts: string[] }> };

function watch(name: string): Watch {
  let listening = () => {};

  const subscribed = new Promise<void>((resolve) => {
    listening = resolve;
  });

  const done = inside(name, async (agent) => {
    const stream = await agent.harness.session().events();
    let view = reduceEvents(EMPTY_VIEW, [stream.snapshot]);
    const types: string[] = ["snapshot"];
    // A streaming tool call's arguments after each batch, as the page would draw them.
    const drafts: string[] = [];

    await new Promise<void>((resolve) => {
      stream.start(async (events: readonly AgentEvent[]) => {
        types.push(...events.map((event) => event.type));
        view = reduceEvents(view, events);
        const call = view.live?.parts.find((part) => part.type === "tool-call");

        if (call?.type === "tool-call") drafts.push(JSON.stringify(call.arguments));

        if (events.some((event) => event.type === "run_end")) resolve();
      });

      listening();
    });

    await stream.stop();

    return { view, types, drafts };
  });

  return { subscribed, done };
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

    await watching.subscribed;

    const receipt = await submit(name, "multiply 5");

    await wait(name, receipt.operationId);

    const { view, types } = await watching.done;

    for (const type of ["run_start", "tool_execution_start", "tool_execution_end", "run_end"]) {
      expect(types).toContain(type);
    }

    const late = await snapshotView(name);
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
  });

  it("grows a tool call's arguments as they stream, ending on the call that ran", async () => {
    const name = crypto.randomUUID();
    const watching = watch(name);
    const args = { title: "Trip", blocks: [{ type: "status", text: "Booking the flights to Lisbon for Friday", tone: "info" }] };

    await watching.subscribed;
    await wait(name, (await submit(name, `slowly tool ui ${JSON.stringify(args)}`)).operationId);

    const { view, drafts } = await watching.done;
    const texts = drafts.flatMap((draft) => /"text":"([^"]*)/.exec(draft)?.[1] ?? []);

    expect(texts.some((text) => text.length > 0 && text.length < args.blocks[0]!.text.length)).toBe(true);
    expect(texts.every((text) => args.blocks[0]!.text.startsWith(text))).toBe(true);
    expect(view.messages.flatMap((message) => message.parts).find((part) => part.type === "tool-call")).toMatchObject({ name: "ui", arguments: args });
  });
});
