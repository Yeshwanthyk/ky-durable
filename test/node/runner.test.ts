import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../../cli/commands.ts";
import { ky } from "../../cli/ky.ts";
import { restartRunner } from "../../cli/runner/commands.ts";
import { github } from "../../cli/runner/github.ts";
import { plist, unit } from "../../cli/runner/service.ts";
import { readSettings, type Settings, withEnv } from "../../cli/runner/settings.ts";
import { stableKy } from "../../cli/runner/system.ts";
import type { MachineFacts } from "../../src/runner-protocol.ts";
import { type FakeSystem, fakeSystem } from "../fakes/system.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const TOKEN = "machine-token-0123456789";

/** A ky that pairs: `/api/runners/pair` takes `code` once and answers a machine token. */
type FakeKy = { url: string; pairings: { code: string; name: string; facts: MachineFacts }[]; close: () => Promise<void> };

async function fakeKy(code = "ABCD-1234"): Promise<FakeKy> {
  const pairings: FakeKy["pairings"] = [];

  const server: Server = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) body += chunk;

    if (request.method !== "POST" || request.url !== "/api/runners/pair") return void response.writeHead(404).end();
    const asked = JSON.parse(body);

    if (asked.code !== code || pairings.length > 0) return void response.writeHead(401).end("bad code");
    pairings.push(asked);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ machine: asked.name, token: TOKEN }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  // SAFETY: a server listening on a TCP port has an AddressInfo address.
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    pairings,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

let computer: FakeSystem;

let ours: FakeKy;

let printed: string[];

function context(env: NodeJS.ProcessEnv = {}): Context {
  return {
    overlay: path.join(computer.config, "ky", "wrangler.local.jsonc"),
    release: async () => {
      throw new Error("no release");
    },
    login: async () => {
      throw new Error("not signed in");
    },
    print: (line) => printed.push(line),
    fail: (line) => printed.push(line),
    system: computer,
    // The fake claude says it's signed in; there's no codex.
    env: { KY_CLAUDE: path.join(REPO, "test/fakes/claude.ts"), KY_CODEX: path.join(computer.home, "no-codex"), ...env },
    sleep: async () => {}
  };
}

const run = (args: string[], env?: NodeJS.ProcessEnv) => ky(args, context(env));

const settingsFile = () => path.join(computer.config, "ky", "runner.json");

const saved = async () => (await readSettings(settingsFile()))!;

beforeEach(async () => {
  printed = [];
  ours = await fakeKy();
});

afterEach(() => ours.close());

describe("ky runner add", () => {
  beforeEach(async () => {
    computer = await fakeSystem("darwin");
  });

  it("pairs, keeps the token in a 0600 file, writes runner.json, installs the launchd agent and waits for it online", async () => {
    await mkdir(path.join(computer.home, "code", "app", ".git"), { recursive: true });
    computer.ports.add(8317);

    expect(await run(["runner", "add", `${ours.url}/`, "ABCD-1234", "--name", "Studio Mac", "--yes"])).toBe(0);

    expect(ours.pairings).toEqual([
      {
        code: "ABCD-1234",
        name: "studio-mac",
        facts: {
          os: process.platform,
          chrome: false,
          repos: [{ name: "app", remote: null }],
          agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
          ports: [8317],
          kind: "computer"
        }
      }
    ]);

    const file = path.join(computer.config, "ky", "runner-token");

    expect((await readFile(file, "utf8")).trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Not the Keychain, and in no process's arguments.
    expect(computer.keychain.size).toBe(0);
    expect(computer.ran.filter((line) => line.startsWith("security"))).toEqual([]);
    expect(computer.ran.some((line) => line.includes(TOKEN))).toBe(false);

    expect(await saved()).toEqual({
      url: ours.url,
      name: "studio-mac",
      token: { file },
      workdir: path.join(computer.home, "ky-work"),
      permissionMode: "bypassPermissions",
      agents: { claude: true, codex: false },
      chrome: false,
      repos: [path.join(computer.home, "code")],
      ports: [8317]
    } satisfies Settings);

    const agent = path.join(computer.launchAgents, "test.ky.runner.plist");

    expect(await readFile(agent, "utf8")).toBe(plist(computer));
    expect(computer.ran).toContain(`launchctl bootstrap gui/501 ${agent}`);
    expect(computer.loaded).toEqual(new Set(["test.ky.runner"]));
    expect(printed.join("\n")).toContain("studio-mac is online");
  });

  it("keeps the token in a 0600 file on Linux, and installs a systemd user unit with linger", async () => {
    computer = await fakeSystem("linux");

    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--yes"])).toBe(0);
    const file = path.join(computer.config, "ky", "runner-token");

    expect((await readFile(file, "utf8")).trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await saved()).token).toEqual({ file });
    expect(computer.keychain.size).toBe(0);

    expect(await readFile(path.join(computer.systemdUnits, "ky-runner-test.service"), "utf8")).toBe(unit(computer));
    expect(computer.ran).toEqual(
      expect.arrayContaining(["systemctl --user daemon-reload", "systemctl --user enable --now ky-runner-test.service", "loginctl enable-linger someone"])
    );
  });

  it("refuses a used or wrong code, and keeps nothing", async () => {
    expect(await run(["runner", "add", ours.url, "WRONG", "--yes"])).toBe(1);
    expect(printed.join("\n")).toContain("ky didn't take that code");
    expect(computer.keychain.size).toBe(0);
    expect(existsSync(settingsFile())).toBe(false);
    expect(computer.loaded.size).toBe(0);
  });

  it("says so when the runner ky turned away doesn't come online", async () => {
    computer.online = "stopped";

    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--yes"])).toBe(1);
    expect(printed.join("\n")).toContain("isn't online yet: removed from ky");
  });

  it("installs no service with --no-service, and says how to start it", async () => {
    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--yes", "--no-service"])).toBe(0);
    expect(computer.ran.filter((line) => line.startsWith("launchctl"))).toEqual([]);
    expect(printed.join("\n")).toContain("ky runner run");
  });

  it("moves a token kept in the Keychain to the file, leaves the Keychain item, and says how to remove it", async () => {
    const account = `mac@${new URL(ours.url).host}`;

    const old: Settings = {
      url: ours.url,
      name: "mac",
      token: { keychain: { service: "ky runner", account } },
      workdir: path.join(computer.home, "ky-work"),
      repos: [],
      permissionMode: "bypassPermissions",
      chrome: false,
      agents: { claude: true, codex: false },
      ports: []
    };

    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(old));
    computer.keychain.set(`ky runner/${account}`, "old-token");

    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--name", "mac", "--yes"])).toBe(0);

    const file = path.join(computer.config, "ky", "runner-token");
    expect((await saved()).token).toEqual({ file });
    expect((await readFile(file, "utf8")).trim()).toBe(TOKEN);
    expect(computer.keychain.get(`ky runner/${account}`)).toBe("old-token");
    expect(computer.ran.some((line) => line.startsWith("security"))).toBe(false);
    expect(printed.join("\n")).toContain(`security delete-generic-password -s "ky runner" -a "${account}"`);
  });

  it("writes the service file fresh, without an earlier trial's state dir", async () => {
    const agent = path.join(computer.launchAgents, "test.ky.runner.plist");
    const trial = { ...computer, state: "/tmp/ky-trial" };
    await mkdir(computer.launchAgents, { recursive: true });
    await writeFile(agent, plist(trial));
    expect(plist(trial)).toContain("KY_STATE_DIR");

    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--yes"])).toBe(0);
    const written = await readFile(agent, "utf8");

    expect(written).toBe(plist(computer));
    expect(written).not.toContain("KY_STATE_DIR");
    expect(written).not.toContain("XDG_CONFIG_HOME");
    expect(printed.join("\n")).not.toContain("The service keeps");
  });

  it("says when the service keeps a state dir from this shell", async () => {
    computer.state = path.join(computer.home, "trial-state");

    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--yes", "--name", "mac"])).toBe(0);
    expect(await readFile(path.join(computer.launchAgents, "test.ky.runner.plist"), "utf8")).toContain(`<string>${computer.state}</string>`);
    expect(printed.join("\n")).toContain(`The service keeps KY_STATE_DIR=${computer.state}`);
  });

  it("asks for the URL and code it isn't given only at a terminal", async () => {
    expect(await run(["runner", "add", "--yes"])).toBe(1);
    expect(printed.join("\n")).toContain("usage: ky runner add <ky url> <code>");
  });
});

describe("the service's ky", () => {
  it("is the ky on PATH that links to this binary, not Homebrew's versioned Cellar path, which brew upgrade deletes", async () => {
    const prefix = await mkdtemp(path.join(tmpdir(), "ky-brew-"));
    const cellar = path.join(prefix, "Cellar/ky/0.1.0-rc.1/bin/ky");
    const other = path.join(prefix, "other");
    await mkdir(path.dirname(cellar), { recursive: true });
    await mkdir(path.join(prefix, "bin"));
    await mkdir(other);
    await writeFile(cellar, "");
    await symlink("../Cellar/ky/0.1.0-rc.1/bin/ky", path.join(prefix, "bin/ky"));
    // Another ky earlier on PATH, which is not this one.
    await writeFile(path.join(other, "ky"), "");

    try {
      expect(stableKy(cellar, [other, "relative", path.join(prefix, "bin"), "/usr/bin"].join(path.delimiter))).toBe(path.join(prefix, "bin/ky"));
      // Nothing on PATH runs it: Homebrew's own link beside the Cellar, which brew upgrade keeps.
      expect(stableKy(cellar, [other, "/usr/bin"].join(path.delimiter))).toBe(path.join(prefix, "bin/ky"));
      // No such link: the binary's own path.
      await rm(path.join(prefix, "bin/ky"));
      expect(stableKy(cellar, [other, "/usr/bin"].join(path.delimiter))).toBe(cellar);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });
});

describe("the runner on this computer", () => {
  beforeEach(async () => {
    computer = await fakeSystem("darwin");
    expect(await run(["runner", "add", ours.url, "ABCD-1234", "--name", "mac", "--yes"])).toBe(0);
    printed = [];
  });

  it("lists it, online, and shows its status", async () => {
    expect(await run(["runner", "ls"])).toBe(0);
    expect(printed.join("\n")).toMatch(new RegExp(`^mac  ${ours.url}  online since`));

    printed = [];
    expect(await run(["runner", "status"])).toBe(0);
    const status = printed.join("\n");

    expect(status).toContain("Claude Code, in");
    expect(status).toContain(`Token     ${path.join(computer.config, "ky", "runner-token")}`);
    expect(status).toContain("test.ky.runner.plist (loaded)");
  });

  it("is restarted by ky upgrade's restart, and not once it's removed", async () => {
    expect(await restartRunner(context())).toBe("Restarted the runner for mac");
    expect(computer.ran).toContain("launchctl kickstart -k gui/501/test.ky.runner");

    expect(await run(["runner", "rm"])).toBe(0);
    expect(computer.loaded.size).toBe(0);
    expect(computer.keychain.size).toBe(0);
    expect(existsSync(settingsFile())).toBe(false);
    expect(existsSync(path.join(computer.launchAgents, "test.ky.runner.plist"))).toBe(false);
    expect(await restartRunner(context())).toBeUndefined();
  });

  it("prints its log", async () => {
    await writeFile(path.join(computer.state, "runner.log"), "12:00:00 connected\n");
    expect(await run(["runner", "logs"])).toBe(0);
    expect(printed).toEqual(["12:00:00 connected"]);
  });
});

describe("ky runner run's settings", () => {
  beforeEach(async () => {
    computer = await fakeSystem("darwin");
  });

  it("are runner.json's, each overridden by its KY_ variable", () => {
    const file: Settings = {
      url: "https://ky.example.com",
      name: "mac",
      token: { keychain: { service: "ky runner", account: "mac@ky.example.com" } },
      workdir: "/work",
      repos: ["/code"],
      permissionMode: "acceptEdits",
      chrome: true,
      agents: { claude: true, codex: false },
      ports: [8317]
    };

    expect(withEnv(file, {}, computer)).toEqual(file);
    expect(withEnv(file, { KY_MACHINE: "Box", KY_RUNNER_PORTS: "11434,x", KY_CHROME: "0", KY_RUNNER_TOKEN_FILE: "/t" }, computer)).toEqual({
      ...file,
      name: "box",
      ports: [11_434],
      chrome: false,
      token: { file: "/t" }
    });
  });

  it("need KY_URL without runner.json, and keep the token in its file", () => {
    expect(() => withEnv(undefined, {}, computer)).toThrow("This computer has no runner yet");
    expect(withEnv(undefined, { KY_URL: "https://ky.example.com/" }, computer).token).toEqual({ file: path.join(computer.config, "ky", "runner-token") });
  });

  it("refuse to run with no token kept", async () => {
    await mkdir(path.join(computer.config, "ky"), { recursive: true });
    expect(await run(["runner", "run"], { KY_URL: ours.url })).toBe(1);
    expect(printed.join("\n")).toContain("No machine token at");
  });
});

describe("ky attach and ky diff", () => {
  it("run only inside a ky task", async () => {
    computer = await fakeSystem("darwin");

    expect(await run(["attach", "shot.png"])).toBe(1);
    expect(await run(["diff"])).toBe(1);
    expect(printed).toEqual(["ky: run this inside a ky task", "ky: run this inside a ky task"]);
  });
});

describe("ky github", () => {
  /** The Worker's GitHub tools, answering `answers` in order; what each call posted. */
  async function fakeTools(...answers: [number, Record<string, string | number>][]) {
    const calls: { url: string; input: unknown }[] = [];

    const server = createServer(async (request, response) => {
      let body = "";

      for await (const chunk of request) body += chunk;
      calls.push({ url: `${request.method} ${request.url}`, input: JSON.parse(body) });
      const [status, answer] = answers.shift() ?? [500, { error: "unexpected" }];

      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port has an AddressInfo address.
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/github`;

    return { api, calls, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it("opens a PR from the current branch, and watches a run until it ends", async () => {
    const tools = await fakeTools([200, { number: 7, state: "open" }], [200, { id: 9, status: "in_progress" }], [200, { id: 9, status: "completed", conclusion: "failure" }]);
    const lines: string[] = [];
    const env = { KY_GITHUB_API: tools.api };
    const sleep = async () => {};

    try {
      expect(await github(["pr-create", "me/app", "main", "Fix it", "why"], env, (line) => lines.push(line), sleep, () => "ky/fix")).toBe(0);
      expect(JSON.parse(lines[0] ?? "")).toEqual({ number: 7, state: "open" });
      // A failed deploy fails the watch, so the task rolls back.
      expect(await github(["watch", "me/app", "9"], env, (line) => lines.push(line), sleep)).toBe(1);
      expect(tools.calls).toEqual([
        { url: "POST /api/github/pr-create", input: { repo: "me/app", base: "main", head: "ky/fix", title: "Fix it", body: "why" } },
        { url: "POST /api/github/run", input: { repo: "me/app", id: 9 } },
        { url: "POST /api/github/run", input: { repo: "me/app", id: 9 } }
      ]);
    } finally {
      await tools.close();
    }
  });

  it("says why the Worker refused, and how to call it", async () => {
    const tools = await fakeTools([403, { error: "ky's GitHub token isn't for me/site" }]);
    const env = { KY_GITHUB_API: tools.api };

    try {
      await expect(github(["pr-view", "me/site", "7"], env, () => {}, async () => {})).rejects.toThrow("HTTP 403: ky's GitHub token isn't for me/site");
      await expect(github(["pr-view", "me/app", "seven"], env, () => {}, async () => {})).rejects.toThrow("usage: ky github");
      await expect(github(["pr-close", "me/app", "7"], env, () => {}, async () => {})).rejects.toThrow("usage: ky github");
    } finally {
      await tools.close();
    }
  });
});

describe("ky runner cloud", () => {
  const KY = [process.execPath, "--experimental-strip-types", "--no-warnings", path.join(REPO, "cli/main.ts"), "runner", "cloud"];

  /** `ky runner cloud` in a fresh home, as the container's entrypoint runs it, and its port. */
  async function cloud(env: NodeJS.ProcessEnv): Promise<{ home: string; port: number; child: ChildProcess; output: () => string }> {
    const home = await mkdtemp(path.join(tmpdir(), "ky-cloud-test-"));

    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        // SAFETY: a server listening on a TCP port has an AddressInfo address.
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => resolve(free));
      });
    });

    const child = spawn(KY[0]!, KY.slice(1), {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, KY_URL: ours.url, KY_CLOUD_PORT: String(port), KY_RUNNER_PORTS: "", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
    cleanups.push(async () => {
      child.kill("SIGKILL");
      await rm(home, { recursive: true, force: true });
    });

    return { home, port, child, output: () => output };
  }

  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("refuses to run without the token the cloud machine passes", async () => {
    const { child, output } = await cloud({});
    const code = await new Promise((resolve) => child.on("exit", resolve));

    expect(code).not.toBe(0);
    expect(output()).toContain("KY_RUNNER_TOKEN");
  });

  it("restores the last save before it runs, and saves sessions and work trees but not node_modules", async () => {
    const { home, port, output } = await cloud({ KY_RUNNER_TOKEN: TOKEN, KY_GITHUB_PROXY: "http://proxy.test/api/git/" });
    const at = (route: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${route}`, init);
    const ping = async () => (await at("/ping")).text();

    for (let i = 0; i < 100; i++) {
      if (await ping().catch(() => undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await ping(), output()).toBe("waiting");

    // What a last sleep saved: a Claude Code session, and a work tree with its dependencies.
    const last = await mkdtemp(path.join(tmpdir(), "ky-cloud-save-"));
    cleanups.push(() => rm(last, { recursive: true, force: true }));
    await mkdir(path.join(last, ".claude", "projects", "fake"), { recursive: true });
    await writeFile(path.join(last, ".claude", "projects", "fake", "s-1.jsonl"), "{}\n");
    await mkdir(path.join(last, "ky-work", "app", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(last, "ky-work", "app", "README.md"), "# app\n");
    await writeFile(path.join(last, "ky-work", "app", "node_modules", "dep", "index.js"), "");
    execFileSync("tar", ["-czf", path.join(last, "save.tar.gz"), "-C", last, ".claude", "ky-work"]);

    expect((await at("/restore", { method: "PUT", body: await readFile(path.join(last, "save.tar.gz")) })).status).toBe(204);
    expect(await ping()).toBe("running");
    expect(await readFile(path.join(home, ".claude", "projects", "fake", "s-1.jsonl"), "utf8")).toBe("{}\n");
    expect((await at("/restore", { method: "PUT", body: "" })).status).toBe(409);
    // git reaches github.com through the proxy, set in the container's home.
    expect(execFileSync("git", ["config", "--file", path.join(home, ".gitconfig"), "--get", "url.http://proxy.test/api/git/.insteadof"], { encoding: "utf8" }).trim()).toBe(
      "https://github.com/"
    );

    const save = await at("/save", { method: "POST" });
    expect(save.status).toBe(200);
    expect(await ping()).toBe("stopped");
    await writeFile(path.join(last, "next.tar.gz"), Buffer.from(await save.arrayBuffer()));
    const listed = execFileSync("tar", ["-tzf", path.join(last, "next.tar.gz")], { encoding: "utf8" }).split("\n");

    expect(listed).toContain(".claude/projects/fake/s-1.jsonl");
    expect(listed).toContain("ky-work/app/README.md");
    expect(listed.some((entry) => entry.includes("node_modules"))).toBe(false);
  });
});
