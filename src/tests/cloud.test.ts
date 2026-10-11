import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idleTimeout } from "../cloud";
import { CLOUD, CLOUD_FACTS } from "../cloud-facts";
import type { ClientMessage } from "../protocol";
import { allowedRepos, type GithubLogin, kyRefsOnly, proxyGit } from "../github";
import { githubTool } from "../github-tools";
import { SUBSCRIPTION } from "../vault";
import { GITHUB_REPOS, REVOKED_GITHUB_TOKEN } from "../../test/fakes/github";
import { call, connect, FACTS, follow, inside, pair, pairingCode, prompt, runner, tasks, until } from "./drive";
import type { Vault as TestVault } from "./stack";

/**
 * The cloud machine's Worker side (src/github.ts, src/cloud.ts, src/machines.ts): the github.internal
 * proxy that holds the token and lets pushes reach `ky/*` only, its GitHub tools, the GitHub row of
 * Settings › Subscriptions, the name `cloud` no runner may take, and no GitHub token in any task.
 * The container itself runs in the harness's cloud scenarios.
 */

// SAFETY: src/tests/wrangler.jsonc binds Vault to the test stack's subclass.
const vault = () => (env.Vault as DurableObjectNamespace<TestVault>).getByName("owner");

const LOGIN: GithubLogin = { token: "github_pat_test", repos: ["me/app"] };

const ZERO = "0".repeat(40);

/** One pkt-line of `text`. */
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;

/** A receive-pack body updating `refs`, as git sends one, with a pack after the flush. */
const push = (...refs: string[]) =>
  new TextEncoder().encode(`${refs.map((ref, i) => pkt(`${ZERO} ${"1".repeat(40)} ${ref}${i === 0 ? "\0report-status" : ""}\n`)).join("")}0000PACK`);

const git = (path: string, init: RequestInit = {}) => new Request(`http://github.internal/api/git/${path}`, init);

describe("the github.internal proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a push's ref updates: every one must be under ky/", () => {
    expect(kyRefsOnly(push("refs/heads/ky/fix"))).toBe(true);
    expect(kyRefsOnly(push("refs/heads/ky/fix", "refs/heads/ky/other"))).toBe(true);
    expect(kyRefsOnly(push("refs/heads/main"))).toBe(false);
    expect(kyRefsOnly(push("refs/heads/ky/fix", "refs/heads/main"))).toBe(false);
    expect(kyRefsOnly(push("refs/tags/ky/v1"))).toBe(false);
    expect(kyRefsOnly(push("refs/heads/kyfix"))).toBe(false);
    // git's probe before a push, and a body cut short or not pkt-lines at all.
    expect(kyRefsOnly(new TextEncoder().encode("0000"))).toBe(true);
    expect(kyRefsOnly(new TextEncoder().encode("00ff short"))).toBe(false);
    expect(kyRefsOnly(new TextEncoder().encode("PACK"))).toBe(false);
  });

  it("refuses what isn't git, with no token, a repo not picked, or a push outside ky/", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");

    expect((await proxyGit(git("me/app/objects/info/packs"), LOGIN)).status).toBe(404);
    expect((await proxyGit(git("me/app.git/info/refs?service=git-upload-pack"), null)).status).toBe(401);
    expect((await proxyGit(git("me/site.git/info/refs?service=git-upload-pack"), LOGIN)).status).toBe(403);
    expect((await proxyGit(git("me/app.git/info/refs?service=git-upload-archive"), LOGIN)).status).toBe(403);
    expect((await proxyGit(git("me/app.git/git-upload-pack"), LOGIN)).status).toBe(403);

    const main = await proxyGit(git("me/app.git/git-receive-pack", { method: "POST", body: push("refs/heads/main") }), LOGIN);
    expect(main.status).toBe(403);
    expect(await main.text()).toContain("ky/");

    const gzipped = await proxyGit(
      git("me/app.git/git-receive-pack", { method: "POST", body: push("refs/heads/ky/fix"), headers: { "content-encoding": "gzip" } }),
      LOGIN
    );

    expect(gzipped.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("sends a ky/ push on with the token, and none of the container's credentials", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    const answer = await proxyGit(
      git("Me/App.git/git-receive-pack", {
        method: "POST",
        body: push("refs/heads/ky/fix"),
        headers: { authorization: "Basic bm8=", cookie: "a=b", "content-type": "application/x-git-receive-pack-request" }
      }),
      LOGIN,
      "https://github.test"
    );

    expect(answer.status).toBe(200);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://github.test/Me/App.git/git-receive-pack");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("x-access-token:github_pat_test")}`);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-type")).toBe("application/x-git-receive-pack-request");
    // A renamed repo's redirect isn't followed with the token.
    expect(init?.redirect).toBe("manual");
  });

  it("knows the machine only from its props: the cloud machine reaches the picked repos, any other none", () => {
    expect(allowedRepos(LOGIN, CLOUD)).toEqual(LOGIN);
    expect(allowedRepos(LOGIN, "mac")).toBeNull();
    expect(allowedRepos(LOGIN, undefined)).toBeNull();
    expect(allowedRepos(null, CLOUD)).toBeNull();
  });

  it("turns GitHub's rate-limit 403 into the 429 git retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));

    expect((await proxyGit(git("me/app.git/info/refs?service=git-upload-pack"), LOGIN)).status).toBe(429);
  });
});

/** A call to a GitHub tool, as `ky github` posts it. */
const tool = (name: string, input: Record<string, string | number>) => new Request(`http://github.internal/api/github/${name}`, { method: "POST", body: JSON.stringify(input) });

/** A pull request as GitHub's REST API answers one. */
const pr = (ref: string, from = "me/app", merged = false) => ({
  number: 7,
  html_url: "https://github.com/me/app/pull/7",
  title: "Fix it",
  state: merged ? "closed" : "open",
  merged,
  merge_commit_sha: merged ? "abc1234" : "test-merge",
  head: { ref, repo: { full_name: from } },
  base: { ref: "main" }
});

/** GitHub's REST API, answering `answers` in order, and the calls it was given. */
function fakeApi(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];

  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });

    return answers.shift() ?? new Response("unexpected", { status: 500 });
  };

  return { fetch, calls };
}

describe("the github.internal GitHub tools", () => {
  it("opens a PR from a ky/ branch with the token, which reaches only GitHub's API", async () => {
    const api = fakeApi(Response.json(pr("ky/fix"), { status: 201 }));
    const answer = await githubTool(tool("pr-create", { repo: "Me/App", base: "main", head: "ky/fix", title: "Fix it", body: "why" }), LOGIN, api.fetch);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ number: 7, url: "https://github.com/me/app/pull/7", title: "Fix it", state: "open", head: "ky/fix", base: "main", mergeCommit: null });
    expect(api.calls).toHaveLength(1);
    const { url, init } = api.calls[0]!;
    // The picked repo's own spelling, GitHub's API, and never a redirect followed with the token.
    expect(url).toBe("https://api.github.com/repos/me/app/pulls");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer github_pat_test");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Fix it", head: "ky/fix", base: "main", body: "why" });
  });

  it("refuses a repo not picked, a branch outside ky/, bad input, and no GitHub login, asking GitHub nothing", async () => {
    const api = fakeApi();
    const create = { repo: "me/app", base: "main", head: "ky/fix", title: "Fix it", body: "" };

    const site = await githubTool(tool("pr-create", { ...create, repo: "me/site" }), LOGIN, api.fetch);
    expect(site.status).toBe(403);
    expect(await site.json()).toEqual({ error: expect.stringContaining("me/site") });

    for (const head of ["main", "feature/ky/x", "ky/../main", "other:ky/fix"]) {
      expect((await githubTool(tool("pr-create", { ...create, head }), LOGIN, api.fetch)).status).toBe(403);
    }

    expect((await githubTool(tool("pr-view", { repo: "me/app", number: "7" }), LOGIN, api.fetch)).status).toBe(400);
    expect((await githubTool(tool("pr-view", { repo: "me/app/../x", number: 7 }), LOGIN, api.fetch)).status).toBe(400);
    expect((await githubTool(tool("pr-close", { repo: "me/app", number: 7 }), LOGIN, api.fetch)).status).toBe(404);
    expect((await githubTool(new Request("http://github.internal/api/github/pr-view"), LOGIN, api.fetch)).status).toBe(405);
    expect((await githubTool(tool("pr-view", { repo: "me/app", number: 7 }), null, api.fetch)).status).toBe(401);
    expect(api.calls).toEqual([]);
  });

  it("merges only a ky/ branch of the repo itself: squashed, then its branch deleted", async () => {
    const api = fakeApi(Response.json(pr("ky/fix")), new Response(JSON.stringify({ merged: true })), new Response(null, { status: 204 }), Response.json(pr("ky/fix", "me/app", true)));
    const merged = await githubTool(tool("pr-merge", { repo: "me/app", number: 7 }), LOGIN, api.fetch);

    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ state: "merged", mergeCommit: "abc1234" });
    expect(api.calls.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      "GET https://api.github.com/repos/me/app/pulls/7",
      "PUT https://api.github.com/repos/me/app/pulls/7/merge",
      "DELETE https://api.github.com/repos/me/app/git/refs/heads/ky/fix",
      "GET https://api.github.com/repos/me/app/pulls/7"
    ]);
    expect(JSON.parse(String(api.calls[1]?.init.body))).toEqual({ merge_method: "squash" });

    // Someone else's branch, or a fork's ky/ branch: looked at, never merged.
    for (const refused of [pr("feature"), pr("ky/fix", "stranger/app")]) {
      const other = fakeApi(Response.json(refused));

      expect((await githubTool(tool("pr-merge", { repo: "me/app", number: 7 }), LOGIN, other.fetch)).status).toBe(403);
      expect(other.calls).toHaveLength(1);
    }
  });

  it("views a PR and a commit's parent, and passes GitHub's own refusal on", async () => {
    const api = fakeApi(Response.json(pr("ky/fix", "me/app", true)), Response.json({ sha: "abc1234", parents: [{ sha: "def5678" }] }), Response.json({ message: "Not Found" }, { status: 404 }));

    expect(await (await githubTool(tool("pr-view", { repo: "me/app", number: 7 }), LOGIN, api.fetch)).json()).toMatchObject({ state: "merged", mergeCommit: "abc1234" });
    expect(await (await githubTool(tool("parent", { repo: "me/app", sha: "abc1234" }), LOGIN, api.fetch)).json()).toEqual({ commit: "abc1234", parent: "def5678" });

    const missing = await githubTool(tool("pr-view", { repo: "me/app", number: 8 }), LOGIN, api.fetch);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "GitHub answered 404: Not Found" });
  });

  it("runs the deploy workflow only, on main", async () => {
    const api = fakeApi(new Response(null, { status: 204 }));
    const answer = await githubTool(tool("rollback", { repo: "me/app", sha: "def5678" }), LOGIN, api.fetch);

    expect(await answer.json()).toEqual({ started: true, workflow: "deploy.yml", ref: "main", sha: "def5678" });
    expect(api.calls[0]?.url).toBe("https://api.github.com/repos/me/app/actions/workflows/deploy.yml/dispatches");
    expect(JSON.parse(String(api.calls[0]?.init.body))).toEqual({ ref: "main", inputs: { sha: "def5678" } });
  });
});

describe("Settings › Subscriptions › GitHub", () => {
  it("lists a token's repos, keeps it with the ones picked, and shows only the repos", async () => {
    const socket = await connect(crypto.randomUUID());
    const client = follow(socket);
    const raw: string[] = [];
    socket.addEventListener("message", (event) => {
      raw.push(String(event.data));
    });
    const token = `github_pat_${crypto.randomUUID().replaceAll("-", "")}`;

    const result = async (id: string, message: Extract<ClientMessage, { type: "github-repos" | "set-github" }>) => {
      socket.send(JSON.stringify({ ...message, id }));
      await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === id));
      const frame = client.frames.find((each) => each.type === "result" && each.id === id);

      return frame?.type === "result" ? frame.result : undefined;
    };

    try {
      expect(await result("not", { type: "github-repos", token: "hunter2" })).toMatchObject({ refused: expect.stringContaining("isn't a GitHub token") });
      expect(await result("revoked", { type: "github-repos", token: REVOKED_GITHUB_TOKEN })).toMatchObject({
        refused: expect.stringContaining("didn't take")
      });
      expect(await result("list", { type: "github-repos", token })).toEqual({ repos: GITHUB_REPOS });
      expect(await result("none", { type: "set-github", token, repos: [] })).toEqual({ refused: "Pick at least one repo." });
      expect(await result("other", { type: "set-github", token, repos: ["someone/else"] })).toEqual({ refused: "The token doesn't reach someone/else." });
      expect(await result("save", { type: "set-github", token: ` ${token}\n`, repos: ["me/app"] })).toEqual({});

      await client.until(() =>
        client.frames.some((frame) => frame.type === "subscriptions" && frame.subscriptions.some((each) => each.kind === "github" && each.connected))
      );
      expect(client.frames.findLast((frame) => frame.type === "subscriptions")).toMatchObject({
        subscriptions: expect.arrayContaining([expect.objectContaining({ kind: "github", connected: true, repos: ["me/app"] })])
      });
      expect(await vault().githubToken()).toEqual({ token, repos: ["me/app"] });
      expect(raw.some((frame) => frame.includes(token))).toBe(false);
    } finally {
      await vault().remove("github", SUBSCRIPTION);
      socket.close();
    }
  });
});

describe("the cloud machine", () => {
  it("sleeps after KY_CLOUD_IDLE_MINUTES idle, 10 when it's unset or not a positive number", () => {
    expect(idleTimeout(undefined)).toBe(10 * 60_000);
    expect(idleTimeout("1")).toBe(60_000);
    expect(idleTimeout("0.5")).toBe(30_000);

    for (const bad of ["", " ", "0", "-1", "ten", "Infinity"]) expect(idleTimeout(bad)).toBe(10 * 60_000);
  });

  it("is listed on every deploy that has it, and no runner pairs as it or removes it", async () => {
    const name = crypto.randomUUID();
    await connect(name).then((socket) => socket.close());
    const listed = await inside(name, (instance) => instance.machines.machines().find((row) => row.name === CLOUD));
    expect(listed).toMatchObject({ name: CLOUD, facts: { kind: "cloud" } });

    const { code } = await pairingCode();
    expect((await pair({ code, name: CLOUD, facts: FACTS })).status).toBe(409);
    // The code wasn't spent on the refusal.
    expect((await pair({ code, name: `m${crypto.randomUUID().slice(0, 8)}`, facts: FACTS })).status).toBe(200);
    expect((await call(`/api/runners/${CLOUD}`, { method: "DELETE" })).status).toBe(409);
  });

  it("is listed first with its state, the default for work, and the machine tool lists each machine's facts", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name, "mac", { ...FACTS, chrome: true });
    const listed = () => inside(name, (instance) => instance.machines.machines().map((row) => ({ name: row.name, cloud: row.cloud })));

    expect(await listed()).toEqual([
      { name: CLOUD, cloud: "asleep" },
      { name: "mac", cloud: null }
    ]);

    await prompt(name, "hello");
    const { system, tools } = await inside(name, (instance) => instance.boundary.calls.at(-1)!);
    expect(system).toContain(`go to ${CLOUD}, your own machine in the cloud`);
    const described = tools?.machine ?? "";
    expect(system).toContain("a page needs a machine with Chrome");
    expect(described).toContain(`the default when you name no machine`);
    expect(described).toContain("screenshots of those pages: only a machine with Chrome takes them");
    expect(described).toContain(`${CLOUD}: on, Linux, no logged-in browser, runs Claude Code and Codex with ky's subscriptions`);
    expect(described).toContain("mac: on, macOS, Chrome with the user's logins");
    expect(described.indexOf(`${CLOUD}: on`)).toBeLessThan(described.indexOf("mac: on"));
    // Only facts: a description that changed with every task would be a new tool to the model.
    expect(described).not.toMatch(/running or queued|asleep \(/);

    // A task with no machine named waits for the cloud machine, which shows waking till it is up.
    await prompt(name, `tool machine ${JSON.stringify({ action: "run", prompt: "build it" })}`);
    expect(await tasks(name)).toEqual([expect.objectContaining({ worker: CLOUD })]);
    expect((await listed())[0]).toEqual({ name: CLOUD, cloud: "waking" });

    const cloud = await runner(name, CLOUD, CLOUD_FACTS);
    expect((await cloud.run()).prompt).toContain("build it");
    expect((await listed())[0]).toEqual({ name: CLOUD, cloud: "running" });
    expect(mac.commands).toEqual([]);

    // With the cloud machine off, an unnamed task goes to the only computer on and online.
    await inside(name, (instance) => instance.machines.configure(CLOUD, { state: "off" }));
    await prompt(name, `tool machine ${JSON.stringify({ action: "run", prompt: "build it here" })}`);
    expect((await mac.run()).prompt).toContain("build it here");
    cloud.socket.close();
    mac.socket.close();
  });

  it("is busy while a task is open on it, and hands no task a GitHub token", async () => {
    await vault().put("github", SUBSCRIPTION, LOGIN, { repos: LOGIN.repos });

    try {
      const name = crypto.randomUUID();
      const cloud = await runner(name, CLOUD, CLOUD_FACTS);
      const mac = await runner(name, "mac", FACTS);
      expect(await inside(name, (instance) => instance.machines.busy(CLOUD))).toBe(false);

      await prompt(name, `tool machine ${JSON.stringify({ action: "run", machine: CLOUD, agent: "claude", prompt: "fix it" })}`);
      const run = await cloud.run();
      // GitHub is connected, yet the cloud task gets no token: github.internal holds it.
      expect(run.creds).toBeUndefined();
      expect(JSON.stringify(run)).not.toContain(LOGIN.token);
      expect(await inside(name, (instance) => instance.machines.busy(CLOUD))).toBe(true);

      await prompt(name, `tool machine ${JSON.stringify({ action: "run", machine: "mac", agent: "claude", prompt: "fix it here" })}`);
      const here = await mac.run();
      expect(here.creds).toBeUndefined();
      expect(JSON.stringify(here)).not.toContain(LOGIN.token);

      cloud.send({ type: "result", task: run.task, turn: run.turn, ok: true, text: "fixed", session: "s-1", agent: "claude" });
      await until(async () => !(await inside(name, (instance) => instance.machines.busy(CLOUD))), "the cloud machine idle once its task ended");
      cloud.socket.close();
      mac.socket.close();
    } finally {
      await vault().remove("github", SUBSCRIPTION);
    }
  });
});
