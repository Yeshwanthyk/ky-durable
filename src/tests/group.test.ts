import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { RESPONDER_CAP } from "../peers/contract";
import { forThem, parseRoute, plan, recentOf, ROUTER_PROMPT, routerInput } from "../peers/group";
import type { PiClientMessage, PiServerMessage } from "../protocol";
import type { SpecialistRow } from "../skills/contract";
import { type PiMessage, projectEntry, SPECIALIST_REPLY, TO_SPECIALISTS } from "../transcript";
import { connect, follow, type Follower, inside, snapshotView, taskChats, until } from "./drive";
import { decodeNewChat } from "./frames";

/** @-mentions and group chats: who answers a user's message, and the specialists' own replies in the chat. */

type Frame<T extends PiServerMessage["type"]> = Extract<PiServerMessage, { type: T }>;

const row = (id: string): SpecialistRow => ({ id, description: `The ${id}.`, model: null, machine: null, session: null, created_at: 0 });

const never = async (): Promise<string[]> => {
  throw new Error("routed");
};

describe("who answers a message", () => {
  it("is the specialists it starts by @-ing, once each, without routing", async () => {
    expect(await plan("@eng @design what now", [], never)).toEqual({ to: ["eng", "design"] });
    expect(await plan("  @eng @eng hi", [row("a")], never)).toEqual({ to: ["eng"] });
    // Only a leading @ counts; one inside the text is just text.
    expect(await plan("ask @eng about it", [], never)).toEqual({ to: [] });
    expect(await plan("email@eng.com", [], never)).toEqual({ to: [] });
  });

  it(`refuses more than ${RESPONDER_CAP} @'d specialists`, async () => {
    expect(await plan("@a @b @c @d hi", [], never)).toEqual({ refused: `At most ${RESPONDER_CAP} specialists can answer one message.` });
  });

  it("is ky in a chat with no members, without routing", async () => {
    expect(await plan("hello", [], never)).toEqual({ to: [] });
  });

  it(`is at most ${RESPONDER_CAP} members the router picks, and only members`, async () => {
    const members = ["a", "b", "c", "d"].map(row);
    expect(await plan("big question", members, async () => ["a", "b", "c", "d"])).toEqual({ to: ["a", "b", "c"] });
    expect(await plan("question", members, async () => ["d", "nobody", "d"])).toEqual({ to: ["d"] });
    expect(await plan("thanks!", members, async () => [])).toEqual({ to: [] });
  });

  it("reads the router's answer leniently", () => {
    const members = ["eng", "design", "data-sci"].map(row);
    expect(parseRoute("eng, design", members)).toEqual(["eng", "design"]);
    expect(parseRoute("@data-sci and @eng", members)).toEqual(["data-sci", "eng"]);
    expect(parseRoute("none", members)).toEqual([]);
    expect(parseRoute("Engineering? No: ENG.", members)).toEqual(["eng"]);
  });

  it("gives the router each member's description and the message", () => {
    expect(ROUTER_PROMPT).toContain(`at most ${RESPONDER_CAP}`);
    expect(routerInput([row("eng")], "user: hi", "fix it")).toBe("Specialists:\n- eng: The eng.\n\nRecent chat:\nuser: hi\n\nMessage:\nfix it");
  });
});

describe("the chat a specialist sees", () => {
  const message = (role: PiMessage["role"], text: string, extra: Partial<PiMessage> = {}): PiMessage => ({
    id: crypto.randomUUID(),
    role,
    parts: [{ type: "text", text }],
    timestamp: 0,
    ...extra
  });

  it("is the user, ky's answers and specialists' replies, without reports or failures", () => {
    const recent = recentOf([
      message("user", "first"),
      message("assistant", "calling a tool", { stopReason: "toolUse" }),
      message("assistant", "ky's answer", { stopReason: "stop" }),
      message("user", "[subagent x answered, no reply needed] noise"),
      message("specialist", "use postgres", { from: "eng" }),
      message("specialist", "Stopped.", { from: "design", error: "Stopped." })
    ]);

    expect(recent).toBe("user: first\nky: ky's answer\n@eng: use postgres");
  });

  it("marks the user's message for ky, and shows it without the mark", () => {
    const input = forThem("hello all", ["a", "b"]);
    expect(input).toBe("[for @a, @b] hello all");

    // SAFETY: a test record; the branded ids are only compared, never resolved against a store.
    const entry: EntryRecord = {
      id: 7 as EntryId,
      conversationId: 1 as EntryRecord["conversationId"],
      kind: TO_SPECIALISTS,
      data: { to: ["a", "b"] },
      model: [{ role: "user", content: input, timestamp: 1 }]
    };

    expect(projectEntry(entry)).toMatchObject({ role: "user", to: ["a", "b"], parts: [{ type: "text", text: "hello all" }] });

    const reply: EntryRecord = {
      ...entry,
      kind: SPECIALIST_REPLY,
      data: { specialist: "a", text: "hi!", failed: false },
      model: [{ role: "user", content: "[@a replied to the user] hi!", timestamp: 2 }]
    };

    expect(projectEntry(reply)).toEqual({ id: "7", role: "specialist", from: "a", parts: [{ type: "text", text: "hi!" }], timestamp: 2 });
  });
});

/** Make specialists straight in storage, as the user's panel does. */
const make = (name: string, ...ids: string[]) =>
  inside(name, (instance) => {
    for (const id of ids) instance.specialists.create(id, { description: `The ${id}.`, brief: `Be a good ${id}.` }, "user");
  });

async function open(name: string, query = ""): Promise<{ socket: WebSocket; client: Follower }> {
  const socket = await connect(name, query);
  const client = follow(socket);
  await client.until(() => client.frames.some((frame) => frame.type === "events"));

  return { socket, client };
}

async function command(socket: WebSocket, client: Follower, message: PiClientMessage): Promise<Frame<"result"> | Frame<"error">> {
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ ...message, id }));

  const answer = () =>
    client.frames.find(
      (frame): frame is Frame<"result"> | Frame<"error"> => (frame.type === "result" || frame.type === "error") && frame.id === id
    );

  await client.until(() => answer() !== undefined);

  return answer()!;
}

const submit = (socket: WebSocket, client: Follower, input: string, operationId = crypto.randomUUID()) =>
  command(socket, client, { type: "submit", input, operationId, whenBusy: "followUp" });

/** The chat's specialist replies, as `@id: text`. */
async function replies(name: string, session?: string): Promise<string[]> {
  const view = await snapshotView(name, session);

  return view.messages.flatMap((message) =>
    message.role === "specialist" ? [`@${message.from}: ${message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}`] : []
  );
}

/** Requests whose system prompt starts with the router's. */
const routings = (name: string) =>
  inside(name, (instance) => instance.boundary.calls.filter((each) => each.system.startsWith("You pick which specialists")).length);

/** Requests ky's main agent made: the ones with the specialist roster in their prompt. */
const kyRuns = (name: string) => inside(name, (instance) => instance.boundary.calls.filter((each) => each.system.includes("Specialists:\n- @")).length);

const roles = async (name: string, session?: string) => (await snapshotView(name, session)).messages.map((message) => message.role);

describe("specialists in chat", () => {
  it("posts an @'d specialist's own reply, and ky does not run", async () => {
    const name = crypto.randomUUID();
    await make(name, "eng");
    const { socket, client } = await open(name);

    expect(await submit(socket, client, "@eng is the build green?")).toMatchObject({ type: "result", result: { to: ["eng"] } });
    await until(async () => (await replies(name)).length === 1, "@eng's reply");

    expect(await replies(name)).toEqual(["@eng: echo: @eng is the build green?"]);
    expect(await roles(name)).toEqual(["user", "specialist"]);
    expect(await kyRuns(name)).toBe(0);
    expect(await routings(name)).toBe(0);
    // Its reply is a task for this chat, so the chat's topbar can show it working.
    expect(await taskChats(name)).toContainEqual({ worker: "@eng", chat: "1" });

    // ky's next run reads past both passive entries and answers only its own message.
    await submit(socket, client, "thanks ky");
    await until(async () => (await roles(name)).includes("assistant"), "ky's answer");
    expect(await roles(name)).toEqual(["user", "specialist", "user", "assistant"]);
    expect(await kyRuns(name)).toBe(1);
    socket.close();
  });

  it("has each @'d specialist reply, in its own seat that cannot ask others", async () => {
    const name = crypto.randomUUID();
    await make(name, "a", "b");
    const { socket, client } = await open(name);
    const ask = JSON.stringify({ action: "ask", specialist: "b", message: "go on" });

    await submit(socket, client, `@a @b\na> tool subagent ${ask}\nb> on it`);
    await until(async () => (await replies(name)).length === 2, "both replies");

    const said = await replies(name);
    expect(said).toContainEqual("@b: on it");
    // A seat has no subagent tool at all; the hook blocks it besides, should it ever come back.
    expect(said.find((each) => each.startsWith("@a:"))).toContain("Tool subagent is not available");
    // Neither a home conversation nor a consult was made: no specialist reached another.
    expect(await inside(name, (instance) => [instance.specialists.get("a")?.session, instance.specialists.get("b")?.session])).toEqual([null, null]);
    socket.close();
  });

  it(`routes a group chat's message to at most ${RESPONDER_CAP} members, once, and never on their replies`, async () => {
    const name = crypto.randomUUID();
    await make(name, "a", "b", "c", "d");
    const { socket, client } = await open(name);
    expect(await command(socket, client, { type: "chat-members", session: "1", members: ["a", "b", "c", "d"] })).toMatchObject({ type: "result" });
    await client.until(() => client.frames.some((frame) => frame.type === "chats" && frame.groups?.["1"]?.length === 4));

    expect(await submit(socket, client, "route: d, c, b, a\nwhat do you all think?")).toMatchObject({ result: { to: ["d", "c", "b"] } });
    await until(async () => (await replies(name)).length === 3, "three replies");
    // Give a fourth reply, or a routing pass on a reply, time to show.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await replies(name)).map((each) => each.split(":")[0]).sort()).toEqual(["@b", "@c", "@d"]);
    expect(await routings(name)).toBe(1);
    expect(await kyRuns(name)).toBe(0);
    socket.close();
  });

  it("lets ky answer a group chat's message no member fits", async () => {
    const name = crypto.randomUUID();
    await make(name, "a");
    const main = await open(name);
    const created = await command(main.socket, main.client, { type: "new-chat" });
    const chat = created.type === "result" ? (decodeNewChat(created.result) ?? "") : "";
    await command(main.socket, main.client, { type: "chat-members", session: chat, members: ["a"] });
    const side = await open(name, `?session=${chat}`);

    expect(await submit(side.socket, side.client, "good morning")).toMatchObject({ type: "result" });
    await until(async () => (await roles(name, chat)).includes("assistant"), "ky's answer");

    expect(await replies(name, chat)).toEqual([]);
    expect(await routings(name)).toBe(1);
    main.socket.close();
    side.socket.close();
  });

  it("posts once for a message sent twice", async () => {
    const name = crypto.randomUUID();
    await make(name, "a", "b");
    const { socket, client } = await open(name);
    await command(socket, client, { type: "chat-members", session: "1", members: ["a", "b"] });
    const operationId = crypto.randomUUID();

    const first = await submit(socket, client, "route: a, b\nhello", operationId);
    const again = await submit(socket, client, "route: a, b\nhello", operationId);

    if (first.type !== "result") throw new Error(`the first submit failed: ${first.message}`);

    expect(again).toMatchObject({ result: first.result });
    await until(async () => (await replies(name)).length === 2, "both replies");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await replies(name)).toHaveLength(2);
    expect((await roles(name)).filter((role) => role === "user")).toHaveLength(1);
    // A resend is decided as before, without routing again.
    expect(await routings(name)).toBe(1);
    socket.close();
  });

  it("refuses members that are not specialists, and more than three @'d", async () => {
    const name = crypto.randomUUID();
    await make(name, "a", "b", "c", "d");
    const { socket, client } = await open(name);

    expect(await command(socket, client, { type: "chat-members", session: "1", members: ["nope"] })).toMatchObject({ type: "error", message: "No specialist @nope." });
    expect(await submit(socket, client, "@a @b @c @d hi")).toMatchObject({ type: "error", message: "At most 3 specialists can answer one message." });
    socket.close();
  });
});
