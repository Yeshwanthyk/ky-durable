#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * verify-ky-machines: timed probes of how ky connects to machines and runs tasks on them, against
 * the local stack with the real runner (`ky runner run`) and a fake claude, through the harness's
 * fault proxy. Each probe prints its timings and, for each invariant it checks, HOLDS or GAP.
 *
 *   node --experimental-strip-types --no-warnings .claude/skills/verify-ky-machines/bench.ts [probe...|all] [--runs N] [--quick]
 *
 * Probes: latency, restart, skew, hang, offline, halfopen, cloud. `--quick` skips halfopen (70s).
 * Results: test-results/machines-bench/results.json, runner and fake-claude logs beside it.
 * It never touches the deployed Worker, ~/.ky or ~/.claude. `live.sh` is the read-only live check.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocket as Socket } from "ws";
import { decodeObjectFrame, OUTDATED, PROTOCOL, RUNNER_PATH } from "../../../src/machines/contract.ts";
import type { RunnerReport } from "../../../src/machines/contract.ts";
import { signedIn } from "../../../src/tests/fake-access.ts";
import { type Client, connect, until } from "../../../test/harness/client.ts";
import { startProxy, type Proxy } from "../../../test/harness/proxy.ts";
import { FAKE_CLAUDE, FAKE_CODEX, KY_COMMAND, machine, type Machine, pairingCode, type Runner } from "../../../test/harness/runner.ts";
import { REPO, useStack } from "../../../test/harness/stack.ts";
import { serveContainer } from "../../../test/fakes/container.ts";
import { serveGit } from "../../../test/fakes/git.ts";

type Verdict = { invariant: string; holds: boolean; detail: string };
type Result = { probe: string; timings: Record<string, number | string>; verdicts: Verdict[]; error?: string };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const RUNS = option("--runs", 5);
const PROBES = ["latency", "restart", "skew", "hang", "offline", "halfopen", "cloud"] as const;
const named = args.filter((arg) => (PROBES as readonly string[]).includes(arg));
const chosen = named.length > 0 && !args.includes("all") ? named : PROBES.filter((probe) => !(flag("--quick") && probe === "halfopen"));

const out = path.join(REPO, "test-results/machines-bench");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const stack = await useStack(out);
const { url } = stack;
const main = await connect(url);
const cleanup: Array<() => unknown> = [];
const runners: Runner[] = [];

/** A tap on the proxy: every runner report, timestamped, none dropped. */
function tap(proxy: Proxy): Array<{ at: number; report: RunnerReport }> {
  const seen: Array<{ at: number; report: RunnerReport }> = [];
  proxy.dropWhen((report) => {
    seen.push({ at: Date.now(), report });

    return false;
  });

  return seen;
}

function online(name: string): boolean {
  const latest = main.frames.findLast((frame) => frame.type === "tasks");

  return latest?.type === "tasks" && latest.machines.some((each) => each.name === name && each.online);
}

function machineRow(name: string): Record<string, unknown> | undefined {
  const latest = main.frames.findLast((frame) => frame.type === "tasks");

  return latest?.type === "tasks" ? (latest.machines.find((each) => each.name === name) as unknown as Record<string, unknown>) : undefined;
}

async function paired(name: string, proxy: Proxy, env: Record<string, string> = {}): Promise<{ mac: Machine; runner: Runner }> {
  const mac = machine(name, out);
  const result = await mac.pair(proxy.url, await pairingCode(url));

  if (result.code !== 0) throw new Error(`${name} did not pair: ${result.output}`);
  const runner = mac.launch(proxy.url, env);
  runners.push(runner);

  return { mac, runner };
}

async function fresh(name: string, env: Record<string, string> = {}) {
  const proxy = await startProxy(url);
  cleanup.push(() => proxy.close());
  const reports = tap(proxy);
  const launchedAt = Date.now();
  const { mac, runner } = await paired(name, proxy, env);
  await until(`${name} online`, () => online(name), 30_000);

  return { proxy, reports, mac, runner, onlineMs: Date.now() - launchedAt };
}

/** Ask the faux model to start a task on `name`; resolves with its id and when the row appeared. */
async function startTask(name: string, prompt: string, client: Client = main): Promise<{ id: string; sentAt: number; rowAt: number }> {
  const known = new Set(client.frames.flatMap((frame) => (frame.type === "tasks" ? frame.tasks.map((row) => row.id) : [])));
  const sentAt = Date.now();
  client.send({ type: "submit", input: `machine@${name} ${prompt}` });
  let id: string | undefined;
  await until(`a task on ${name}`, () => {
    const latest = client.frames.findLast((frame) => frame.type === "tasks");
    id = latest?.type === "tasks" ? latest.tasks.find((row) => row.worker === name && !known.has(row.id))?.id : undefined;

    return id !== undefined;
  }, 30_000);

  return { id: id!, sentAt, rowAt: Date.now() };
}

const status = (task: string) => main.task(task)?.status;

async function when(what: string, check: () => boolean, timeoutMs: number): Promise<number | undefined> {
  try {
    await until(what, check, timeoutMs);

    return Date.now();
  } catch {
    return undefined;
  }
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
};

/** A claude that never starts: answers `auth` like a signed-in one, then for a task reads nothing, says nothing and ignores SIGINT. */
function hangingClaude(): string {
  const file = path.join(out, "hanging-claude.mjs");
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n"); process.exit(0); }
if (process.argv[2] === "--version") { process.stdout.write("2.0.0 (Claude Code)\\n"); process.exit(0); }
const log = process.env.FAKE_CLAUDE_LOG;
if (log) appendFileSync(log, JSON.stringify({ event: "start", task: process.env.KY_TASK ?? "", session: "", pid: process.pid, at: Date.now() }) + "\\n");
process.on("SIGINT", () => {});
setInterval(() => {}, 1 << 30);
`
  );
  chmodSync(file, 0o755);

  return file;
}

const PROBE_FNS: Record<(typeof PROBES)[number], () => Promise<Result>> = {
  /** send → task row → ack → agent spawned → working (session) → first step → done, over N runs. */
  async latency() {
    const { reports, mac, onlineMs } = await fresh("bench-latency");
    const rows: Record<string, number[]> = { row: [], ack: [], spawn: [], working: [], step: [], done: [] };

    for (let run = 0; run < RUNS; run++) {
      const { id, sentAt, rowAt } = await startTask("bench-latency", `[delay=200] [tools=Bash:true] latency run ${run}`);
      const doneAt = await when("done", () => status(id) === "done", 30_000);
      const ack = reports.find((each) => each.at >= sentAt && each.report.type === "ack")?.at;
      const session = reports.find((each) => each.report.type === "session" && "task" in each.report && each.report.task === id)?.at;
      const step = reports.find((each) => each.report.type === "step" && "task" in each.report && each.report.task === id)?.at;
      const spawn = mac.claude().find((event) => event.event === "start" && event.task === id)?.at;
      rows.row!.push(rowAt - sentAt);
      if (ack) rows.ack!.push(ack - rowAt);
      if (spawn) rows.spawn!.push(spawn - rowAt);
      if (session) rows.working!.push(session - rowAt);
      if (step) rows.step!.push(step - rowAt);
      if (doneAt) rows.done!.push(doneAt - rowAt);
    }

    const timings: Record<string, number> = { runs: RUNS, "connect→online ms": onlineMs };

    for (const [name, values] of Object.entries(rows)) {
      timings[`${name} p50 ms`] = pct(values, 50);
      timings[`${name} p95 ms`] = pct(values, 95);
    }

    return {
      probe: "latency",
      timings,
      verdicts: [
        { invariant: "pickup (task row → runner ack) p95 under 1s on a connected machine", holds: timings["ack p95 ms"]! < 1000, detail: `${timings["ack p95 ms"]} ms` },
        { invariant: "first visible output (row → first step) p95 under 2s with a fast agent", holds: timings["step p95 ms"]! < 2000, detail: `${timings["step p95 ms"]} ms` }
      ]
    };
  },

  /** The runner stopped mid-task the way launchd's SIGTERM stops it, with an agent slow to exit: orphans, then the relaunch. */
  async restart() {
    const { mac, runner, proxy } = await fresh("bench-restart", { FAKE_CLAUDE_SIGINT_MS: "15000" });
    const { id } = await startTask("bench-restart", "[delay=20000] long task");
    await until("working", () => status(id) === "working", 20_000);
    const pid = mac.claude().find((event) => event.event === "start" && event.task === id)?.pid;
    const stoppedAt = Date.now();
    await runner.stop();
    const runnerGoneMs = Date.now() - stoppedAt;
    await sleep(6_000);
    const orphaned = pid !== undefined && alive(pid);
    const relaunchAt = Date.now();
    runners.push(mac.launch(proxy.url, { FAKE_CLAUDE_SIGINT_MS: "15000" }));
    const backAt = await when("online again", () => online("bench-restart"), 30_000);
    const endedAt = await when("the task to settle", () => status(id) !== "working" && status(id) !== "queued", 15_000);
    const after = main.history(id).at(-1) ?? "";
    const reran = mac.claude().filter((event) => event.event === "start" && event.task === id).length;

    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");

    return {
      probe: "restart",
      timings: {
        "runner exit ms": runnerGoneMs,
        "relaunch→online ms": backAt ? backAt - relaunchAt : "never",
        "relaunch→task settled ms": endedAt ? endedAt - relaunchAt : "still open",
        "task after relaunch": after,
        "agent starts for the task": reran
      },
      verdicts: [
        { invariant: "no orphan: the agent is gone 6s after its runner exits", holds: !orphaned, detail: orphaned ? `pid ${pid} still alive (reparented)` : "gone" },
        // M13: no auto-resume; the task fails once, says the runner restarted, and its agent ran once.
        { invariant: "a task interrupted by a restart fails once, says why, and never runs twice", holds: after.startsWith("failed") && /restarted/.test(after) && reran === 1, detail: `${after} (agent starts: ${reran})` }
      ]
    };
  },

  /** Protocol skew both ways: the Worker ahead of the runner, then a runner ahead of the Worker. */
  async skew() {
    const proxy = await startProxy(url);
    cleanup.push(() => proxy.close());
    proxy.speak(PROTOCOL + 1);
    const launchedAt = Date.now();
    const { runner } = await paired("bench-skew-worker", proxy);
    await until("the runner to exit", () => runner.exitCode() !== null, 30_000);
    const exitMs = Date.now() - launchedAt;
    await sleep(500);
    const workerAheadRow = machineRow("bench-skew-worker");

    // Runner ahead: a socket that says hello with a newer protocol, straight to the stack.
    const ahead = machine("bench-skew-runner", out);
    const pairedAhead = await ahead.pair(url, await pairingCode(url));

    if (pairedAhead.code !== 0) throw new Error(`did not pair: ${pairedAhead.output}`);
    const token = readFileSync(ahead.tokenFile, "utf8").trim();
    const socket = new Socket(`${url.replace(/^http/, "ws")}${RUNNER_PATH}bench-skew-runner`, { headers: { Authorization: `Bearer ${token}` } });
    let closedBy: number | undefined;
    let goodbye = "";
    let sawOnline = false;
    const openedAt = Date.now();
    const watch = setInterval(() => (sawOnline ||= online("bench-skew-runner")), 10);
    socket.on("message", (data) => {
      const frame = decodeObjectFrame(String(data));

      if (frame?.type === "goodbye") goodbye = frame.reason;
    });
    socket.on("close", (code) => (closedBy = code));
    socket.on("open", () => setTimeout(() => socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL + 1, active: [] })), 300));
    await until("the socket to close", () => closedBy !== undefined, 15_000);
    clearInterval(watch);
    const goodbyeMs = Date.now() - openedAt;
    await sleep(500);
    const runnerAheadRow = machineRow("bench-skew-runner");
    const reasonShown = (row: Record<string, unknown> | undefined) => row !== undefined && Object.keys(row).some((key) => /reason|why|error/i.test(key));

    return {
      probe: "skew",
      timings: {
        "worker ahead: launch→runner exit ms": exitMs,
        "worker ahead: runner exit code": runner.exitCode() ?? "running",
        "worker ahead: UI says": workerAheadRow?.online ? "online" : "offline",
        "runner ahead: open→close ms": goodbyeMs,
        "runner ahead: close code": closedBy ?? "none",
        "runner ahead: goodbye": goodbye
      },
      verdicts: [
        { invariant: "worker ahead: the user sees the machine is outdated, not just offline", holds: reasonShown(workerAheadRow), detail: `machine row keys: ${Object.keys(workerAheadRow ?? {}).join(",")}` },
        { invariant: "runner ahead: refused with OUTDATED and a reason", holds: closedBy === OUTDATED && goodbye.length > 0, detail: `${closedBy} ${goodbye}` },
        { invariant: "runner ahead: never listed online before its hello is accepted", holds: !sawOnline, detail: sawOnline ? "listed online between connect and goodbye" : "never listed online" },
        { invariant: "runner ahead: the user sees why", holds: reasonShown(runnerAheadRow), detail: `machine row keys: ${Object.keys(runnerAheadRow ?? {}).join(",")}` }
      ]
    };
  },

  /** An agent that hangs at start: does anyone notice? */
  async hang() {
    const watchMs = option("--hang-watch", 45_000);
    const { mac } = await fresh("bench-hang", { KY_CLAUDE: hangingClaude() });
    const { id, rowAt } = await startTask("bench-hang", "this will hang");
    const spawnAt = await when("the agent to spawn", () => mac.claude().some((event) => event.event === "start" && event.task === id), 15_000);
    await sleep(watchMs);
    const shown = status(id);
    const statusFile = JSON.parse(readFileSync(path.join(mac.dir, "state", "runner-status.json"), "utf8"));
    const stopAt = Date.now();
    main.send({ type: "submit", input: `tool machine ${JSON.stringify({ action: "stop", task: id })}` });
    const stoppedAt = await when("the task to stop", () => status(id) === "stopped" || status(id) === "failed", 30_000);
    const pid = mac.claude().find((event) => event.event === "start" && event.task === id)?.pid;
    const lingering = pid !== undefined && alive(pid);

    if (lingering) process.kill(pid!, "SIGKILL");

    return {
      probe: "hang",
      timings: {
        "row→spawn ms": spawnAt ? spawnAt - rowAt : "never",
        [`status after ${watchMs / 1000}s of silence`]: shown ?? "none",
        "ky runner status says": statusFile.state,
        "stop→stopped ms": stoppedAt ? stoppedAt - stopAt : "never",
        "final": main.history(id).at(-1) ?? ""
      },
      verdicts: [
        { invariant: "a spawned agent shows as started, not queued", holds: shown !== "queued", detail: `status ${shown}` },
        { invariant: `a silent agent fails loudly within ${watchMs / 1000}s`, holds: shown === "failed", detail: `status ${shown}` },
        { invariant: "a stop ends a hung agent", holds: stoppedAt !== undefined && !lingering, detail: lingering ? `pid ${pid} still alive` : "killed" }
      ]
    };
  },

  /** The Mac goes offline (socket cut, retries refused), a task is sent meanwhile, then it comes back. */
  async offline() {
    const outageMs = option("--outage", 5_000);
    const { proxy } = await fresh("bench-offline");
    const cutAt = Date.now();
    proxy.cut("refuse");
    const shownOfflineAt = await when("offline in the UI", () => !online("bench-offline"), 15_000);
    const { id, rowAt } = await startTask("bench-offline", "[delay=200] sent while offline");
    const whileOffline = status(id);
    await sleep(Math.max(0, outageMs - (Date.now() - cutAt)));
    const openAt = Date.now();
    proxy.open();
    const backAt = await when("online again", () => online("bench-offline"), 90_000);
    const doneAt = await when("done", () => status(id) === "done", 90_000);

    return {
      probe: "offline",
      timings: {
        "cut→UI offline ms": shownOfflineAt ? shownOfflineAt - cutAt : "never",
        "status while offline": whileOffline ?? "none",
        "outage ms": openAt - cutAt,
        "network back→online ms": backAt ? backAt - openAt : "never",
        "network back→queued task done ms": doneAt ? doneAt - openAt : "never",
        "row→done ms": doneAt ? doneAt - rowAt : "never"
      },
      verdicts: [
        { invariant: "offline shows within 2s of a clean cut", holds: shownOfflineAt !== undefined && shownOfflineAt - cutAt < 2000, detail: `${shownOfflineAt ? shownOfflineAt - cutAt : "never"} ms` },
        { invariant: "back online within 5s of the network returning", holds: backAt !== undefined && backAt - openAt < 5000, detail: `${backAt ? backAt - openAt : "never"} ms` },
        { invariant: "a task sent while offline runs once it is back", holds: doneAt !== undefined, detail: main.history(id).join(" → ") }
      ]
    };
  },

  /** A half-open socket: the runner's frames stop arriving (sleep, a dead NAT), the socket never closes. */
  async halfopen() {
    const silenceMs = option("--silence", 70_000);
    const { proxy } = await fresh("bench-halfopen");
    proxy.hold();
    const heldAt = Date.now();
    const offlineAt = await when("offline in the UI", () => !online("bench-halfopen"), silenceMs);
    proxy.release();

    return {
      probe: "halfopen",
      timings: { "silence ms": Date.now() - heldAt, "silence→UI offline ms": offlineAt ? offlineAt - heldAt : `still online after ${silenceMs / 1000}s` },
      verdicts: [
        { invariant: "a runner silent for 2 keepalives (60s) is shown offline", holds: offlineAt !== undefined, detail: offlineAt ? `${offlineAt - heldAt} ms` : "still online" }
      ]
    };
  },

  /** The cloud machine waking for a task, on the local fake container host (not Cloudflare's). */
  async cloud() {
    const logs = machine("cloud", out);
    const proxy = await startProxy(url);
    const git = await serveGit("github_pat_harness");
    const host = await serveContainer({
      ky: KY_COMMAND,
      kyUrl: proxy.url,
      github: `${url}/github.internal/api/git/`,
      env: { KY_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: path.join(logs.dir, "claude.jsonl"), FAKE_CLAUDE_SESSIONS: "1", KY_CODEX: FAKE_CODEX, FAKE_CODEX_LOG: path.join(logs.dir, "codex.jsonl") },
      logs: logs.dir
    });
    const route = async (to: string) => {
      const response = await fetch(`${url}${to}`, { method: "POST", headers: await signedIn() });

      if (response.status !== 204) throw new Error(`${to} answered ${response.status}`);
    };
    cleanup.push(() => proxy.close(), () => git.close(), () => host.close(), () => route("/test/cloud-reset"));
    await route(`/test/cloud-host?${new URLSearchParams({ url: host.url, github: git.url })}`);
    await main.command({ type: "set-github", token: "github_pat_harness", repos: ["me/app"] });
    const asleep = machineRow("cloud")?.cloud;
    const { id, rowAt } = await startTask("cloud", "[delay=200] wake up");
    const wakingAt = await when("waking", () => machineRow("cloud")?.cloud === "waking", 15_000);
    const onlineAt = await when("online", () => online("cloud"), 120_000);
    const doneAt = await when("done", () => status(id) === "done", 120_000);

    return {
      probe: "cloud",
      timings: {
        "before": String(asleep),
        "row→waking shown ms": wakingAt ? wakingAt - rowAt : "never",
        "row→runner online ms": onlineAt ? onlineAt - rowAt : "never",
        "row→done ms": doneAt ? doneAt - rowAt : "never",
        "container starts": host.starts()
      },
      verdicts: [{ invariant: "a task wakes the cloud machine and runs (local fake host)", holds: doneAt !== undefined, detail: main.history(id).join(" → ") }]
    };
  }
};

mkdirSync(out, { recursive: true });
const results: Result[] = [];

for (const probe of chosen) {
  const started = Date.now();
  let result: Result;

  try {
    result = await PROBE_FNS[probe]();
  } catch (error) {
    result = { probe, timings: {}, verdicts: [], error: error instanceof Error ? error.message : String(error) };
  }

  results.push(result);
  console.log(`\n== ${probe} (${((Date.now() - started) / 1000).toFixed(1)}s)${result.error ? `  ERROR ${result.error}` : ""}`);

  for (const [name, value] of Object.entries(result.timings)) console.log(`   ${name.padEnd(44)} ${value}`);

  for (const verdict of result.verdicts) console.log(`   ${verdict.holds ? "HOLDS" : "GAP  "} ${verdict.invariant}  (${verdict.detail})`);
}

for (const runner of runners) await runner.stop().catch(() => {});

for (const clean of cleanup.reverse()) await Promise.resolve(clean()).catch(() => {});
main.close();
await stack.stop();
writeFileSync(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nresults: ${path.relative(REPO, path.join(out, "results.json"))}`);
process.exit(results.some((result) => result.error) ? 1 : 0);
