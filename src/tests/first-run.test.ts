import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent, connect, follow, inside, prompt, until } from "./drive";
import { EXECUTOR_TOKEN, EXECUTOR_URL, FRESH } from "./stack";

describe("Settings › Executor", () => {
  it("connects with a token ky tests first, never sends the token back, and removing it drops the tools", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    const raw: string[] = [];
    socket.addEventListener("message", (event) => {
      raw.push(String(event.data));
    });
    const result = (id: string) => client.frames.find((frame) => frame.type === "result" && frame.id === id);
    const tools = () => inside(name, (instance) => instance.registry.snapshot().tools().map(({ tool }) => tool.name));

    await client.until(() => client.frames.some((frame) => frame.type === "executor"));
    expect(client.frames.findLast((frame) => frame.type === "executor")).toMatchObject({ executor: { url: null } });
    expect(await tools()).not.toContain("executor_execute");

    socket.send(JSON.stringify({ type: "set-executor", id: "wrong", url: EXECUTOR_URL, token: "not-the-token" }));
    socket.send(JSON.stringify({ type: "set-executor", id: "http", url: "http://executor.test/mcp", token: EXECUTOR_TOKEN }));
    socket.send(JSON.stringify({ type: "set-executor", id: "good", url: ` ${EXECUTOR_URL} `, token: `${EXECUTOR_TOKEN}\n` }));
    await client.until(() => result("good") !== undefined);

    expect(result("wrong")).toMatchObject({ result: { refused: "Executor refused that token." } });
    expect(result("http")).toMatchObject({ result: { refused: "Executor's address must start with https://." } });
    expect(result("good")).toMatchObject({ result: {} });
    await client.until(() => client.frames.some((frame) => frame.type === "executor" && frame.executor.url === EXECUTOR_URL));
    expect(await tools()).toEqual(expect.arrayContaining(["executor_skills", "executor_execute", "executor_resume"]));
    await client.until(() =>
      client.frames.some((frame) => frame.type === "tools" && frame.tools.some((tool) => tool.name === "executor_skills"))
    );
    expect((await prompt(name, "tool executor_execute {\"code\":\"return 1\"}")).text).toBe("tool said: ran 1");
    expect(raw.some((frame) => frame.includes(EXECUTOR_TOKEN))).toBe(false);

    socket.send(JSON.stringify({ type: "remove-executor", id: "remove" }));
    await client.until(() => client.frames.findLast((frame) => frame.type === "executor")?.type === "executor" && result("remove") !== undefined);
    expect(client.frames.findLast((frame) => frame.type === "executor")).toMatchObject({ executor: { url: null } });
    expect(await tools()).not.toContain("executor_execute");
    socket.close();
  });

  it("keeps the connection across a restart", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    socket.send(JSON.stringify({ type: "set-executor", id: "good", url: EXECUTOR_URL, token: EXECUTOR_TOKEN }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "good"));
    socket.close();

    await evictDurableObject(agent(name));

    expect((await prompt(name, "tool executor_skills {}")).text).toBe("tool said: fake executor apps: calendar (2 skills), github (3 skills)");
  });
});

describe("a new ky's seeds", () => {
  const seeded = (name: string) =>
    inside(name, async (instance) => ({
      skills: instance.skills.all().map((skill) => [skill.name, skill.status]),
      specialists: instance.specialists.list().map((specialist) => specialist.id),
      automations: (await instance.automations.list()).map((automation) => [automation.title, automation.cron, automation.status])
    }));

  it("starts with starter skills, a specialist and automations, all off, once", async () => {
    const name = `${FRESH}${crypto.randomUUID()}`;
    (await connect(name)).close();
    await until(async () => (await seeded(name)).automations.length === 2, "the seeds");

    const first = await seeded(name);
    expect(first).toEqual({
      skills: expect.arrayContaining([
        ["research-brief", "archived"],
        ["inbox-triage", "archived"]
      ]),
      specialists: ["editor"],
      automations: expect.arrayContaining([
        ["Daily digest", "0 8 * * *", "paused"],
        ["Weekly review", "0 9 * * 1", "paused"]
      ])
    });

    await evictDurableObject(agent(name));
    (await connect(name)).close();

    expect(await seeded(name)).toEqual(first);
  });

  it("leaves a ky that isn't new as it is", async () => {
    const name = crypto.randomUUID();
    (await connect(name)).close();

    expect(await seeded(name)).toEqual({ skills: [], specialists: [], automations: [] });
  });
});
