import { env } from "cloudflare:workers";
import type { UserInput } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_CHARS, MAX_IMAGES } from "../images";
import type { PiServerMessage } from "../protocol";

const image = (data = "iVBORw0KGgo=", mimeType = "image/png") => ({ type: "image" as const, data, mimeType });

/** Submit one input on a fresh object's main session; the error it got, or null when it was taken. */
async function submit(input: UserInput): Promise<string | null> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/pi-harness-test/${crypto.randomUUID()}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );

  const socket = response!.webSocket!;
  socket.accept();

  const answer = new Promise<string | null>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) return;

      const message: PiServerMessage = JSON.parse(event.data);

      if (message.type === "error" && message.id === "s1") resolve(message.message);

      if (message.type === "result" && message.id === "s1") resolve(null);
    });
  });

  socket.send(JSON.stringify({ type: "submit", id: "s1", input }));
  const result = await answer;
  socket.close();

  return result;
}

describe("the images a message carries", () => {
  it("lets text through, with or without images", async () => {
    expect(await submit("hello")).toBeNull();
    expect(await submit([image(), { type: "text", text: "what is this?" }])).toBeNull();
  });

  it("refuses too many, too large, or the wrong kind of image", async () => {
    expect(await submit(Array.from({ length: MAX_IMAGES + 1 }, () => image()))).toMatch(/at most/);
    expect(await submit([image("a".repeat(MAX_IMAGE_CHARS + 4))])).toMatch(/too large/);
    expect(await submit([image("aGk=", "image/svg+xml")])).toMatch(/JPEG, PNG/);
    expect(await submit([image("not base64!")])).toMatch(/base64/);
  });

  it("refuses an empty message, or more than one text part", async () => {
    expect(await submit([])).toMatch(/one text part/);
    expect(
      await submit([
        { type: "text", text: "a" },
        { type: "text", text: "b" }
      ])
    ).toMatch(/one text part/);
  });
});
