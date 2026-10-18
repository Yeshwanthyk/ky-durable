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
 *            waits for the idle timeout plus 90 seconds, in short foreground steps (Claude Code
 *            refuses a bare `sleep`, and moves a command past its two-minute timeout to the
 *            background, and either ends its turn at once); a turn shorter than that fails, with
 *            the steps Claude took
 *   sleep    once the task ends, it sleeps after the idle timeout, not before, and within two
 *            ticks and a save after it
 *   resume   a follow-up to the task wakes it again, and the task answers from its first turn:
 *            the new container restored the Claude session that the sleep saved to R2 (a sleep
 *            whose save failed starts the next container empty, and the follow-up can't answer)
 *   crash    a turn writes a note to ~/ky-work, the working folder a save keeps, and ends; the next turn waits past two ticks and a
 *            save, which the alarm's snapshot after a turn takes while it waits, then stops the
 *            container as the platform does (SIGTERM to the runner, PID 1). That turn ends with the
 *            stop's text, not as a restart; a third turn wakes a new container and reads the note,
 *            which only the snapshot had: no sleep saved the folder after the note was written
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
 * The hold's waits, in seconds, each well under Claude Code's two-minute command timeout, even two
 * run together: a longer one it moves to the background, and the turn ends while it waits.
 */
const WAITS = waits(HOLD_S);

/** How long the crash's turn waits before it stops the container: the snapshot's tick, a tick of slack, and its save. */
const SNAPSHOT_S = Math.ceil((2 * TICK_MS + SAVE_MS) / 1000);

/** `total` seconds of waits, each at most 45. */
function waits(total: number): number[] {
  return Array.from({ length: Math.ceil(total / 45) }, (_, at) => Math.min(45, total - at * 45));
}

/** The shell commands that wait `each` seconds in turn. Node, not `sleep`: Claude Code refuses a bare sleep in the shell. */
function waitCommands(each: readonly number[]): string {
  return each.map((seconds) => `\`node -e "setTimeout(() => console.log('waited ${seconds}s'), ${seconds * 1000})"\``).join(", then ");
}

const CLOUD = "cloud";

const word = `ky-${crypto.randomUUID().slice(0, 8)}`;

const note = `ky-${crypto.randomUUID().slice(0, 8)}`;

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

/** Whether the task is still queued or working. */
const live = (task: string) => ["queued", "working"].includes(row(task).status);

/** The task id a side chat's submit starts on the cloud machine. */
async function startTask(side: Client): Promise<string> {
  const known = new Set(main.frames.flatMap((frame) => (frame.type === "tasks" ? frame.tasks.map((each) => each.id) : [])));
  const commands = waitCommands(WAITS);
  const prompt = `This is ky's live cloud test. Remember the code word ${word}. Run these ${WAITS.length} commands in the shell, one per tool call, each in the foreground and never in the background, waiting for each to finish before the next: ${commands}. Then reply with exactly: waited`;

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

/** When `task` ended, failing if the machine left running before it did. */
async function heldUntilEnd(task: string): Promise<number> {
  let dropped: CloudState | undefined;

  const ended = await when(
    "the task to end",
    () => {
      const now = state();

      if (now !== "running") dropped ??= now;

      return !live(task);
    },
    HOLD_S * 1000 + 10 * MINUTE
  );

  if (dropped) fail(`went ${dropped} while the task was open`);

  return ended;
}

/** How long `task`'s turn lasted, failing unless it ended done. */
function turnOf(task: string, ended: number, running: number) {
  const { status, summary, started_at, finished_at, steps } = row(task);

  if (status !== "done") fail(`the task ended ${status}: ${summary}`);

  return { held: (finished_at ?? ended) - (started_at ?? running), steps: steps.map((step) => step.text).join(" / ") };
}

async function open(task: string, running: number): Promise<number> {
  const ended = await heldUntilEnd(task);
  const { held, steps } = turnOf(task, ended, running);

  // A turn shorter than its waits didn't wait for them: the machine wasn't held, whatever it showed.
  if (held < HOLD_S * 1000 - 5_000) fail(`the task's turn lasted ${seconds(held)}, not the ${HOLD_S}s its waits take; Claude's steps: ${steps}`);
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

/** Send `message` to `task`, and its new turn's row and replies once that turn ends; `name` is the step that wakes the machine, if it sleeps. */
async function followUp(task: string, message: string, name?: string) {
  const sent = Date.now();
  // A turn's start, by ky's clock: the follow-up's is a new one. Not a count of "done" rows, which a
  // first turn has two of once its summary is rewritten.
  const first = row(task).started_at;

  await main.command({ type: "send-task", task, message });

  if (name) await wake(task, sent, name);
  await when("the follow-up to finish", () => row(task).started_at !== first && !live(task), 15 * MINUTE);
  const ended = row(task);

  // Its reply as Claude wrote it: the summary may be rewritten in other words.
  return { ...ended, answered: ended.steps.filter((step) => step.at >= (ended.started_at ?? 0)).map((step) => step.text) };
}

async function resume(task: string): Promise<void> {
  const { status, summary, answered } = await followUp(task, "What was the code word I gave you? Reply with only the code word.", "resume");

  if (status !== "done") fail(`the follow-up ended ${status}: ${summary}`);

  if (!answered.some((text) => text.includes(word))) fail(`the follow-up answered "${answered.join(" / ")}", not ${word}: the new container didn't resume the session`);
  pass("resume", `the follow-up answered ${word} from the first turn's session, restored from R2`);
}

async function crash(task: string): Promise<void> {
  const wrote = await followUp(task, `Run \`echo ${note} > ~/ky-work/ky-live-note\` in the shell, then reply with exactly: written`);

  if (wrote.status !== "done") fail(`the note's turn ended ${wrote.status}: ${wrote.summary}`);

  // Sent at once, so the machine stays busy and no sleep saves the folder: only the snapshot after the note's turn has it.
  const stopped = await followUp(
    task,
    `Run these commands in the shell, one per tool call, each in the foreground and never in the background, waiting for each to finish before the next: ${waitCommands(waits(SNAPSHOT_S))}, then \`kill -TERM 1\`. Then reply with exactly: stopped`
  );

  if (stopped.status === "done" || ![stopped.summary, ...stopped.answered].some((text) => text.includes("the container was stopped")))
    fail(`the stopped turn ended ${stopped.status}: "${stopped.summary}", not with the stop's text`);
  // The read goes to a new container, not one ky still thinks runs.
  await when("the stopped container to leave running", () => state() !== "running", 2 * TICK_MS + SAVE_MS).catch(() =>
    fail(`still running ${seconds(2 * TICK_MS + SAVE_MS)} after the runner was stopped`)
  );
  const read = await followUp(task, "Run `cat ~/ky-work/ky-live-note` in the shell and reply with only what it printed.", "crash");

  if (read.status !== "done") fail(`the read's turn ended ${read.status}: ${read.summary}`);

  if (!read.answered.some((text) => text.includes(note)))
    fail(`the new container read "${read.answered.join(" / ")}", not ${note}: the snapshot after the note's turn didn't reach R2`);
  pass("crash", `a stopped turn said so, and the new container read ${note} from the snapshot after a turn`);
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
    await crash(task);
  } finally {
    side.close();
  }
} catch (error) {
  code = 1;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  clearInterval(watcher);

  if (session) await main.command({ type: "archive-chat", session, archived: true }).catch(() => undefined);
  console.log(`\nThe cloud machine (idle timeout ${idleMinutes} min, code word ${word}, note ${note}):\n${timeline.join("\n")}`);
  main.close();
}

process.exit(code);
