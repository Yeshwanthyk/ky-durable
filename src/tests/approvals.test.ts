import type { JsonValue } from "@earendil-works/pi-ai";
import { runDurableObjectAlarm } from "cloudflare:test";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../approvals/contract";
import type { PiClientMessage } from "../protocol";
import { agent, connect, connectExecutor, follow, type Follower, inside, prompt, promptTool, said, until } from "./drive";

/**
 * Approvals belong to the user (src/approvals): an Executor tool that needs
 * approval pauses its program, ky shows the user a card, and only their tap,
 * over their own socket, resumes it at Executor. The fake Executor
 * (src/tests/fake-executor.ts) pauses on `approve app.tool TEXT`.
 */

const PAUSE = 'tool executor_execute {"code":"approve gmail.send send mail to sam"}';

const PAUSED = '{"status":"approval-required","requestId":"request-1","message":"send mail to sam","toolPath":"gmail.send"}';

/** The page on `name`'s ky: a socket that sends one message and reads its result, and the frames it got. */
async function page(name: string): Promise<{ ask: (message: PiClientMessage) => Promise<JsonValue | undefined>; client: Follower }> {
  const socket = await connect(name);
  const client = follow(socket);
  await client.until(() => client.frames.some((frame) => frame.type === "events"));

  const ask = async (message: PiClientMessage) => {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ ...message, id }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === id));
    const frame = client.frames.find((each) => each.type === "result" && each.id === id);

    return frame?.type === "result" ? frame.result : undefined;
  };

  return { ask, client };
}

/** The approvals the page was sent last. */
function cards(client: Follower): readonly ApprovalView[] {
  const frame = client.frames.findLast((each) => each.type === "approvals");

  return frame?.type === "approvals" ? frame.approvals : [];
}

const resumes = (name: string) => inside(name, (instance) => instance.boundary.executorFake.resumes.map((each) => structuredClone(each)));

const pending = (name: string) => inside(name, (instance) => instance.approvals.pending());

describe("an approval is the user's tap", () => {
  it("shows a card for a paused program; a tap approves it, the program finishes, and a second tap does nothing", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const { ask, client } = await page(name);

    const paused = await prompt(name, PAUSE);
    expect(paused.text).toContain(`tool said: ${PAUSED}`);
    expect(paused.text).toContain("ky showed the user a card for this request");
    await client.until(() => cards(client).length === 1);
    const [card] = cards(client);
    expect(card).toMatchObject({ kind: "executor", subject: "gmail.send", summary: "send mail to sam", chat: ROOT_SESSION });
    expect(await resumes(name)).toEqual([]);

    expect(await ask({ type: "approval-decide", id: "", approval: card!.id, action: "accept" })).toEqual({});
    await said(name, '{"status":"completed","result":"did send mail to sam"}');
    await client.until(() => cards(client).length === 0);

    expect(await ask({ type: "approval-decide", id: "", approval: card!.id, action: "accept" })).toEqual({ refused: "That approval isn't waiting any more." });
    expect(await resumes(name)).toEqual([{ requestId: "request-1", response: { action: "accept" } }]);
  });

  it("refuses accept from the model, even in the user's own chat, and sends nothing", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await prompt(name, PAUSE);

    const accepted = await promptTool(name, 'tool executor_resume {"requestId":"request-1","response":{"action":"accept"}}');
    expect(accepted.failed).toBe(true);
    expect(await resumes(name)).toEqual([]);
    expect(await pending(name)).toHaveLength(1);
  });

  it("lets the model decline on the user's word, which takes the card away", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await prompt(name, PAUSE);

    expect((await prompt(name, 'tool executor_resume {"requestId":"request-1","response":{"action":"decline"}}')).text).toBe('tool said: {"status":"declined"}');
    expect(await pending(name)).toEqual([]);
  });

  it("answers a request for input with the user's answers, as Executor's accept with its content", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await prompt(name, 'tool executor_execute {"code":"ask which label"}');
    const content = { reason: "yes", count: 2, ok: true, tags: ["a", "b"] };

    await prompt(name, `tool executor_resume ${JSON.stringify({ requestId: "request-1", response: { action: "answer", content } })}`);

    expect(await resumes(name)).toEqual([{ requestId: "request-1", response: { action: "accept", content } }]);
  });
});

describe("with nobody there to approve", () => {
  it("a routine that hits an approval leaves it waiting as a card in its chat, with a push, and approves nothing", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const pushes: Array<{ session: string; text: string }> = [];
    await inside(name, (instance) => {
      instance.pushes.notify = async (session, text) => {
        pushes.push({ session, text });
      };
    });

    const created = await prompt(name, `tool automation ${JSON.stringify({ action: "create", title: "Mail sam", prompt: PAUSE, cron: "0 9 * * *" })}`);
    const id = /Created automation (\w+),/.exec(created.text ?? "")?.[1];
    expect(id).toBeDefined();
    expect((await prompt(name, `tool automation ${JSON.stringify({ action: "run", id })}`)).text).toMatch(/Running/);
    await runDurableObjectAlarm(agent(name));
    await until(
      async () => (await inside(name, (instance) => instance.feed.list().some((task) => task.source === `automation:${id}` && task.status === "done"))),
      "the run to finish"
    );

    expect(await pending(name)).toEqual([expect.objectContaining({ kind: "executor", subject: "gmail.send", chat: ROOT_SESSION })]);
    // Besides the routine's own result, one push asks for the OK.
    expect(pushes.filter((push) => push.text.startsWith("Waiting for your OK"))).toEqual([{ session: ROOT_SESSION, text: "Waiting for your OK: send mail to sam" }]);
    expect(await resumes(name)).toEqual([]);
  });
});

describe("each tool's policy", () => {
  it("blocks a tool set to Block, and allows one set to Allow only while the user is in the chat", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const { ask } = await page(name);

    expect(await ask({ type: "set-tool-policy", id: "", tool: "gmail.send", policy: "block" })).toBeNull();
    const blocked = await prompt(name, PAUSE);
    expect(blocked.text).toContain("ky declined this request: the user set gmail.send to Block");
    expect(await resumes(name)).toEqual([{ requestId: "request-1", response: { action: "decline" } }]);

    expect(await ask({ type: "set-tool-policy", id: "", tool: "gmail.send", policy: "allow" })).toBeNull();
    const allowed = await prompt(name, PAUSE);
    expect(allowed.text).toContain('{"status":"completed","result":"did send mail to sam"}');
    expect(await pending(name)).toEqual([]);

    // A subagent's turn has no user in it: Allow asks there.
    await inside(name, (instance) => instance.executorApprovals.replied(
      { output: [{ type: "text", text: '{"status":"approval-required","requestId":"request-9","message":"send","toolPath":"gmail.send"}' }] },
      "not-a-chat",
      async () => { throw new Error("nothing is sent"); }
    ));
    expect(await pending(name)).toEqual([expect.objectContaining({ subject: "gmail.send", chat: ROOT_SESSION })]);
  });
});

describe("a request Executor no longer has", () => {
  it("expires on a tap, and the chat is told to check whether it happened", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const { ask } = await page(name);

    const id = await inside(name, (instance) =>
      instance.approvals.requestApproval({
        kind: "executor",
        subject: "gmail.send",
        summary: "send the old mail",
        payload: { requestId: "request-404", tool: "gmail.send", message: "send the old mail" },
        conversation: ROOT_SESSION
      })
    );

    expect(await ask({ type: "approval-decide", id: "", approval: id, action: "accept" })).toEqual({
      refused: "Executor no longer has that request, so it expired. ky told the chat."
    });
    await said(name, "Executor no longer has request request-404: it expired");
    expect(await inside(name, (instance) => instance.approvals.get(id)?.status)).toBe("expired");
  });

  it("from before approval cards, can't be answered by the model; cancelling it reaches Executor", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);

    const answered = await promptTool(name, 'tool executor_resume {"requestId":"request-7","response":{"action":"answer","content":{}}}');
    expect(answered.failed).toBe(true);
    expect(answered.text).toContain("can't be approved any more: cancel it");
    expect(await resumes(name)).toEqual([]);

    expect((await prompt(name, 'tool executor_resume {"requestId":"request-7","response":{"action":"cancel"}}')).text).toBe(
      'tool said: {"status":"unavailable","reason":"not-found"}'
    );
  });
});
