#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The cloud machine's lifecycle on a real deploy:
 *
 *   KY_URL=https://ky-trial.<you>.workers.dev KY_CLOUD_IDLE_MINUTES=1 pnpm live:cloud
 *
 * Opt-in, never part of `pnpm gate`: it needs a deploy with the cloud machine (Workers Paid and a
 * release with an image) and ky's Claude subscription connected in Settings, and it runs one real
 * Claude Code task with two turns on the cloud machine. KY_CLOUD_IDLE_MINUTES must be what the
 * deploy's overlay sets in its vars (src/cloud.ts; 10 when unset): run it against a deploy whose
 * overlay says "1", or it takes over half an hour. It signs in as the owner like `pnpm gate:live`:
 * run `cloudflared access login <KY_URL>` once first.
 *
 * In order, each step needing the one before; one line per step, PASS or FAIL, then the cloud
 * machine's states as the task list showed them. Exit 1 on a FAIL.
 *
 *   asleep   the cloud machine is listed, and asleep (a running one is waited on to sleep first)
 *   wake     a task on it, which the main model starts in a side chat, wakes it within 5 minutes
 *   open     it stays running while the task is open, longer than the idle timeout: the task
 *            runs `sleep` for the idle timeout plus 90 seconds, in short foreground steps (Claude
 *            Code moves a command past its two-minute timeout to the background, and its turn
 *            ends at once); a turn shorter than that fails, with the steps Claude took
 *   sleep    once the task ends, it sleeps after the idle timeout, not before, and within two
 *            ticks and a save after it
 *   resume   a follow-up to the task wakes it again, and the task answers from its first turn:
 *            the new container restored the Claude session that the sleep saved to R2 (a sleep
 *            whose save failed starts the next container empty, and the follow-up can't answer)
 */
import type { CloudState, MachineInfo } from "../src/protocol.ts";
import { decodeNewChat } from "../src/tests/frames.ts";
import { type Client, connect } from "./harness/client.ts";
import { liveTarget } from "./live-access.ts";

const { url, signedIn } = liveTarget("KY_URL=https://ky-trial.<you>.workers.dev KY_CLOUD_IDLE_MINUTES=1 pnpm live:cloud");

const idleMinutes = Number(process.env.KY_CLOUD_IDLE_MINUTES ?? "10");

if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
  console.error("KY_CLOUD_IDLE_MINUTES must be a positive number of minutes, the deploy's own");
  process.exit(2);
}

const MINUTE = 60_000;

const IDLE_MS = idleMinutes * MINUTE;

/** src/cloud.ts's TICK_MS: the alarm checks the idle time once a minute. */
const TICK_MS = MINUTE;

/** How long a save to R2 and the container's stop may take. */
const SAVE_MS = 2 * MINUTE;

/** How long a wake may take: the container's start and pull, and the runner's dial. */
const WAKE_MS = 5 * MINUTE;

/** How long the task holds the machine busy: past the idle timeout and a tick. */
const HOLD_S = Math.ceil(IDLE_MS / 1000) + 90;

/**
 * The hold's `sleep`s, each well under Claude Code's two-minute command timeout, even two run
 * together: a longer one it moves to the background, and the turn ends while it sleeps.
 */
const SLEEPS = Array.from({ length: Math.ceil(HOLD_S / 45) }, (_, at) => Math.min(45, HOLD_S - at * 45));

const CLOUD = "cloud";

const word = `ky-${crypto.randomUUID().slice(0, 8)}`;

const main = await connect(url, "", signedIn);

/** The cloud machine as the newest task list shows it. */
function machine(): MachineInfo | undefined {
  const latest = main.frames.findLast((frame) => frame.type === "tasks");

  return latest?.type === "tasks" ? latest.machines.find((each) => each.name === CLOUD) : undefined;
}

const state = (): CloudState | undefined => machine()?.cloud ?? undefined;

const started = Date.now();

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/** Each state the cloud machine showed, and when, from the start of the run. */
const timeline: string[] = [];

let last: CloudState | undefined;

const watcher = setInterval(() => {
  const now = state();

  if (now !== last) timeline.push(`${seconds(Date.now() - started).padStart(6)}  ${now ?? "unlisted"}`);
  last = now;
}, 250);

/** Resolves with when `check` first held, or throws after `timeoutMs`. */
async function when(what: string, check: () => boolean, timeoutMs: number): Promise<number> {
  await main.until(what, check, timeoutMs);

  return Date.now();
}

function pass(name: string, detail: string): void {
  console.log(`PASS  ${name.padEnd(7)} ${detail}`);
}

function fail(detail: string): never {
  throw new Error(detail);
}

/** The task as the task list shows it, failing when it isn't there. */
function row(task: string) {
  return main.task(task) ?? fail(`the task list lost ${task}`);
}

/** How many of the task's turns have ended done. */
const doneTurns = (task: string) => main.history(task).filter((entry) => entry.startsWith("done:")).length;

/** The task id a side chat's submit starts on the cloud machine. */
async function startTask(side: Client): Promise<string> {
  const known = new Set(main.frames.flatMap((frame) => (frame.type === "tasks" ? frame.tasks.map((each) => each.id) : [])));
  const commands = SLEEPS.map((seconds) => `\`sleep ${seconds}\``).join(", then ");
  const prompt = `This is ky's live cloud test. Remember the code word ${word}. Run ${commands} in the shell: one command per tool call, each in the foreground and never in the background, waiting for each to finish before the next. Then reply with exactly: slept`;

  await side.command({
    type: "submit",
    input: `Use the machine tool once, right now, with action "run", machine "cloud", agent "claude" and this prompt, word for word:\n\n${prompt}\n\nDo nothing else, then reply "started".`
  });
  let id: string | undefined;

  await main.until(
    "a task on the cloud machine",
    () => {
      const latest = main.frames.findLast((frame) => frame.type === "tasks");

      id = latest?.type === "tasks" ? latest.tasks.find((each) => each.worker === CLOUD && !known.has(each.id))?.id : undefined;

      return id !== undefined;
    },
    2 * MINUTE
  );

  return id ?? fail("no task started");
}

async function asleep(): Promise<void> {
  await main.until("the task list", () => main.frames.some((frame) => frame.type === "tasks"), 30_000);

  if (!machine()) fail("no cloud machine listed: deploy with an image, on Workers Paid (`ky doctor` says which is missing)");

  if (state() !== "asleep") await when("the cloud machine to sleep first", () => state() === "asleep", IDLE_MS + TICK_MS + SAVE_MS + MINUTE);
  pass("asleep", "listed, and asleep");
}

async function wake(task: string, since: number, name: string): Promise<number> {
  const running = await when("the cloud machine to wake", () => state() === "running", WAKE_MS).catch(() =>
    fail(`still ${state()} ${seconds(WAKE_MS)} after the task (${row(task).status})`)
  );

  pass(name, `running ${seconds(running - since)} after the task was started`);

  return running;
}

async function open(task: string, running: number): Promise<number> {
  let dropped: CloudState | undefined;

  const ended = await when(
    "the task to end",
    () => {
      const now = state();

      if (now !== "running") dropped ??= now;

      return !["queued", "working"].includes(row(task).status);
    },
    HOLD_S * 1000 + 10 * MINUTE
  );

  if (dropped) fail(`went ${dropped} while the task was open`);

  const { status, summary, started_at, finished_at, steps } = row(task);

  if (status !== "done") fail(`the task ended ${status}: ${summary}`);
  const held = (finished_at ?? ended) - (started_at ?? running);

  // A turn shorter than its sleeps didn't wait for them: the machine wasn't held, whatever it showed.
  if (held < HOLD_S * 1000 - 5_000) fail(`the task's turn lasted ${seconds(held)}, not the ${HOLD_S}s its sleeps take; Claude's steps: ${steps.map((step) => step.text).join(" / ")}`);
  const up = ended - running;

  if (up < IDLE_MS) fail(`the task ended ${seconds(up)} after the wake, before the idle timeout (${seconds(IDLE_MS)}), so this proves nothing`);
  pass("open", `running for ${seconds(up)} with the task open (its turn ${seconds(held)}), past the ${seconds(IDLE_MS)} idle timeout`);

  return ended;
}

async function sleep(ended: number): Promise<void> {
  const latest = IDLE_MS + 2 * TICK_MS + SAVE_MS;

  const slept = await when("the cloud machine to sleep", () => state() === "asleep", latest).catch(() =>
    fail(`still ${state()} ${seconds(latest)} after the task ended`)
  );

  const after = slept - ended;

  // The alarm counts idle from its first tick with no task open, up to a tick after the task ends.
  if (after < IDLE_MS - 5_000) fail(`asleep ${seconds(after)} after the task ended, before the ${seconds(IDLE_MS)} idle timeout`);
  pass("sleep", `asleep ${seconds(after)} after the task ended (idle timeout ${seconds(IDLE_MS)}), its files saved to R2`);
}

async function resume(task: string): Promise<void> {
  const sent = Date.now();

  await main.command({ type: "send-task", task, message: "What was the code word I gave you? Reply with only the code word." });
  await wake(task, sent, "resume");
  await when("the follow-up to finish", () => doneTurns(task) >= 2 || ["failed", "stopped"].includes(row(task).status), 10 * MINUTE);
  const { status, summary } = row(task);

  if (status !== "done") fail(`the follow-up ended ${status}: ${summary}`);

  if (!summary.includes(word)) fail(`the follow-up answered "${summary}", not ${word}: the new container didn't resume the session`);
  pass("resume", `the follow-up answered ${word} from the first turn's session, restored from R2`);
}

let code = 0;

let session: string | undefined;

try {
  await asleep();
  session = decodeNewChat((await main.command({ type: "new-chat" })).result) ?? fail("new-chat gave no session");
  const side = await connect(url, `?session=${session}`, signedIn);

  try {
    const asked = Date.now();
    const task = await startTask(side);
    const running = await wake(task, asked, "wake");
    const ended = await open(task, running);

    await sleep(ended);
    await resume(task);
  } finally {
    side.close();
  }
} catch (error) {
  code = 1;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  clearInterval(watcher);

  if (session) await main.command({ type: "archive-chat", session, archived: true }).catch(() => undefined);
  console.log(`\nThe cloud machine (idle timeout ${idleMinutes} min, code word ${word}):\n${timeline.join("\n")}`);
  main.close();
}

process.exit(code);
