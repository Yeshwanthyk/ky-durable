/**
 * Records the frames the main chat's socket sends on the local stack (`pnpm stack`), so the Mac app's
 * protocol tests replay what the Worker really sends. Signs in as the stack's fake Access does, opens
 * the main chat, sends one message and writes every frame, one JSON per line, until the run ends.
 *
 *   node --experimental-strip-types apps/mac/scripts/record-frames.ts [out.jsonl] [message]
 */
import { writeFileSync } from "node:fs";
import Type, { type Static } from "typebox";
import { parseAs } from "../../../src/core/decode.ts";
import { accessCookie } from "../../../src/tests/fake-access.ts";

const BASE = process.env.KY_STACK_URL ?? "http://127.0.0.1:8790";

const out = process.argv[2] ?? "apps/mac/fixtures/main-chat.jsonl";

const message = process.argv[3] ?? "Say hello in two short paragraphs, with one bullet list.";

const Frame = Type.Object({
  type: Type.String(),
  events: Type.Optional(Type.Array(Type.Object({ type: Type.String() }))),
});

const cookie = await accessCookie(BASE);

const url = `${BASE.replace(/^http/, "ws")}/agents/pi-agent/me?session=1`;

// SAFETY: Node's WebSocket (undici) reads `headers` from its options; the DOM type lists protocols only.
const socket = new WebSocket(url, { headers: { Cookie: `${cookie.name}=${cookie.value}` } } as never);

const frames: string[] = [];

let sent = false;

type Frame = Static<typeof Frame>;

/** The first hello opens the run: send the message, once. */
function greet(frame: Frame): void {
  if (frame.type !== "hello" || sent) return;

  sent = true;
  socket.send(JSON.stringify({ type: "submit", input: message, operationId: crypto.randomUUID() }));
}

function ended(frame: Frame): boolean {
  return sent && frame.type === "events" && (frame.events ?? []).some((e) => e.type === "run_end");
}

/** Records one frame; answers whether the run it started has ended. */
function take(text: string): boolean {
  frames.push(text);

  if (text === "pong") return false;

  const frame = parseAs(Frame, text, "a socket frame");

  greet(frame);

  return ended(frame);
}

const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no run_end after 60 s; ${frames.length} frames`)), 60_000);

  socket.addEventListener("message", (event) => {
    if (!take(String(event.data))) return;

    clearTimeout(timer);
    resolve();
  });

  socket.addEventListener("error", () => reject(new Error(`socket error at ${url}`)));
});

await done;

socket.close();

writeFileSync(out, `${frames.join("\n")}\n`);

console.log(`${frames.length} frames → ${out}`);
