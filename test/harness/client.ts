import { WebSocket as Socket } from "ws";
import type { PiClientMessage, PiServerMessage, TaskRow } from "../../src/protocol.ts";
import { decodeServerFrame } from "../../src/tests/frames.ts";
import { TOKEN } from "./stack.ts";

/**
 * The browser's side of ky, as the CLI harness drives it: a session socket
 * on the user's agent, `me`, with every frame decoded and kept, and each
 * task's status and summary history as the task list showed it.
 */

export type Client = {
  frames: PiServerMessage[];
  send: (message: PiClientMessage) => void;
  /** Send a command and resolve with its result frame; an error frame rejects. */
  command: (message: PiClientMessage) => Promise<Extract<PiServerMessage, { type: "result" }>>;
  /** The task as the newest tasks frame shows it. */
  task: (id: string) => TaskRow | undefined;
  /** Each `status: summary` the task list showed for the task, without repeats. */
  history: (id: string) => string[];
  /** Whether any events frame so far carries `text`. */
  heard: (text: string) => boolean;
  until: (what: string, check: () => boolean, timeoutMs?: number) => Promise<void>;
  close: () => void;
};

class Timeout extends Error {}

export async function until(what: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) throw new Timeout(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function connect(url: string, query = "", token = TOKEN): Promise<Client> {
  const socket = new Socket(`${url.replace(/^http/, "ws")}/agents/pi-agent/me${query}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const frames: PiServerMessage[] = [];
  const histories = new Map<string, string[]>();
  let heardText = "";

  socket.on("message", (data) => {
    const frame = decodeServerFrame(String(data));

    if (frame === undefined) return;
    frames.push(frame);

    if (frame.type === "events") heardText += JSON.stringify(frame.events);

    if (frame.type !== "tasks") return;

    for (const row of frame.tasks) {
      const history = histories.get(row.id) ?? [];
      const entry = `${row.status}: ${row.summary}`;

      if (history.at(-1) !== entry) history.push(entry);
      histories.set(row.id, history);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const latestTasks = () => frames.findLast((frame) => frame.type === "tasks");

  const command: Client["command"] = async (message) => {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ ...message, id }));
    const reply = () => frames.find((frame) => (frame.type === "result" || frame.type === "error") && frame.id === id);
    await until(`a reply to ${message.type}`, () => reply() !== undefined);
    const frame = reply();

    if (frame?.type !== "result") throw new Error(`${message.type} failed: ${frame?.type === "error" ? frame.message : "no reply"}`);

    return frame;
  };

  return {
    frames,
    send: (message) => socket.send(JSON.stringify(message)),
    command,
    task: (id) => {
      const latest = latestTasks();

      return latest?.type === "tasks" ? latest.tasks.find((row) => row.id === id) : undefined;
    },
    history: (id) => histories.get(id) ?? [],
    heard: (text) => heardText.includes(JSON.stringify(text).slice(1, -1)),
    until,
    close: () => socket.close()
  };
}
