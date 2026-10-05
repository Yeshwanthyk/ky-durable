import { describe, expect, it } from "vitest";
import type { PiMessage } from "../transcript";
import { currentActivity, describeTool } from "../ui/activity";

const assistant = (parts: PiMessage["parts"], id = "live"): PiMessage => ({
  id,
  role: "assistant",
  parts,
  timestamp: 0
});

const idle = { running: true, live: null, tools: [], messages: [] };

/** The activity island says what the agent is doing in a few words. */
describe("the activity island's status", () => {
  it("is empty while the agent is idle", () => {
    expect(currentActivity({ ...idle, running: false })).toBeNull();
  });

  it("thinks until something streams", () => {
    expect(currentActivity(idle)?.label).toBe("Thinking…");
    expect(currentActivity({ ...idle, live: assistant([{ type: "thinking", text: "hmm" }]) })?.label).toBe(
      "Thinking…"
    );
  });

  it("writes the reply once text streams", () => {
    expect(currentActivity({ ...idle, live: assistant([{ type: "text", text: "Sure" }]) })?.label).toBe(
      "Writing reply"
    );
  });

  it("follows the newest tool call in the streaming message", () => {
    const live = assistant([
      { type: "text", text: "On it." },
      { type: "tool-call", id: "c1", name: "subagent", arguments: { action: "spawn", name: "researcher" } }
    ]);
    expect(currentActivity({ ...idle, live })?.label).toBe("Delegating to researcher");
  });

  it("finds a running tool's arguments in the transcript", () => {
    const messages = [
      assistant(
        [{ type: "tool-call", id: "c2", name: "machine", arguments: { action: "run", title: "Top HN stories" } }],
        "e1"
      )
    ];
    const tools = [{ callId: "c2", name: "machine", output: "" }];
    expect(currentActivity({ ...idle, messages, tools })?.label).toBe("Running machine task: Top HN stories");
  });

  it("names Executor apps from the program", () => {
    expect(describeTool("executor_execute", { code: "return await tools.exa.search({ query: 'x' })" }).label).toBe(
      "Searching the web"
    );
    expect(describeTool("executor_execute", { code: "await tools.gmail.list_messages({})" }).label).toBe(
      "Checking Gmail"
    );
    expect(describeTool("executor_execute", { code: "return tools.search({ query: 'mail' })" }).label).toBe(
      "Finding the right tool"
    );
  });

  it("maps memory and falls back to the tool's name", () => {
    expect(describeTool("memory_note", { text: "x" }).label).toBe("Saving memory");
    expect(describeTool("weather_lookup").label).toBe("weather_lookup");
  });
});
