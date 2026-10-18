import { type JsonValue, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { DreamLedgerRow } from "../dreaming/contract";
import type { TaskTokens } from "../machines/contract";
import { Access } from "../access";
import { type Boundary, PiAgent as ProductionAgent, worker } from "../server";
import { peerRoute } from "../peers/peers";
import { type AiCall, chatCompletions, fakeAI, type Reply, type WireMessage, wireText } from "../../test/fakes/ai";
import { edge, FakeAccess } from "./fake-access";
import { vendors } from "../../test/fakes/vendors";
import { fakeOpenAi } from "../../test/fakes/openai";
import { FakeExecutor } from "./fake-executor";
import { fakeVibeProxy, refusingVibeProxy, VIBEPROXY_KEY, VIBEPROXY_TEST_PORT } from "../../test/fakes/vibeproxy";
import { Vault as ProductionVault, type TokenKind } from "../vault";
import { type CloudBox, CloudMachine as ProductionCloudMachine } from "../cloud";
import { saveKey } from "../sandboxes";
import { CLOUD } from "../cloud-facts";
import { allowedRepos, proxyGit } from "../github";
import { githubTool } from "../github-tools";
import { fakeGithubApi, fakeGithubRest } from "../../test/fakes/github";

export { GithubProxy } from "../github";

/** The cloud machine's settings in the stack: its fake container host, the fake GitHub, and how soon it sleeps. */
const HOST_KEY = "test:host";

const UPSTREAM_KEY = "test:github";

const IDLE_KEY = "test:idle-ms";

/** Set by `hold`: the platform's alarms do nothing, and the test ticks. */
const HELD_KEY = "test:held";

/** The sandbox the fake host's container was last started for: its github.internal is that sandbox's, as production's props say. */
const CALLER_KEY = "test:github-machine";

/** The test alarm's tick: a start that failed is tried again soon. */
const TEST_TICK_MS = 2_000;

/** Set by the harness: the tick, and how long starts may fail while work waits, in ms; else the tests' and production's. */
const TICK_KEY = "test:tick-ms";

const START_DEADLINE_KEY = "test:start-deadline-ms";

/** Cloudflare's error for a start it refused (src/cloud.ts's NO_INSTANCE). */
const NO_INSTANCE = "There is no container instance that can be provided";

/** The fake host's mark on a start it refused (test/fakes/container.ts, which runs in node, not here). */
const REFUSED_HEADER = "x-fake-refused";

/**
 * A container on the fake host (test/fakes/container.ts) at `host`, which the harness starts; with no
 * host set, none runs and a start fails, as a container that never comes up.
 */
function hostBox(host: () => Promise<string | undefined>, startedFor: (id: string) => Promise<void>): CloudBox {
  const at = async (path: string) => {
    const url = await host();

    if (!url) throw new Error("No fake container host: POST /test/cloud-host first.");

    return `${url}${path}`;
  };

  return {
    running: async () => ((await host()) ? (await (await fetch(await at("/running"))).text()) === "true" : false),
    start: async (env, id) => {
      await startedFor(id);
      const started = await fetch(await at("/start"), { method: "POST", body: JSON.stringify(env) });

      if (started.status !== 204) throw new Error(`The fake container didn't start: ${started.status}`);
    },
    fetch: async (path, init) => {
      const answer = await fetch(await at(`/port${path}`), init);

      // A start the fake refused: Cloudflare's fetch throws then.
      if (answer.headers.has(REFUSED_HEADER)) throw new Error(await answer.text());

      return answer;
    },
    destroy: async () => {
      await (await fetch(await at("/destroy"), { method: "POST" })).body?.cancel();
    }
  };
}

/** A body that fails partway, as an upload cut off on its way to R2. */
function cutBody(length: number): Response {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error("The upload was cut off."));
    }
  });

  return new Response(body, { headers: { "content-length": String(Math.max(length, 1)) } });
}

/**
 * A container in memory, for what the fake host can't stage in workerd's tests: whether it is up,
 * what its runner says (`ky runner cloud`'s states), and its disk, as text. A test may cut off its
 * uploads, crash it, and watch what each destroy throws away.
 */
export class FakeBox implements CloudBox {
  up = false;
  state: "waiting" | "running" | "stopped" = "waiting";
  disk = "";
  /** The disks restored into it, in order. */
  restored: string[] = [];
  starts = 0;
  destroys = 0;
  /** Awaited as a start begins, before the container is up: what lands meanwhile, such as a delete. */
  onStart: (() => Promise<void>) | undefined;
  /** Awaited as a destroy begins, with the disk it throws away. */
  onDestroy: ((disk: string) => Promise<void>) | undefined;
  /** How many of the next uploads, a save's or a snapshot's, are cut off on their way to R2. */
  cutUploads = 0;
  /** How many of the next saves are cut off, after the runner stopped. */
  cutSaves = 0;
  /** The uploads cut off so far. */
  cuts = 0;
  /** Starts are refused, as when Cloudflare has no instance to give: nothing comes up, and its port says so. */
  refusing = false;
  /** Every save and snapshot answers 500; a save stops the runner first, as the runner's own does. */
  failSaves = false;
  /** Each upload asked for, a save's or a snapshot's: whether it reached R2 whole. */
  uploads: boolean[] = [];
  /** The machine token each start was handed, in order. */
  tokens: string[] = [];
  /** When each start came, by `clock`. */
  startedAt: number[] = [];
  /** The time the starts are stamped with: the CloudMachine's clock, once a test sets it. */
  clock: () => number = () => Date.now();
  /** Whether the last start was refused. */
  #unplaced = false;
  /** Dead, but the platform still says it runs, as it does for a while after a runner is killed. */
  ghost = false;

  async running(): Promise<boolean> {
    return this.up || this.ghost;
  }

  async start(env?: Record<string, string>): Promise<void> {
    this.starts++;
    this.tokens.push(env?.KY_RUNNER_TOKEN ?? "");
    this.startedAt.push(this.clock());
    await this.onStart?.();
    this.#unplaced = this.refusing;
    this.ghost = false;
    this.up = !this.refusing;
    this.state = "waiting";
    this.disk = "";
  }

  /** The container dies, as a crash or an eviction kills it: its disk is gone. `unseen`, the platform says it runs on. */
  crash(unseen = false): void {
    this.ghost = unseen;
    this.up = false;
    this.state = "waiting";
    this.disk = "";
  }

  #upload(save: boolean): Response {
    if (this.failSaves) {
      this.uploads.push(false);

      return new Response("the save failed", { status: 500 });
    }

    this.uploads.push(this.cutUploads === 0 && !(save && this.cutSaves > 0));
    const length = new TextEncoder().encode(this.disk).byteLength;

    if (this.cutUploads > 0 || (save && this.cutSaves > 0)) {
      if (this.cutUploads > 0) this.cutUploads--;
      else this.cutSaves--;
      this.cuts++;

      return cutBody(length);
    }

    return new Response(this.disk, { headers: { "content-length": String(length) } });
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this.up) throw new Error(this.#unplaced ? NO_INSTANCE : "No container runs.");

    if (path === "/ping") return new Response(this.state);

    if (path === "/restore") {
      this.disk = await new Response(init?.body).text();
      this.restored.push(this.disk);
      this.state = "running";

      return new Response(null, { status: 204 });
    }

    if (path === "/save") {
      this.state = "stopped";

      return this.#upload(true);
    }

    if (path === "/snapshot") {
      if (this.state !== "running") return new Response(`the runner is ${this.state}`, { status: 409 });

      return this.#upload(false);
    }

    return new Response("Not found", { status: 404 });
  }

  async destroy(): Promise<void> {
    await this.onDestroy?.(this.disk);
    this.destroys++;
    this.up = false;
    this.ghost = false;
  }
}

/**
 * The CloudMachine, with its container on the harness's fake host (`POST /test/cloud-host`), or in
 * memory once a test sets `fake`, a tick of TEST_TICK_MS, and an idle time the harness may shorten.
 */
export class CloudMachine extends ProductionCloudMachine {
  fake: FakeBox | undefined;

  override box(): CloudBox {
    return (
      this.fake ??
      hostBox(
        () => this.ctx.storage.get<string>(HOST_KEY),
        (id) => this.ctx.storage.put(CALLER_KEY, id)
      )
    );
  }

  /** As a wake for the sandbox `id` at `origin`, with no alarm: the test runs `tick`. */
  async primed(id: string, origin: string): Promise<void> {
    await this.wake(id, origin);
    await this.ctx.storage.deleteAlarm();
    this.due = null;
  }

  /** How far the test moved the clock ahead of the real one. */
  ahead = 0;
  /** When the alarm `tick` dropped was booked for, by the clock; null with none booked. */
  due: number | null = null;
  /** The clock's time of each wake: new work, which starts the count of failed starts afresh. */
  wokeAt: number[] = [];

  override clock(): number {
    return Date.now() + this.ahead;
  }

  /** A second, not 20: a test's silent container is taken for dead without the wait. */
  override answerWithinMs(): number {
    return 1_000;
  }

  override async wake(id: string, origin?: string): Promise<void> {
    await super.wake(id, origin);
    this.wokeAt.push(this.clock());

    if (!(await this.ctx.storage.get<boolean>(HELD_KEY))) return;
    // Held: no platform alarm comes, but `fire` runs the one the wake booked.
    await this.ctx.storage.deleteAlarm();
    this.due = Math.min(this.due ?? Infinity, this.clock());
  }

  /** Run the alarm once, now, and drop the next one it books: the test says when it comes. */
  async tick(): Promise<void> {
    await super.alarm();
    this.due = await this.ctx.storage.getAlarm();
    await this.ctx.storage.deleteAlarm();
  }

  /** The platform fires the alarm `tick` dropped, at its time: the clock moves there first. False with none booked. */
  async fire(): Promise<boolean> {
    if (this.due === null) return false;
    this.ahead += Math.max(0, this.due - this.clock());
    this.due = null;
    await this.tick();

    return true;
  }

  /** Its consecutive failed saves, and failed starts since the last good one or wake. */
  async failures(): Promise<{ saves: number; starts: number }> {
    const starts = await this.ctx.storage.get<{ attempts: number }>("startFailures");

    return { saves: (await this.ctx.storage.get<number>("saveFailures")) ?? 0, starts: starts?.attempts ?? 0 };
  }

  /** Tick every `tickMs`, and give up on failing starts after `startDeadlineMs`, from now on. */
  async retime(tickMs: number, startDeadlineMs?: number): Promise<void> {
    await this.ctx.storage.put(TICK_KEY, tickMs);

    if (startDeadlineMs !== undefined) await this.ctx.storage.put(START_DEADLINE_KEY, startDeadlineMs);
  }

  /** From now on only `tick` runs the alarm: a wake, or a retry the platform would fire, does nothing. */
  async hold(): Promise<void> {
    await this.ctx.storage.put(HELD_KEY, true);
  }

  override async alarm(): Promise<void> {
    if (await this.ctx.storage.get<boolean>(HELD_KEY)) return;

    return super.alarm();
  }

  /** How many finished turns R2 holds, as the last snapshot, sleep or retire put them there. */
  async snapshotted(): Promise<number> {
    return (await this.ctx.storage.get<number>("snapshot")) ?? 0;
  }

  /** Idle since `ms` ago, as the alarm counts it. */
  async idleFor(ms: number): Promise<void> {
    await this.ctx.storage.put("idleSince", this.clock() - ms);
  }

  override async timing(idleMinutes: number | null): Promise<{ tickMs: number; idleMs: number; startDeadlineMs: number }> {
    const production = await super.timing(idleMinutes);
    const { storage } = this.ctx;

    return {
      tickMs: (await storage.get<number>(TICK_KEY)) ?? TEST_TICK_MS,
      idleMs: (await storage.get<number>(IDLE_KEY)) ?? production.idleMs,
      startDeadlineMs: (await storage.get<number>(START_DEADLINE_KEY)) ?? production.startDeadlineMs
    };
  }

  /**
   * Use the fake container host at `host`, the fake github.com at `github`, sleep after `idleMs` idle,
   * and give up on failing starts after `startDeadlineMs`.
   */
  async configure(host: string, github: string | null, idleMs: number | null, startDeadlineMs: number | null = null): Promise<void> {
    await this.ctx.storage.put(HOST_KEY, host);

    if (github) await this.ctx.storage.put(UPSTREAM_KEY, github);

    if (idleMs === null) await this.ctx.storage.delete(IDLE_KEY);
    else await this.ctx.storage.put(IDLE_KEY, idleMs);

    if (startDeadlineMs === null) await this.ctx.storage.delete(START_DEADLINE_KEY);
    else await this.ctx.storage.put(START_DEADLINE_KEY, startDeadlineMs);
  }

  /** Where the stack's github.internal route sends git: the fake github.com. */
  async upstream(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(UPSTREAM_KEY);
  }

  /** The sandbox the fake host's container runs for, which the stack's github.internal route acts as; none before a start. */
  async caller(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(CALLER_KEY);
  }

  /** Stop the container, forget the sandbox `id`'s save, its alarm and its host, for the next scenario. */
  async reset(id: string): Promise<void> {
    if (await this.box().running()) await this.box().destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.env.FILES.delete(saveKey(id));
  }
}

/** The sandbox `id`'s CloudMachine, `cloud` unless the request's `sandbox` says; the test wrangler config points the binding at this subclass. */
function cloud(env: Env, id: string = CLOUD): DurableObjectStub<CloudMachine> {
  // SAFETY: src/tests/wrangler.jsonc binds CloudMachine to this module's subclass.
  return (env.CloudMachine as DurableObjectNamespace<CloudMachine>).getByName(id);
}

const sandboxOf = (url: URL) => url.searchParams.get("sandbox") ?? CLOUD;

/**
 * The Vault, with a clock the harness can move ahead (`POST /test/vault-clock?ahead=<ms>`), to expire codes
 * and tokens, machine mints it can slow (`slowMachineMints`), to make two pairings race, and the fake OpenAI
 * for ChatGPT's sign-in.
 */
export class Vault extends ProductionVault {
  #slow = { count: 0, ms: 0 };

  override openai = fakeOpenAi(() => this.now()).fetch;

  override github = fakeGithubApi();

  ahead(ms: number): void {
    this.now = () => Date.now() + ms;
  }

  /** Make each of the next `count` machine mints wait `ms` first. */
  slowMachineMints(count: number, ms: number): void {
    this.#slow = { count, ms };
  }

  override async mint(kind: TokenKind, subject: string, ttlMs?: number): Promise<string> {
    if (kind === "machine" && this.#slow.count > 0) {
      this.#slow.count -= 1;
      await scheduler.wait(this.#slow.ms);
    }

    return super.mint(kind, subject, ttlMs);
  }

}

/**
 * ky's real composition with fakes at its outside boundary, for the worker
 * e2e tests and the local stack. Only `boundaryFor` is replaced:
 *
 * - Workers AI is test/fakes/ai.ts behind a fake AI binding, so every object chats
 *   with no secrets, as a fresh deploy does;
 * - the api-key vendors are behind `fetch`: OpenCode Go is the same fake,
 *   and Anthropic and OpenAI are test/fakes/vendors.ts, answering from the
 *   same script, each taking only its own key; a key is added through
 *   Settings as the user adds one, and kept in the real Vault;
 * - each refuses every request while `provider(id, false)` holds: Workers AI
 *   with 429, as out of its free allocation, and OpenCode Go with 402, as
 *   out of credit;
 * - VibeProxy on the Mac, through the overlay's tunnel, is away (refuses
 *   connections) until `mac(true)`, then test/fakes/vibeproxy.ts answers as
 *   Claude; after `tunnelDrops()` the tunnel refuses each message while the
 *   probe still answers;
 * - a machine whose runner shares VIBEPROXY_TEST_PORT has VibeProxy over the
 *   pipe instead, the test's own fake behind it; `pipe()` sends a request
 *   over it as a provider's would (`overPipe()`);
 * - Executor is FakeExecutor, a real MCP server reached through `fetch`;
 * - Browser Rendering is left out: a launch is refused;
 * - other people's kys are other test agents: `https://<name>.peer.test` is the agent `<name>`'s peer
 *   routes, with a Vault of its own (`peerVaultName`), so two test kys pair as two deploys do;
 * - an object named `bare-…` is a deploy with no overlay: no VibeProxy and no
 *   Executor, so Settings shows them as not set up.
 *
 * The fake models answer from the transcript alone, so they give the same
 * answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`; `gate` and `gate-unsafe` call the gate
 *   tools, which wait until the test releases them.
 * - `spawn NAME MESSAGE` spawns a subagent; `machine PROMPT` runs a task on
 *   the machine "mac"; `machine@NAME PROMPT` on another machine.
 * - `executor CODE` runs CODE on Executor.
 * - `tool NAME JSON` calls any tool with those arguments.
 * - An episode reflection keeps the user's first "I'll ..." message as an
 *   open loop, or answers [SILENT].
 * - A dream calls, one by one, each `dream> tool NAME JSON` a user's or a
 *   notice's line of its digest holds; `$ID` in the JSON is that line's
 *   rowid. Then it answers "Dreamt."
 * - A relayed mail whose subject is `tool NAME JSON` asks ky's turn for that call,
 *   which ky says it is trying before it calls.
 * - A prompt containing `model-refuses` gets a 400, which no retry or stand-in mends.
 * - `reply: TEXT` answers TEXT. A check-in's run is answered by the text after
 *   its "What to look at:" line, as if it were the prompt.
 * - After a tool result it answers `tool said: <result>`; anything else is
 *   echoed as `echo: <prompt>`.
 * - Titles are answered `Title: "Named: <first line>"` and a second line,
 *   so their cleaning is exercised; text containing `no-title` gets a 400.
 * - The group chat router picks the ids after `route:` in the message, else
 *   members whose description shares a long word with it, or none. A
 *   specialist in its seat for a chat answers the message as above; a line
 *   `ID> TEXT` in it is @ID's own answer (TEXT, or the tool call it asks
 *   for), and a `Reply: TEXT` line in its brief answers anything else.
 */

/** Gate runs up to this one are released. */
const RELEASED_KEY = "test:gate:released";

const GATE_RUNS_KEY = "test:gate:runs";

/** Whether the fake VibeProxy answers (the Mac is online). */
const MAC_UP_KEY = "test:mac-up";

/** Whether the tunnel drops each message while VibeProxy's probe still answers. */
const TUNNEL_DROPS_KEY = "test:tunnel-drops";

/** The status each fake provider refuses every request with while it is down. */
const REFUSALS = { "workers-ai": 429, "opencode-go": 402 } as const;

type FakeProvider = keyof typeof REFUSALS;

const downKey = (provider: FakeProvider) => `test:down:${provider}`;

/** The token the fake Executor wants. */
export const EXECUTOR_TOKEN = "ky-stack-executor";

export const EXECUTOR_URL = "https://executor.test/mcp";

/** Objects whose name starts with this have no VibeProxy and no Executor, as a deploy without the owner overlay. */
export const BARE = "bare-";

/** Objects whose name starts with this are seeded on first start, as a new deploy is; the rest start empty. */
export const FRESH = "fresh-";

/** Objects whose name holds this reuse a runner-local probe's answer for 30s, as production does; the rest ask afresh each time. */
export const STEADY = "steady-";

/** A key OpenCode Go's fake takes; it takes any. */
export const OPENCODE_KEY = "opencode-test-key";

/** Workers AI's models: the default, which reads images, the next, and the text-only one. */
export const GLM = "workers-ai/@cf/zai-org/glm-5.3-flash";

export const KIMI = "workers-ai/@cf/moonshotai/kimi-k2.6";

export const GPT_OSS = "workers-ai/@cf/openai/gpt-oss-120b";

/** The peer test host of each test ky: `https://<agent name>.peer.test`. */
const PEER_HOST = /^([a-z0-9-]+)\.peer\.test$/;

/** A test ky's own Vault, for its peer tokens; production's agent "me" has the Vault "owner". */
export const peerVaultName = (agent: string) => `peer-vault-${agent}`;

/** The test boundary, with its fakes in reach. */
export type TestBoundary = Boundary & {
  readonly executorFake: FakeExecutor;
  /** Every request to Workers AI and the api-key vendors, as the wire carried it. */
  readonly calls: AiCall[];
  /** Each request's user messages' text, as the wire carried them (a turn-start recall block included), in order. */
  readonly asked: string[][];
  /** Every mail Email Service was asked to send; one to an address with "bounce" in it is refused. */
  readonly mailSent: EmailMessageBuilder[];
};

/** A test ky's own address. A ky named with NO_MAIL has none, as a deploy with no domain. */
export const MAIL_ADDRESS = "ky@mail.test";

export const NO_MAIL = "nomail-";

const call = (tool: string, args: Record<string, JsonValue>): Reply => ({ tool, args });

/** What the background model is asked: a name, or a summary of notes or of a task. */
function title(text: string): Reply {
  if (text.includes("no-title")) return { status: 400, error: "The fake titles model refuses this text." };

  return { text: `Title: "Named: ${text.split("\n")[0]}"\nA second line the cleaning drops.` };
}

/**
 * Memory's summary writer: "first to last" of the notes it compresses, or of
 * the two lines it merges, so "memory 0 to memory 7" covers the notes 0 to 7.
 */
function compress(text: string): Reply {
  // The step's lines follow its "Compress these" or "Merge these" line.
  const items = text.split(/\n(?:Compress|Merge) these[^\n]*\n/).at(-1)?.split("\n") ?? [];

  return { text: `${items[0]?.split(" to ")[0]} to ${items.at(-1)?.split(" to ").at(-1)}` };
}

/** The group chat router: the ids after `route:` in the message, else the members whose description shares a word of 5 letters or more with it. */
function router(text: string): Reply {
  const message = text.split("\nMessage:\n").at(-1) ?? "";
  const named = /\broute: ([^\n]+)/.exec(message)?.[1];

  if (named !== undefined) return { text: named };
  const words = new Set(message.toLowerCase().match(/[a-z]{5,}/g) ?? []);

  const fits = [...text.matchAll(/^- ([a-z0-9-]+): (.*)$/gm)].filter(([, , description]) =>
    (description!.toLowerCase().match(/[a-z]{5,}/g) ?? []).some((word) => words.has(word))
  );

  return { text: fits.map(([, id]) => id).join(", ") || "none" };
}

/** The background's requests, by how their system prompt starts, and how each is answered from its user text. */
const BACKGROUND: Array<[string, (asked: string) => Reply]> = [
  ["You pick which specialists", router],
  ["You name things", title],
  ["You summarize", title],
  ["You write the memory of ky", compress]
];

/** A turn-start recall block (src/dreaming/recall.ts) at the end of a user message: the fakes answer what the user said. */
const RECALLED = /\n\n<recalled>\n[\s\S]*<\/recalled>$/;

/** `messages` with any recall block taken off the user's messages. */
const unrecalled = (messages: readonly WireMessage[]): WireMessage[] =>
  messages.map((message) => (message.role === "user" && RECALLED.test(wireText(message.content)) ? { ...message, content: wireText(message.content).replace(RECALLED, "") } : message));

function script(messages: readonly WireMessage[]): Reply {
  const system = wireText(messages.find((message) => message.role === "system")?.content);
  const background = BACKGROUND.find(([start]) => system.startsWith(start));

  if (background) return background[1](wireText(messages.find((message) => message.role === "user")?.content));

  // pi places system-prompt changes positionally, so a system message can follow the user's input.
  const last = messages.filter((message) => message.role !== "system").at(-1);
  const seat = last?.role === "user" ? /^\[a message in the user's chat\][\s\S]*?\nThe user's message:\n([\s\S]*)$/.exec(wireText(last.content)) : null;

  if (seat) {
    const prompts = messages.flatMap((message) => (message.role === "system" ? [wireText(message.content)] : [])).join("\n");
    const id = /You are @([a-z0-9-]+)/.exec(prompts)?.[1];
    const own = id && new RegExp(`^${id}> (.+)$`, "m").exec(seat[1]!);

    // A brief's `Reply:` line is what it says to anything.
    const brief = /^Reply: (.+)$/m.exec(prompts);

    if (!own) return brief ? { text: brief[1]! } : answer(seat[1]!);
    // Its own line calls a tool as a prompt would, or is said as it is.
    const call = CALLS.find(([pattern]) => pattern.test(own[1]!));

    return call ? call[1](call[0].exec(own[1]!)!) : { text: own[1]! };
  }

  return reply(last);
}

/** A line of a dream's digest (src/history.ts since) that the user said or ky relayed: its rowid, who, and the text. */
const DIGEST_LINE = /^#(\d+) \S+ .*?, (user|notice): (.*)$/gm;

/** The JSON object starting at `start` in `text`, braces balanced outside its strings; undefined when it is cut off. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;

  for (let at = start; at < text.length; at++) {
    const char = text[at];

    if (quoted) {
      if (char === "\\") at++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, at + 1);
  }

  return undefined;
}

/**
 * A dream (src/dreaming/dreaming.ts) calls the tools its digest asks for: each `dream> tool NAME {json}` in a line the
 * user said or ky relayed, in the digest's order, one a round, then answers "Dreamt.". In the JSON, `$ID` is that
 * line's rowid. Undefined for any other turn.
 */
function dreamt(messages: readonly WireMessage[]): Reply | undefined {
  const at = messages.findLastIndex((message) => message.role === "user");
  const prompt = at < 0 ? "" : wireText(messages[at]!.content);

  if (!prompt.startsWith("[dream]")) return undefined;
  const lines = [...prompt.matchAll(DIGEST_LINE)];

  const calls = lines.flatMap(([, id, , text]) =>
    [...text!.matchAll(/dream> tool (\S+) /g)].flatMap((found) => {
      const json = objectAt(text!, found.index + found[0].length);

      // SAFETY: the tests write a JSON object after the tool name, as for `tool NAME JSON`.
      return json === undefined ? [] : [call(found[1]!, JSON.parse(json.replaceAll("$ID", id!)) as Record<string, JsonValue>)];
    })
  );

  return calls[messages.slice(at + 1).filter((message) => message.role === "tool").length] ?? { text: "Dreamt." };
}

/**
 * A look (src/dreaming/looks.ts) answers with the rows its digest asks for: each `look> {json}` in a line said in a
 * chat, in the digest's order, as one JSON array. Undefined for any other turn.
 */
function looked(messages: readonly WireMessage[]): Reply | undefined {
  const last = messages.findLast((message) => message.role === "user");
  const prompt = last === undefined ? "" : wireText(last.content);

  if (!prompt.startsWith("[look]")) return undefined;
  const rows = [...prompt.matchAll(/look> /g)].flatMap((found) => objectAt(prompt, found.index + found[0].length) ?? []);

  return { text: `[${rows.join(",")}]` };
}

/** The answer to a turn's last message: the user's input, or a tool's result. */
function reply(last: WireMessage | undefined): Reply {
  // The wire does not say whether a tool failed; its result is its text either way.
  if (last?.role === "tool") return { text: `tool said: ${wireText(last.content)}` };

  const prompt = last?.role === "user" ? wireText(last.content) : "";

  return prompt.startsWith("[episode]") ? episode(prompt) : answer(prompt);
}

/**
 * An episode reflection (src/dreaming/episodes.ts) keeps the first promise the user made ("I'll ..."), citing its
 * message, and answers [SILENT] when there is none.
 */
function episode(prompt: string): Reply {
  const promise = /^#(\d+) user: (I'll .+)$/m.exec(prompt);

  return promise ? call("anticipate", { action: "add", kind: "open_loop", text: promise[2]!, messages: [Number(promise[1])] }) : { text: "[SILENT]" };
}

/** The prompts that call a tool: each pattern, and the call its match makes. */
const CALLS: Array<[RegExp, (match: RegExpExecArray) => Reply]> = [
  [/^multiply (\d+)$/, (match) => call("multiply", { value: Number(match[1]) })],
  [/^spawn (\S+) (.+)$/s, (match) => call("subagent", { action: "spawn", name: match[1]!, message: match[2]! })],
  [/^machine(?:@(\S+))? (.+)$/s, (match) => call("machine", { action: "run", machine: match[1] ?? "mac", prompt: match[2]! })],
  [/^executor (.+)$/s, (match) => call("executor_execute", { code: match[1]! })],
  // SAFETY: the tests write a JSON object after the tool name, here and below; a bad one fails the turn loudly.
  [/^tool (\S+) (\{.*\})$/s, (match) => call(match[1]!, JSON.parse(match[2]!) as Record<string, JsonValue>)],
  [/^gate$/, () => call("gate", {})],
  [/^gate-unsafe$/, () => call("gate_unsafe", {})]
];

/** Prompts answered as the part of them the model is asked about, and what the model says first when it calls a tool for one. */
const FORWARDS: Array<[RegExp, string?]> = [
  // A check-in's run is answered by what it says to look at.
  [/^\[check-in\][\s\S]*\nWhat to look at:\n([\s\S]*)$/],
  // A mail ky relays into the chat (src/mail.ts arrived) whose summary is a `tool` line: the chat's model says so, then tries it.
  [/^\[mail [^\n]*\]\n\nMail says: (tool \S+ \{.*\})$/m, "Trying what the mail asks."],
  // A peer conversation answers the question after the rules it answers by (src/peers/peers.ts peerQuestion).
  [/^\[a question from [^\]]+\][\s\S]*?\nQuestion:\n([\s\S]*)$/]
];

/** `reply`, with `say` written before it when it is a tool call. */
const narrated = (reply: Reply, say: string | undefined): Reply => (say !== undefined && "tool" in reply ? { ...reply, say } : reply);

/** The answer to a user's prompt: the tool call it asks for, or an echo. */
function answer(prompt: string): Reply {
  const forward = FORWARDS.map(([pattern, say]) => ({ match: pattern.exec(prompt), say })).find(({ match }) => match !== null);

  if (forward) return narrated(answer(forward.match![1]!), forward.say);

  const said = /^reply: (.+)$/s.exec(prompt);

  if (said) return { text: said[1]! };

  if (prompt.includes("model-refuses")) return { status: 400, error: "The fake model refuses this prompt." };

  // A triage reads a mail (src/mail.ts mailTriage): a newsletter needs nobody; a `tool` line in it is tried, as a mail
  // that talks the model round would; anything else is summed up by its subject.
  const mail = /^\[a mail to ky from [^\]]+\][\s\S]*?\nSubject: (.*)\n\n([\s\S]*)$/.exec(prompt);

  if (mail) {
    const tool = /^tool \S+ \{.*\}$/m.exec(mail[2]!);

    if (tool) return answer(tool[0]);

    return { text: /newsletter/i.test(mail[2]!) ? "NOTHING_NEW" : `Mail says: ${mail[1]}` };
  }

  for (const [pattern, make] of CALLS) {
    const match = pattern.exec(prompt);

    if (match) return make(match);
  }

  return { text: `echo: ${prompt}` };
}

const NoParameters = Type.Object({});

/** The real agent with the fakes above, a multiply tool, and gate tools the test opens. */
export class PiAgent extends ProductionAgent {
  declare readonly boundary: TestBoundary;
  /** Task token issues still to fail; read only once the hub calls, after this field is set. */
  #failingIssues = 0;

  /** Fail the next `count` task token issues, as a Vault call that failed: the agent's own catch sees the error. */
  failIssues(count: number): void {
    this.#failingIssues = count;
  }

  /** The task token issues still to fail. */
  failingIssues(): number {
    return this.#failingIssues;
  }

  override taskTokens(): TaskTokens {
    const tokens = super.taskTokens();

    return {
      ...tokens,
      issue: async (task) => {
        if (this.#failingIssues === 0) return tokens.issue(task);
        this.#failingIssues -= 1;

        throw new Error("The test agent failed this issue.");
      }
    };
  }

  override boundaryFor(): TestBoundary {
    // Runs as the first field initializer: only ctx and env are set.
    const storage = this.ctx.storage;
    const executorFake = new FakeExecutor(EXECUTOR_TOKEN);
    const calls: AiCall[] = [];
    const asked: string[][] = [];

    // The fakes record what each request asked, and answer as if no block were there.
    const answering = (messages: readonly WireMessage[]) => {
      asked.push(messages.flatMap((message) => (message.role === "user" ? [wireText(message.content)] : [])));

      return dreamt(messages) ?? looked(messages) ?? script(unrecalled(messages));
    };

    const gate = (name: string, replay: "safe" | "unsafe") =>
      defineTool({
        name,
        description: "Wait until the test releases it.",
        parameters: NoParameters,
        replay,
        async execute(_args, api, context) {
          const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
          await storage.put(GATE_RUNS_KEY, runs);
          api.output(`run ${runs}\n`);

          while (((await storage.get<number>(RELEASED_KEY)) ?? 0) < runs) {
            context.abortSignal?.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          return { content: [{ type: "text", text: `released after ${runs} runs` }] };
        }
      });

    const multiply = defineTool({
      name: "multiply",
      description: "Multiply by three.",
      parameters: Type.Object({ value: Type.Number() }),
      replay: "safe",
      execute: async ({ value }) => ({
        content: [{ type: "text", text: String(value * 3) }],
        details: { result: value * 3 }
      })
    });

    const bare = this.ctx.id.name?.startsWith(BARE) === true;
    const mailSent: EmailMessageBuilder[] = [];

    const mail = {
      address: MAIL_ADDRESS,
      send: async (message: EmailMessageBuilder) => {
        if (JSON.stringify(message.to).includes("bounce")) throw new Error("The fake Email Service refuses this address.");
        mailSent.push(message);

        return { messageId: `<sent-${mailSent.length}@mail.test>` };
      }
    };

    const refusing = (provider: FakeProvider) => async () =>
      (await storage.get<boolean>(downKey(provider))) === true ? REFUSALS[provider] : undefined;

    return {
      ai: fakeAI(chatCompletions(answering, calls, refusing("workers-ai"))),
      fetch: vendors(answering, calls, chatCompletions(answering, calls, refusing("opencode-go"))),
      vibeProxy: {
        port: VIBEPROXY_TEST_PORT,
        key: VIBEPROXY_KEY,
        tunnel: bare
          ? undefined
          : {
              binding: {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  const request = new Request(input, init);
                  const drops = (await storage.get<boolean>(TUNNEL_DROPS_KEY)) === true && new URL(request.url).pathname === "/v1/messages";

                  return (await storage.get<boolean>(MAC_UP_KEY)) === true && !drops ? fakeVibeProxy(request) : refusingVibeProxy();
                }
              },
              origin: "http://127.0.0.1:8317"
            }
      },
      // Test-only: every turn asks VibeProxy afresh, so a test sees the Mac leave at once. Production reuses an answer for 30s.
      probeTtlMs: this.ctx.id.name?.includes(STEADY) === true ? undefined : 0,
      browser: { fetch: async () => new Response("no Browser Rendering in the local stack", { status: 503 }) },
      executorFetch: executorFake.fetch,
      // Each test ky calls from an address of its own, so only a test that means to meets the pair route's limit.
      peerFetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("CF-Connecting-IP", this.ctx.id.name ?? "unknown");

        return kys.fetch(request, this.env);
      },
      seeds: this.ctx.id.name?.startsWith(FRESH) === true,
      extensions: [defineExtension({ name: "test-tools", tools: [multiply, gate("gate", "safe"), gate("gate_unsafe", "unsafe")] })],
      mail: this.ctx.id.name?.startsWith(NO_MAIL) === true ? undefined : mail,
      executorFake,
      calls,
      asked,
      mailSent
    };
  }

  protected override peerVault(): DurableObjectStub<Vault> {
    // SAFETY: src/tests/wrangler.jsonc binds Vault to this module's subclass.
    return (this.env.Vault as DurableObjectNamespace<Vault>).getByName(peerVaultName(this.ctx.id.name ?? "me"));
  }

  /** How many times a gate tool has started. */
  async gateRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
  }

  /** Open every gate started so far; later gates wait for the next release. */
  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASED_KEY, await this.gateRuns());
  }

  /** Bring the Mac's VibeProxy up or take it away, probe it as PiAgent does on start, and move the chats to the main purpose. */
  async mac(up: boolean): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, up);
    await this.models.probe();
    await this.applyMain();
  }

  /** Let a fake provider answer, or refuse every request from now on. */
  async provider(id: FakeProvider, up: boolean): Promise<void> {
    await this.ctx.storage.put(downKey(id), !up);
  }

  /** Dream now, as the nightly fire does once the user has been away a while, and wait for it to finish. */
  async dream(): Promise<void> {
    this.presence.seen(Date.now() - 3 * 3_600_000);
    await this.dreaming.run();
  }

  /** A look at `time`, as its booking would run it. */
  async look(time: string): Promise<void> {
    await this.looks.run(time);
  }

  /**
   * A night's dream, as Activity › Last night lists it, through the real skill library, memory and ledger: two
   * skills the agent wrote, then a dream that forgets a memory summary, edits one skill, merges the other into
   * it and makes a third. Each name ends in `tag`. Answers with the dream's ledger rows.
   */
  async seedDreamNight(tag: string): Promise<DreamLedgerRow[]> {
    const [groceries, run, tea] = [`weekly-groceries-${tag}`, `grocery-run-${tag}`, `tea-order-${tag}`];

    for (const name of [groceries, run]) {
      this.skills.apply({ action: "create", name, description: `Ordering groceries (${tag})`, body: "1. Open the list.\n2. Order oat milk." }, "agent");
    }

    const from = this.memory.count();
    this.memory.note(`the user drinks green tea (${tag})`);
    this.memory.note(`the user switched to oolong (${tag})`);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO memo_tree (lo, hi, text) VALUES (?, ?, ?)", from, from + 2, `the user drinks green tea, then oolong (${tag})`);

    const { id } = await this.harness.sessions.create();
    this.reviews.add(id, "", "dream", { run: `dream-${tag}` });
    this.memory.forget(`${from}-${from + 1}`, id);
    this.skills.apply({ action: "patch", name: groceries, old: "oat milk", new: "oat milk, and tea on Fridays", reason: "You order tea every Friday" }, "dream", id);
    this.skills.apply({ action: "archive", name: run, absorbed_into: groceries, reason: `Same steps as ${groceries}` }, "dream", id);
    this.skills.apply({ action: "create", name: tea, description: "Ordering tea", body: "1. Order oolong.", reason: "You asked for tea three times" }, "dream", id);

    return this.ledger.lastNight().filter((row) => row.run === `dream-${tag}`);
  }

  /** Review turns with at least this many tool calls; in memory, so a restart puts back the default. */
  reviewAfterTools(count: number): void {
    this.skills.reviewAfter = count;
  }

  /** The Mac goes away and nothing has asked it since: the catalog still shows Claude connected. */
  async macLeaves(): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, false);
  }

  /**
   * Send `path` to `port` on `machine` over the pipe, as a provider does, and say how it went: its status and
   * body, or why it failed. `abortAfterMs` aborts it that long after its head; `timeoutMs` shortens the pipe's wait.
   */
  async overPipe(machine: string, port: number, path: string, { abortAfterMs, timeoutMs }: { abortAfterMs?: number; timeoutMs?: number } = {}): Promise<{ status?: number; body?: string; failed?: string }> {
    const before = this.pipe.timeoutMs;
    const abort = new AbortController();

    if (timeoutMs !== undefined) this.pipe.timeoutMs = timeoutMs;

    try {
      const response = await this.pipe.fetcher(machine, port)(`http://127.0.0.1:${port}${path}`, { signal: abort.signal });

      if (abortAfterMs !== undefined) setTimeout(() => abort.abort(), abortAfterMs);

      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    } finally {
      this.pipe.timeoutMs = before;
    }
  }

  /** Drop every message on the tunnel while VibeProxy's probe still answers, as a tunnel that fails mid-call does. */
  async tunnelDrops(): Promise<void> {
    await this.ctx.storage.put(TUNNEL_DROPS_KEY, true);
  }
}

/** The PiAgent binding, which the test wrangler config points at this subclass. */
export function agents(env: Env): DurableObjectNamespace<PiAgent> {
  // SAFETY: src/tests/wrangler.jsonc binds PiAgent to this module's subclass.
  return env.PiAgent as DurableObjectNamespace<PiAgent>;
}

type Me = DurableObjectStub<PiAgent>;

/** The test routes: method and path, and what they do to the agent `me` or the Vault. */
const ROUTES = new Map<string, (me: Me, url: URL, env: Env) => Promise<Response>>([
  [
    "POST /test/release",
    async (me) => {
      await me.release();

      return new Response(null, { status: 204 });
    }
  ],
  ["GET /test/gate-runs", async (me) => Response.json({ runs: await me.gateRuns() })],
  [
    "POST /test/dream",
    async (me) => {
      await me.dream();

      return new Response(null, { status: 204 });
    }
  ],
  [
    "POST /test/look",
    async (me, url) => {
      await me.look(url.searchParams.get("time") ?? "08:00");

      return new Response(null, { status: 204 });
    }
  ],
  // A dream's night of changes, each name ending in tag=; answers with its ledger rows.
  ["POST /test/dream-night", async (me, url) => Response.json(await me.seedDreamNight(url.searchParams.get("tag") ?? "seed"))],
  // n is the tool calls a turn needs to be reviewed for skills; 5 is ky's default.
  [
    "POST /test/review-after",
    async (me, url) => {
      await me.reviewAfterTools(Number(url.searchParams.get("n") ?? "5"));

      return new Response(null, { status: 204 });
    }
  ],
  // up=1 brings the Mac online; up=0 takes it away; up=leaves takes it away unnoticed until ky next asks.
  [
    "POST /test/mac",
    async (me, url) => {
      const up = url.searchParams.get("up");
      await (up === "leaves" ? me.macLeaves() : me.mac(up === "1"));

      return new Response(null, { status: 204 });
    }
  ],
  // A request over the pipe: machine, port and path; abort-after (ms after its head) and timeout (ms) are optional.
  [
    "POST /test/pipe",
    async (me, url) => {
      const number = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
      const { searchParams } = url;

      return Response.json(
        await me.overPipe(searchParams.get("machine") ?? "", number("port") ?? 0, searchParams.get("path") ?? "/", {
          abortAfterMs: number("abort-after"),
          timeoutMs: number("timeout")
        })
      );
    }
  ],
  [
    "POST /test/vault-clock",
    async (_me, url, env) => {
      // SAFETY: src/tests/wrangler.jsonc binds Vault to this module's subclass.
      await (env.Vault as DurableObjectNamespace<Vault>).getByName("owner").ahead(Number(url.searchParams.get("ahead") ?? "0"));

      return new Response(null, { status: 204 });
    }
  ],
  // The cloud machine's fake container host (url), fake github.com (github), idle time in ms (idle) and start deadline in ms (startDeadline).
  [
    "POST /test/cloud-host",
    async (_me, url, env) => {
      const { searchParams } = url;

      await cloud(env, sandboxOf(url)).configure(searchParams.get("url") ?? "", searchParams.get("github"), searchParams.has("idle") ? Number(searchParams.get("idle")) : null, searchParams.has("startDeadline") ? Number(searchParams.get("startDeadline")) : null);

      return new Response(null, { status: 204 });
    }
  ],
  // Put the cloud machine to sleep now, as its idle time running out does: 409 while it has work, or nothing runs.
  ["POST /test/cloud-sleep", async (_me, url, env) => new Response(null, { status: (await cloud(env, sandboxOf(url)).sleep()) ? 204 : 409 })],
  [
    "POST /test/cloud-reset",
    async (_me, url, env) => {
      await cloud(env, sandboxOf(url)).reset(sandboxOf(url));

      return new Response(null, { status: 204 });
    }
  ],
  // How many of the sandbox's turns have ended, and how many had when R2 last took its disk.
  [
    "GET /test/cloud-snapshot",
    async (me, url, env) =>
      Response.json({ turnsEnded: (await me.sandboxNow(sandboxOf(url)))?.turnsEnded ?? 0, snapshotted: await cloud(env, sandboxOf(url)).snapshotted() })
  ]
]);

/** Access with the team's keys from the fake: every FakeAccess signs with them. */
const access = new Access(new FakeAccess().certs);

const ky = worker(access);

/** GitHub's REST API, for the GitHub tools on the stack's github.internal. */
const githubRest = fakeGithubRest();

const stack = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const signed = edge(request);
    const url = new URL(signed.url);

    // Access's login page, for a person opening the stack in their own browser: it signs the owner in
    // with the fake's key and goes home. Playwright and the harness set the cookie themselves.
    if (url.pathname === "/cdn-cgi/access/login") {
      const cookie = `CF_Authorization=${await new FakeAccess().sign()}; Path=/; HttpOnly; SameSite=Lax`;

      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie } });
    }

    // The container's github.internal, which production intercepts in the container's network: the
    // fake container host's git and `ky github` reach it here, with no sign-in, as the container has none.
    if (url.pathname.startsWith("/github.internal/")) {
      const upstream = await cloud(env).upstream();
      const caller = await cloud(env).caller();
      const me = agents(env).getByName("me");
      url.pathname = url.pathname.slice("/github.internal".length);
      // As GithubProxy: the repos the calling sandbox may reach, none before its container started.
      const login = allowedRepos(await env.Vault.getByName("owner").githubToken(), caller === undefined ? null : await me.reposFor(caller));

      if (url.pathname.startsWith("/api/github/")) return githubTool(new Request(url, request), login, githubRest, await me.selfEditRepo());

      return proxyGit(new Request(url, request), login, upstream);
    }

    if (!url.pathname.startsWith("/test/")) {
      const response = await ky.fetch(signed, env);

      // A browser opening a page without its cookie still gets ky's refusal, with a link to the fake's login page.
      if (response.status === 401 && request.method === "GET" && request.headers.get("Sec-Fetch-Mode") === "navigate") {
        const refusal = await response.text();
        const page = `<!doctype html><meta name="viewport" content="width=device-width"><p>${refusal}</p><p><a href="/cdn-cgi/access/login">Sign in as the owner</a></p>`;

        return new Response(page, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return response;
    }

    // The CLI harness and Playwright drive the fakes over HTTP, behind the same Access as everything else.
    const refused = await access.refuse(signed, env);

    if (refused) return refused;

    const route = ROUTES.get(`${signed.method} ${url.pathname}`);

    return route ? route(agents(env).getByName("me"), url, env) : new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

/** Another test ky's address, as a peer reaches it: only its peer routes, which Access lets through; undefined for ky's own. */
function peerHost(request: Request, env: Env): Promise<Response> | undefined {
  const url = new URL(request.url);
  const peer = PEER_HOST.exec(url.hostname)?.[1];

  if (!peer) return undefined;

  return peerRoute(request, env, url, { agent: peer, vault: peerVaultName(peer) }) ?? Promise.resolve(new Response("Not found", { status: 404 }));
}

/** The stack, and each test ky's peer routes at its own address. */
const kys = {
  fetch: (request: Request, env: Env): Promise<Response> => peerHost(request, env) ?? stack.fetch(request, env),
  email: (message: ForwardableEmailMessage, env: Env): Promise<void> => ky.email(message, env)
} satisfies ExportedHandler<Env>;

export default kys;
