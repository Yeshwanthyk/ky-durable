import { describe, expect, it } from "vitest";
import type { PiMessage } from "../transcript";
import { buildTurns } from "../ui/turns";

describe("buildTurns", () => {
  it("keeps a tool's images apart from its text output", () => {
    const messages: PiMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Open the page" }], timestamp: 1 },
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-call", id: "c", name: "browser_screenshot", arguments: {} }],
        timestamp: 2,
        stopReason: "toolUse"
      },
      {
        id: "r",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: "c",
            name: "browser_screenshot",
            content: [
              { type: "text", text: "Took a screenshot" },
              { type: "image", mimeType: "image/png", data: "AAAA" }
            ],
            error: false
          }
        ],
        timestamp: 3
      }
    ];

    const [turn] = buildTurns(messages, null, false, []);
    const tool = turn?.items.find((item) => item.kind === "tool");

    expect(tool).toMatchObject({ output: "Took a screenshot", images: ["data:image/png;base64,AAAA"] });
  });

  it("keeps a finished turn's identity while the next one streams, so its view can skip the render", () => {
    const messages: PiMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "First" }], timestamp: 1 },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done" }], timestamp: 2, stopReason: "stop" },
      { id: "u2", role: "user", parts: [{ type: "text", text: "Second" }], timestamp: 3 }
    ];

    const live = (text: string): PiMessage => ({ id: "live", role: "assistant", parts: [{ type: "text", text }], timestamp: 4 });
    const before = buildTurns(messages, live("Wor"), true, []);
    const after = buildTurns(messages, live("Working"), true, []);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.items).toEqual([{ kind: "text", id: "live:0", text: "Working", final: false }]);
  });
});
