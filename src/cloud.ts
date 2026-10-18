import { DurableObject } from "cloudflare:workers";
import { CLOUD, CLOUD_FACTS } from "./cloud-facts";
import { pairAs } from "./runners";
import { saveKey } from "./sandboxes";
import { putInParts } from "./uploads";

/**
 * A sandbox: a container that runs `ky runner cloud`, so tasks run with every personal computer
 * off. One per sandbox (src/sandboxes.ts), `env.CloudMachine.getByName(<its id>)`, on a deploy with
 * Workers Paid (`ky deploy` attaches the container app; without one, `box()` is undefined and
 * nothing runs). Today's cloud machine is the sandbox `cloud`.
 *
 * - It learns its id from the first wake, and asks the agent for the rest at each start and alarm:
 *   the name it pairs as, its idle minutes, whether it has work. A deleted sandbox doesn't start,
 *   and one still running saves its disk and stops.
 * - It pairs itself: each start mints a new machine token from the Vault, as the pair route does,
 *   and hands it to the container; the runner says it is `kind: "cloud"`.
 * - MachineHub wakes it when a command waits for it offline. An alarm keeps it awake: while any
 *   task is open it pings the container every TICK_MS, since the runner's own outbound socket
 *   doesn't count as activity; idle for KY_CLOUD_IDLE_MINUTES (10 unless the overlay's vars say),
 *   it sleeps.
 * - Sleeping saves what must outlive the container to R2 (Claude Code's sessions, each Codex task's
 *   home, the runner's handled seqs, the work trees); the next start restores it before the runner
 *   dials ky, so a follow-up resumes its session. The alarm also snapshots the running container to
 *   R2 once a turn has ended since the last save, so a crash, eviction or rollout loses at most the
 *   open turn.
 * - git reaches github.com only through github.internal, which this routes to the Worker's
 *   GithubProxy (src/github.ts) with `{ machine: <its id> }` in its props: it holds the token, lets
 *   the sandbox reach only its repos (the agent's `reposFor`), and lets pushes reach `ky/*` only. `ky github` reaches the PR and deploy tools there too
 *   (src/github-tools.ts). Nothing in the container holds a GitHub token.
 */

/** The container's runner, as the CloudMachine drives it; the stack replaces it with a fake host. */
export type CloudBox = {
  running(): Promise<boolean>;
  /**
   * Start the container with `env` for the sandbox `id`; it then answers on its port once `ky runner
   * cloud` listens. Its github.internal reaches only what `id` may.
   */
  start(env: Record<string, string>, id: string): Promise<void>;
  /** A request to `ky runner cloud`'s port. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  destroy(): Promise<void>;
};

/** Where `ky runner cloud` listens in the container (cli/runner/cloud.ts's CLOUD_PORT). */
const PORT = 8080;

/** How often the alarm pings the container while it runs. */
const TICK_MS = 60_000;

/**
 * How soon the alarm tries again when a start failed while work waits, as when Cloudflare had no
 * instance to give yet: a whole tick would be a minute nobody's task runs.
 */
const RETRY_MS = 5_000;

/**
 * How long starts may keep failing while work waits before its tasks fail, saying why, and the
 * sandbox stops starting until new work comes. Each retry waits twice the last, from RETRY_MS to
 * the tick.
 */
const START_DEADLINE_MS = 10 * 60_000;

/** How many saves or snapshots in a row may fail before the machine says its files aren't saving. */
const SAVE_FAILURES_BEFORE_REASON = 5;

/** How long the container runs with no task open before it sleeps, unless KY_CLOUD_IDLE_MINUTES says. */
const IDLE_MINUTES = 10;

/** How long a container has to start listening. */
const START_WITHIN_MS = 3 * 60_000;

/**
 * Cloudflare's error for a start it refused, as when the last container, just put to sleep, still
 * holds the deploy's one instance: nothing starts, however long the pings wait for it.
 */
const NO_INSTANCE = "There is no container instance that can be provided";

/** How long the platform keeps a container whose port nothing asked: past a few missed ticks. */
const INACTIVITY_MS = 15 * 60_000;

const ORIGIN_KEY = "origin";

/** Its sandbox's id; none for the cloud machine from before there were others, which is `cloud`. */
const ID_KEY = "id";

const IDLE_KEY = "idleSince";

/** How many of the sandbox's turns had ended when R2 last took its disk: a snapshot's, a sleep's or a retire's. */
const SNAPSHOT_KEY = "snapshot";

/** How many saves and snapshots in a row have failed; gone after one that worked. */
const SAVE_FAILURES_KEY = "saveFailures";

/** Failed starts while work waits, since the last good one or wake: the first's time, how many, and the last error. */
const START_FAILURES_KEY = "startFailures";

type StartFailures = { readonly since: number; readonly attempts: number; readonly error: string };

/** Set while its deleted sandbox saves its disk and stops; a kept disk isn't started from meanwhile. */
const RETIRING_KEY = "retiring";

/** The real container, through the Durable Object's own `ctx.container`. */
function containerBox(ctx: DurableObjectState): CloudBox | undefined {
  const container = ctx.container;

  if (!container) return undefined;

  return {
    running: async () => container.running,
    start: async (env, id) => {
      // Before every start: a new container has no interceptor. The props say which sandbox calls, by its id, where
      // the container can't reach: GithubProxy trusts nothing the container sends.
      await container.interceptOutboundHttp("github.internal", ctx.exports.GithubProxy({ props: { machine: id } }));
      container.start({ enableInternet: true, env });
    },
    fetch: async (path, init) => {
      const answer = await container.getTcpPort(PORT).fetch(`http://container${path}`, init);

      // The container answers, so it surely exists now: from here, it outlives the object's evictions.
      await container.setInactivityTimeout(INACTIVITY_MS);

      return answer;
    },
    destroy: () => container.destroy()
  };
}

/** What the agent says of a sandbox at each alarm; null once it is deleted. */
export type SandboxNow = { readonly name: string; readonly idleMinutes: number | null; readonly busy: boolean; readonly turnsEnded: number } | null;

/** KY_CLOUD_IDLE_MINUTES as milliseconds: a positive number of minutes, such as 1 for a live test; else IDLE_MINUTES. */
export function idleTimeout(minutes: string | undefined): number {
  const parsed = Number(minutes);

  return (minutes?.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : IDLE_MINUTES) * 60_000;
}

/** An error as the machine's reason shows it: its message, on one line. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a start or a save threw.
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").trim().slice(0, 300);
}

export class CloudMachine extends DurableObject<Env> {
  /** The container, or undefined on a deploy without one. */
  box(): CloudBox | undefined {
    return containerBox(this.ctx);
  }

  /**
   * How often the alarm comes while the container runs, how long it stays up idle (the sandbox's
   * `idleMinutes`, else the deploy's), and how long starts may fail while work waits. Tests shorten them.
   */
  async timing(idleMinutes: number | null): Promise<{ tickMs: number; idleMs: number; startDeadlineMs: number }> {
    return { tickMs: TICK_MS, idleMs: idleMinutes ? idleMinutes * 60_000 : idleTimeout(this.env.KY_CLOUD_IDLE_MINUTES), startDeadlineMs: START_DEADLINE_MS };
  }

  /** Now, in epoch ms, as the alarm and the wakes book by it; tests move it ahead. */
  clock(): number {
    return Date.now();
  }

  #agent() {
    return this.env.PiAgent.getByName("me");
  }

  async #id(): Promise<string> {
    return (await this.ctx.storage.get<string>(ID_KEY)) ?? CLOUD;
  }

  /**
   * A command waits for the sandbox `id`, this one: start it, if it isn't running, at the next alarm,
   * now. `origin` is ky's address, which the runner dials; the last one given is kept. New work
   * starts the count of failed starts afresh, so it gets its own deadline.
   */
  async wake(id: string, origin?: string): Promise<void> {
    await this.ctx.storage.put(ID_KEY, id);
    await this.ctx.storage.delete(START_FAILURES_KEY);

    if (origin) await this.ctx.storage.put(ORIGIN_KEY, origin);
    const at = await this.ctx.storage.getAlarm();

    if (at === null || at > this.clock()) await this.ctx.storage.setAlarm(this.clock());
  }

  /** Keep the container up while a task is open, and put it to sleep once none has been for its idle timeout. */
  override async alarm(): Promise<void> {
    const box = this.box();

    if (!box) return;
    const id = await this.#id();
    let { tickMs, startDeadlineMs } = await this.timing(null);
    let busy = false;

    try {
      const sandbox = await this.#agent().sandboxNow(id);

      // Deleted, or a delete's save failed: save its disk if it runs, which the kept disk holds, and stop.
      if (!sandbox) return await this.retire();
      const timing = await this.timing(sandbox?.idleMinutes ?? null);

      ({ tickMs, startDeadlineMs } = timing);
      busy = sandbox.busy;
      // Busy or idle: the turn that just ended closed its task, so an idle sandbox may have the newest work.
      await this.#snapshot(box, id, sandbox.turnsEnded);

      if (sandbox.busy) {
        await this.ctx.storage.delete(IDLE_KEY);
        await this.#up(box, id, sandbox.name);
        await this.ctx.storage.delete(START_FAILURES_KEY);
        await this.ctx.storage.setAlarm(this.clock() + tickMs);

        return;
      }

      if (!(await box.running())) return;
      const { idleMs } = timing;
      const idleSince = (await this.ctx.storage.get<number>(IDLE_KEY)) ?? this.clock();

      await this.ctx.storage.put(IDLE_KEY, idleSince);

      if (this.clock() - idleSince >= idleMs && (await this.sleep())) return;
      await box.fetch("/ping");
      await this.ctx.storage.setAlarm(this.clock() + tickMs);
    } catch (error) {
      console.warn(`the sandbox ${id}'s alarm failed; trying again`, error);

      // Idle, the container runs on, and the next tick tries its save again.
      if (!busy) return await this.ctx.storage.setAlarm(this.clock() + tickMs);
      await this.#startFailed(id, errorText(error), tickMs, startDeadlineMs);
    }
  }

  /**
   * A start failed while work waits: try again after twice the last wait, from RETRY_MS up to the
   * tick, each start minting a token. Past the deadline the waiting tasks fail once with the last
   * error, which the machine shows, and no start comes until a wake brings new work; the tick goes
   * on, so a container that still runs keeps trying to save its disk, and sleeps once it has.
   */
  async #startFailed(id: string, error: string, tickMs: number, startDeadlineMs: number): Promise<void> {
    const now = this.clock();
    const last = await this.ctx.storage.get<StartFailures>(START_FAILURES_KEY);
    const failures: StartFailures = { since: last?.since ?? now, attempts: (last?.attempts ?? 0) + 1, error };

    if (now - failures.since < startDeadlineMs) {
      await this.ctx.storage.put(START_FAILURES_KEY, failures);
      await this.ctx.storage.setAlarm(now + Math.min(RETRY_MS * 2 ** (failures.attempts - 1), tickMs));

      return;
    }

    console.warn(`the sandbox ${id} didn't start in ${failures.attempts} tries over ${Math.round((now - failures.since) / 1000)}s; failing its waiting tasks`);
    await this.#agent().sandboxStartFailed(id, `The sandbox didn't start: ${failures.error}`);
    await this.ctx.storage.delete(START_FAILURES_KEY);
    await this.ctx.storage.setAlarm(now + tickMs);
  }

  /**
   * Count a save or a snapshot: `error` says why when it failed. From SAVE_FAILURES_BEFORE_REASON in a row the
   * machine says its files aren't saving; the next one that works clears that, and the count.
   */
  async #saveWent(id: string, error?: string): Promise<void> {
    const failed = (await this.ctx.storage.get<number>(SAVE_FAILURES_KEY)) ?? 0;

    if (error === undefined) {
      if (failed === 0) return;
      await this.ctx.storage.delete(SAVE_FAILURES_KEY);

      if (failed >= SAVE_FAILURES_BEFORE_REASON) await this.#agent().sandboxTrouble(id, null);

      return;
    }

    await this.ctx.storage.put(SAVE_FAILURES_KEY, failed + 1);

    if (failed + 1 >= SAVE_FAILURES_BEFORE_REASON) await this.#agent().sandboxTrouble(id, `The sandbox couldn't save its files: ${error}`);
  }

  /** #save, counted: a failed one throws on. */
  async #counted(box: CloudBox, id: string): Promise<void> {
    try {
      await this.#save(box, id);
    } catch (error) {
      await this.#saveWent(id, errorText(error));

      throw error;
    }

    await this.#saveWent(id);
  }

  /** #snapshotIfDue, counted when it uploaded or failed; a failed snapshot is tried again at the next tick. */
  async #snapshot(box: CloudBox, id: string, turnsEnded: number): Promise<void> {
    const before = await this.ctx.storage.get<number>(SNAPSHOT_KEY);

    try {
      await this.#snapshotIfDue(box, id, turnsEnded);

      if ((await this.ctx.storage.get<number>(SNAPSHOT_KEY)) !== before) await this.#saveWent(id);
    } catch (error) {
      console.warn(`the sandbox ${id}'s snapshot failed; trying again at the next tick`, error);
      await this.#saveWent(id, errorText(error));
    }
  }

  /**
   * Save what must outlive the container to R2, then stop it; false when a task is open, or nothing
   * runs. The runner stops before the save, so no run starts that the save would miss; a run sent
   * meanwhile waits in the inbox, and wakes the machine again.
   */
  async sleep(): Promise<boolean> {
    const box = this.box();
    const id = await this.#id();

    if (!box || !(await box.running()) || (await this.#agent().cloudBusy(id))) return false;
    // Read before the save stops the runner: no turn ends after it.
    const ended = (await this.#agent().sandboxNow(id))?.turnsEnded ?? 0;

    await this.#counted(box, id);
    await this.ctx.storage.put(SNAPSHOT_KEY, ended);
    await box.destroy();
    await this.ctx.storage.delete(IDLE_KEY);

    if (await this.#agent().cloudBusy(id)) await this.ctx.storage.setAlarm(this.clock());

    return true;
  }

  /**
   * Its sandbox was deleted, and its tasks ended: save the disk if the container runs, which the
   * kept disk then holds, stop it, and forget everything else. Until that is done it is retiring,
   * and Settings starts no sandbox from its disk. A failed save throws, and the alarm tries again.
   * A sandbox live again by the time the save is in (as after a restore) keeps running.
   */
  async retire(): Promise<void> {
    const box = this.box();
    const id = await this.#id();

    await this.ctx.storage.put(RETIRING_KEY, true);

    try {
      if (box && (await box.running())) await this.#counted(box, id);
    } catch (error) {
      await this.ctx.storage.setAlarm(this.clock() + RETRY_MS);

      throw error;
    }

    const live = await this.#agent().sandboxNow(id);

    if (live) {
      await this.ctx.storage.put(SNAPSHOT_KEY, live.turnsEnded);
      await this.ctx.storage.delete(RETIRING_KEY);

      return;
    }

    if (box && (await box.running())) await box.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Whether nothing runs or waits here: no container, no retire unfinished, no alarm. Then its kept
   * disk's save is whole, and a new sandbox may start from it, or the disk may be dropped.
   */
  async settled(): Promise<boolean> {
    const box = this.box();

    if (box && (await box.running())) return false;

    return !(await this.ctx.storage.get<boolean>(RETIRING_KEY)) && (await this.ctx.storage.getAlarm()) === null;
  }

  /** Its kept disk is being deleted: stop the container with no save, if one still runs, and forget everything. */
  async forget(): Promise<void> {
    const box = this.box();

    if (box && (await box.running())) await box.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Put what must outlive the container to R2, at the sandbox's key. A runner still waiting for its
   * files has nothing new, and its save would be an empty home over the last one: it keeps that.
   */
  async #save(box: CloudBox, id: string): Promise<void> {
    const ping = await box.fetch("/ping").catch(() => undefined);

    if (ping?.ok && (await ping.text()).trim() === "waiting") return;
    await this.#put(id, await box.fetch("/save", { method: "POST" }));
  }

  /**
   * Snapshot the running container's disk to R2 if `turnsEnded` passed the count of the last save.
   * The count moves only once R2 has the disk; a failed snapshot throws.
   */
  async #snapshotIfDue(box: CloudBox, id: string, turnsEnded: number): Promise<void> {
    if (turnsEnded <= ((await this.ctx.storage.get<number>(SNAPSHOT_KEY)) ?? 0) || !(await box.running())) return;
    const ping = await box.fetch("/ping");

    // Waiting for its files, it has nothing newer; stopped, a save took it, or #up will.
    if (!ping.ok || (await ping.text()).trim() !== "running") return;
    await this.#put(id, await box.fetch("/snapshot"));
    await this.ctx.storage.put(SNAPSHOT_KEY, turnsEnded);
  }

  /**
   * Put the runner's tar.gz answer to R2, at the sandbox `id`'s key, as it streams in: one upload part
   * in memory at a time, and the last save kept unless all of this one arrives (src/uploads.ts). Its
   * time is bounded by SAVE_WITHIN_MS, under the alarm's 15 minutes; a runner whose tar fails breaks
   * its answer off, which fails the upload.
   */
  async #put(id: string, answer: Response): Promise<void> {
    if (!answer.ok || !answer.body) throw new Error(`The sandbox ${id} didn't save its files: ${answer.status} ${await answer.text()}`);
    await putInParts(this.env.FILES, saveKey(id), answer.body);
  }

  /**
   * Start the container as `name` if it isn't running, and give it its files if it waits for them.
   * A stopped runner is saved, then started afresh, `restarts` times at most: one start per call.
   * One whose save fails is never destroyed; the start fails, and the alarm counts it.
   */
  async #up(box: CloudBox, id: string, name: string, restarts = 1): Promise<void> {
    const began = Date.now();
    const starting = !(await box.running());

    if (starting) {
      await this.#start(box, id, name);

      // Deleted while it started, after the delete looked for a container to stop: stop it here.
      if (!(await this.#agent().sandboxNow(id))) {
        await box.destroy();

        return;
      }
    }

    const state = await this.#ping(box);
    const listening = Date.now() - began;

    if (state === "stopped") {
      if (restarts === 0) throw new Error(`The sandbox ${id}'s runner was stopped again as it started`);
      // Stopped by a save whose upload failed: its disk may be newer than R2's, so save it, then start afresh.
      await this.#counted(box, id).catch((error: Error) => {
        throw new Error(`its runner is stopped and its files couldn't be saved, so it is kept as it is: ${error.message}`);
      });
      await box.destroy();

      return this.#up(box, id, name, restarts - 1);
    }

    if (state !== "waiting") return;
    const size = await this.#restore(box, id);
    // Where a wake's time goes, in the Worker's logs; the runner dials ky right after the restore.
    console.log(`the sandbox ${name} ${starting ? "started" : "was running"}: listening after ${listening}ms, its files (${size} bytes) restored after ${Date.now() - began}ms`);
  }

  /** Start a container for the sandbox `id`, paired as `name`, that dials ky where a browser last opened it. */
  async #start(box: CloudBox, id: string, name: string): Promise<void> {
    const origin = await this.ctx.storage.get<string>(ORIGIN_KEY);

    if (!origin) throw new Error("ky's address isn't known yet: open ky in a browser once");
    const token = await pairAs(this.env, name, CLOUD_FACTS, id);

    await box.start({ KY_URL: origin, KY_MACHINE: name, KY_RUNNER_TOKEN: token }, id);
  }

  /** Give a waiting container the sandbox `id`'s saved files, none if there is no save; how many bytes they were. */
  async #restore(box: CloudBox, id: string): Promise<number> {
    const save = await this.env.FILES.get(saveKey(id));
    const restored = await box.fetch("/restore", { method: "PUT", body: save?.body ?? "" });

    if (!restored.ok && restored.status !== 409) throw new Error(`The sandbox ${id} didn't take its files: ${restored.status} ${await restored.text()}`);

    return save?.size ?? 0;
  }

  /** What the runner says it is doing, once it answers. */
  async #ping(box: CloudBox): Promise<string> {
    const until = Date.now() + START_WITHIN_MS;

    for (;;) {
      try {
        const answer = await box.fetch("/ping");

        if (answer.ok) return (await answer.text()).trim();
      } catch (error) {
        // A refused start: the alarm starts it again in RETRY_MS, where waiting here would take START_WITHIN_MS.
        if (Date.now() > until || String(error).includes(NO_INSTANCE)) throw error;
      }

      if (Date.now() > until) throw new Error("The cloud machine didn't start listening");
      await scheduler.wait(500);
    }
  }
}
