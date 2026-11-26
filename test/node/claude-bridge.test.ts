import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { overage } from "../../cli/runner/claude-guard.ts";
import { billed, remoteClaudeApi } from "../../src/providers/claude/remote.ts";
import { CLAUDE_BILLING, CLAUDE_MODELS, type ClaudeLine, emptyAnswer } from "../../src/providers/claude/wire.ts";

const model = CLAUDE_MODELS.find((each) => each.id === "claude-haiku-4-5") ?? CLAUDE_MODELS[0]!;

function ndjson(lines: readonly ClaudeLine[]): Response {
  const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

describe("Claude bridge guard", () => {
  it("detects overage rate_limit_event lines and ignores normal output", () => {
    expect(Option.isNone(overage('{"type":"assistant","message":{}}'))).toBe(true);
    expect(Option.isNone(overage('{"type":"rate_limit_event","rate_limit_info":{"isUsingOverage":false}}'))).toBe(true);

    const hit1 = overage('{"type":"rate_limit_event","rate_limit_info":{"isUsingOverage":true,"resetsAt":1700000000}}');

    expect(Option.isSome(hit1)).toBe(true);

    if (Option.isSome(hit1)) expect(hit1.value.resetsAt).toBe(1_700_000_000);

    const hit2 = overage('{"type":"rate_limit_event","rate_limit_info":{"overageInUse":true}}');

    expect(Option.isSome(hit2)).toBe(true);
  });
});

describe("remoteClaudeApi", () => {
  it("streams text and tool calls over NDJSON, ignoring alive heartbeats", async () => {
    let sentBody = "";

    const finalMessage = {
      ...emptyAnswer(model, "stop"),
      content: [
        { type: "text" as const, text: "Hello world" },
        { type: "toolCall" as const, id: "call_1", name: "lookup", arguments: { q: "ky" } }
      ]
    };

    const api = remoteClaudeApi(async (input, init) => {
      sentBody = await new Request(input, init).text();

      return ndjson([
        { type: "alive" },
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Hello " },
        { type: "alive" },
        { type: "text_delta", contentIndex: 0, delta: "world" },
        { type: "text_end", contentIndex: 0, content: "Hello world" },
        { type: "toolcall_start", contentIndex: 1, id: "call_1", name: "lookup" },
        { type: "toolcall_delta", contentIndex: 1, delta: '{"q":"ky"}' },
        { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "ky" } } },
        { type: "done", reason: "stop", message: finalMessage }
      ]);
    });

    const stream = api.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }), { apiKey: "sk-ant-oat-test" });
    const events = [];

    for await (const event of stream) events.push(event.type);
    const result = await stream.result();

    expect(events).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done"
    ]);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual(finalMessage.content);
    expect(JSON.parse(sentBody)).toMatchObject({ model: { id: model.id }, options: { apiKey: "sk-ant-oat-test" } });
  });

  it("rewrites usage-credit billing errors and handles non-200 responses", async () => {
    expect(billed("Third-party apps now draw from your extra usage.")).toContain(CLAUDE_BILLING);
    expect(billed("regular error")).toBe("regular error");

    const api = remoteClaudeApi(async () => new Response("bridge unavailable", { status: 503 }));
    const stream = api.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }), { apiKey: "sk-ant-oat-test" });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("503 bridge unavailable");
  });
});
