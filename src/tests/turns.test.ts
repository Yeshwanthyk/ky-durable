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
});
