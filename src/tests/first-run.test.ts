import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_SKILLS } from "../avatars/seeds";
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

  it("edits the URL and keeps the connected token when none is given", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    const result = (id: string) => client.frames.find((frame) => frame.type === "result" && frame.id === id);
    const edited = `${EXECUTOR_URL}?elicitation_mode=browser`;

    // One at a time: an edit reads the token the connect before it kept.
    for (const [id, url, token] of [
      ["blank", EXECUTOR_URL, " "],
      ["good", EXECUTOR_URL, EXECUTOR_TOKEN],
      ["edit", edited, ""],
      ["wrong", EXECUTOR_URL, "not-the-token"]
    ] as const) {
      socket.send(JSON.stringify({ type: "set-executor", id, url, token }));
      await client.until(() => result(id) !== undefined);
    }

    expect(result("blank")).toMatchObject({ result: { refused: "Paste an Executor personal access token." } });
    expect(result("edit")).toMatchObject({ result: {} });
    expect(result("wrong")).toMatchObject({ result: { refused: "Executor refused that token." } });
    await client.until(() => client.frames.findLast((frame) => frame.type === "executor")?.executor.url === edited);
    expect((await prompt(name, "tool executor_execute {\"code\":\"return 1\"}")).text).toBe("tool said: ran 1");
    socket.close();
  });

  it("lets the agent change the URL on the same origin, keeping the token, and never move it to another host", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    const browser = `${EXECUTOR_URL}?elicitation_mode=browser`;
    socket.send(JSON.stringify({ type: "set-executor", id: "good", url: browser, token: EXECUTOR_TOKEN }));
    await client.until(() => client.frames.findLast((frame) => frame.type === "executor")?.executor.url === browser);

    expect((await prompt(name, "tool executor_connection {}")).text).toBe(`tool said: Executor is connected at ${browser}.`);
    expect((await prompt(name, "tool executor_connection {\"url\":\"https://elsewhere.test/mcp\"}")).text).toContain(
      "Not changed: ky only changes the path and query here, on https://executor.test."
    );
    expect((await prompt(name, `tool executor_connection {"url":"${EXECUTOR_URL}"}`)).text).toBe(
      `tool said: Executor is now connected at ${EXECUTOR_URL}. Its tools reconnect there on their next call.`
    );
    await client.until(() => client.frames.findLast((frame) => frame.type === "executor")?.executor.url === EXECUTOR_URL);
    expect((await prompt(name, "tool executor_execute {\"code\":\"return 1\"}")).text).toBe("tool said: ran 1");
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

  it("ships make-skill on, for when the owner asks for a skill", async () => {
    const name = `${FRESH}${crypto.randomUUID()}`;
    (await connect(name)).close();
    await until(async () => (await seeded(name)).automations.length === 2, "the seeds");

    expect((await seeded(name)).skills).toContainEqual(["make-skill", "active"]);
  });

  it("leaves a ky that isn't new as it is", async () => {
    const name = crypto.randomUUID();
    (await connect(name)).close();

    expect(await seeded(name)).toEqual({ skills: [], specialists: [], automations: [] });
  });
});

describe("the default skills", () => {
  const names: string[] = DEFAULT_SKILLS.map((skill) => skill.name);

  const defaults = (name: string) =>
    inside(name, (instance) =>
      instance.skills
        .all()
        .filter((skill) => names.includes(skill.name))
        .map((skill) => ({ ...skill, by: instance.skills.history(skill.name).map((version) => version.actor) }))
    );

  const started = async () => {
    const name = `${FRESH}${crypto.randomUUID()}`;
    (await connect(name)).close();
    await until(async () => (await defaults(name)).length === names.length, "the default skills");

    return name;
  };

  /** Take skills out, as a ky from before they existed lacks them. */
  const remove = (name: string, skills: string[]) =>
    inside(name, (_, state) => {
      for (const skill of skills) {
        state.storage.sql.exec("DELETE FROM ky_skills WHERE name = ?", skill);
        state.storage.sql.exec("DELETE FROM ky_skill_versions WHERE name = ?", skill);
      }
    });

  const restart = async (name: string) => {
    await evictDurableObject(agent(name));
    (await connect(name)).close();
  };

  it("are added to a ky past its first start, on and pinned, by ky", async () => {
    const name = await started();
    await remove(name, names);
    expect(await defaults(name)).toEqual([]);

    await restart(name);

    const skills = await defaults(name);

    for (const { name: skill, description, body } of DEFAULT_SKILLS) {
      expect(skills.find((each) => each.name === skill)).toMatchObject({ description, body, status: "active", pinned: true, by: ["ky"] });
    }
  });

  it("leave the owner's edits, archives and unpins as they are, and add one a ky from before it lacks", async () => {
    const name = await started();
    await inside(name, (instance) => {
      instance.skills.apply({ action: "edit", name: "delegate", body: "My own way." }, "user");
      instance.skills.apply({ action: "archive", name: "fan-out" }, "user");
      instance.skills.apply({ action: "unpin", name: "sharpen" }, "user");
    });
    await remove(name, ["challenge"]);
    const kept = await defaults(name);

    await restart(name);

    const after = await defaults(name);
    const named = (skill: string) => after.find((each) => each.name === skill);
    expect(named("delegate")).toMatchObject({ body: "My own way.", status: "active", pinned: true });
    expect(named("fan-out")).toMatchObject({ status: "archived", pinned: true });
    expect(named("sharpen")).toMatchObject({ status: "active", pinned: false });
    expect(named("challenge")).toMatchObject({ status: "active", pinned: true, by: ["ky"] });
    expect(after.filter((skill) => skill.name !== "challenge")).toEqual(kept);
  });
});
