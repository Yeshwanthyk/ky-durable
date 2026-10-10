import { DurableObject } from "cloudflare:workers";
import { CLOUD, CLOUD_FACTS } from "./cloud-facts";
import { pairAs } from "./runners";

/**
 * The cloud machine: a container that runs `ky runner cloud`, so tasks run with every personal
 * computer off. One per deploy, `env.CloudMachine.getByName("cloud")`, on a deploy with Workers Paid
 * (`ky deploy` attaches the container app; without one, `box()` is undefined and nothing runs).
 *
 * - It pairs itself: each start mints a new machine token from the Vault, as the pair route does,
 *   and hands it to the container; the runner says it is `kind: "cloud"`.
 * - MachineHub wakes it when a command waits for it offline. An alarm keeps it awake: while any
 *   task is open it pings the container every TICK_MS, since the runner's own outbound socket
 *   doesn't count as activity; idle for IDLE_MS, it sleeps.
 * - Sleeping saves what must outlive the container to R2 (Claude Code's sessions, each Codex task's
 *   home, the runner's handled seqs, the work trees); the next start restores it before the runner
 *   dials ky, so a follow-up resumes its session.
 * - git reaches github.com only through github.internal, which this routes to the Worker's
 *   GithubProxy (src/github.ts): it holds the token and lets pushes reach `ky/*` only.
 */

/** The container's runner, as the CloudMachine drives it; the stack replaces it with a fake host. */
export type CloudBox = {
  running(): Promise<boolean>;
  /** Start the container with `env`; it then answers on its port once `ky runner cloud` listens. */
  start(env: Record<string, string>): Promise<void>;
  /** A request to `ky runner cloud`'s port. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  destroy(): Promise<void>;
};

/** Where `ky runner cloud` listens in the container (cli/runner/cloud.ts's CLOUD_PORT). */
const PORT = 8080;

/** How often the alarm pings the container while it runs. */
const TICK_MS = 60_000;

/** How long the container runs with no task open before it sleeps. */
const IDLE_MS = 10 * 60_000;

/** How long a container has to start listening. */
const START_WITHIN_MS = 3 * 60_000;

/** How long the platform keeps a container whose port nothing asked: past a few missed ticks. */
const INACTIVITY_MS = 15 * 60_000;

/** The R2 key of the last sleep's save, in FILES. */
export const SAVE_KEY = "cloud-machine/save.tar.gz";

const ORIGIN_KEY = "origin";

const IDLE_KEY = "idleSince";

/** The real container, through the Durable Object's own `ctx.container`. */
function containerBox(ctx: DurableObjectState): CloudBox | undefined {
  const container = ctx.container;

  if (!container) return undefined;

  return {
    running: async () => container.running,
    start: async (env) => {
      // Before every start: a new container has no interceptor.
      await container.interceptOutboundHttp("github.internal", ctx.exports.GithubProxy);
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

export class CloudMachine extends DurableObject<Env> {
  /** The container, or undefined on a deploy without one. */
  box(): CloudBox | undefined {
    return containerBox(this.ctx);
  }

  /** How often the alarm comes while the container runs, and how long it stays up idle; tests shorten them. */
  async timing(): Promise<{ tickMs: number; idleMs: number }> {
    return { tickMs: TICK_MS, idleMs: IDLE_MS };
  }

  #agent() {
    return this.env.PiAgent.getByName("me");
  }

  /**
   * A command waits for the cloud machine: start it, if it isn't running, at the next alarm, now.
   * `origin` is ky's address, which the runner dials; the last one given is kept.
   */
  async wake(origin?: string): Promise<void> {
    if (origin) await this.ctx.storage.put(ORIGIN_KEY, origin);
    const at = await this.ctx.storage.getAlarm();

    if (at === null || at > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Keep the container up while a task is open, and put it to sleep once none has been for IDLE_MS. */
  override async alarm(): Promise<void> {
    const box = this.box();

    if (!box) return;
    const { tickMs, idleMs } = await this.timing();

    try {
      if (await this.#agent().cloudBusy()) {
        await this.ctx.storage.delete(IDLE_KEY);
        await this.#up(box);
        await this.ctx.storage.setAlarm(Date.now() + tickMs);

        return;
      }

      if (!(await box.running())) return;
      const idleSince = (await this.ctx.storage.get<number>(IDLE_KEY)) ?? Date.now();

      await this.ctx.storage.put(IDLE_KEY, idleSince);

      if (Date.now() - idleSince >= idleMs && (await this.sleep())) return;
      await box.fetch("/ping");
      await this.ctx.storage.setAlarm(Date.now() + tickMs);
    } catch (error) {
      console.warn("the cloud machine's alarm failed; trying again", error);
      await this.ctx.storage.setAlarm(Date.now() + tickMs);
    }
  }

  /**
   * Save what must outlive the container to R2, then stop it; false when a task is open, or nothing
   * runs. The runner stops before the save, so no run starts that the save would miss; a run sent
   * meanwhile waits in the inbox, and wakes the machine again.
   */
  async sleep(): Promise<boolean> {
    const box = this.box();

    if (!box || !(await box.running()) || (await this.#agent().cloudBusy())) return false;
    const saved = await box.fetch("/save", { method: "POST" });

    if (!saved.ok || !saved.body) throw new Error(`The cloud machine didn't save its files: ${saved.status} ${await saved.text()}`);
    const length = Number(saved.headers.get("content-length"));

    await this.env.FILES.put(SAVE_KEY, Number.isInteger(length) && length > 0 ? saved.body.pipeThrough(new FixedLengthStream(length)) : await saved.arrayBuffer());
    await box.destroy();
    await this.ctx.storage.delete(IDLE_KEY);

    if (await this.#agent().cloudBusy()) await this.ctx.storage.setAlarm(Date.now());

    return true;
  }

  /** Start the container if it isn't running, and give it its files if it waits for them. */
  async #up(box: CloudBox): Promise<void> {
    if (!(await box.running())) {
      const origin = await this.ctx.storage.get<string>(ORIGIN_KEY);

      if (!origin) throw new Error("ky's address isn't known yet: open ky in a browser once");
      const token = await pairAs(this.env, CLOUD, CLOUD_FACTS);

      await box.start({ KY_URL: origin, KY_MACHINE: CLOUD, KY_RUNNER_TOKEN: token });
    }

    const state = await this.#ping(box);

    if (state === "stopped") {
      // Stopped by a save whose upload failed: start afresh.
      await box.destroy();

      return this.#up(box);
    }

    if (state !== "waiting") return;
    const save = await this.env.FILES.get(SAVE_KEY);
    const restored = await box.fetch("/restore", { method: "PUT", body: save?.body ?? "" });

    if (!restored.ok && restored.status !== 409) throw new Error(`The cloud machine didn't take its files: ${restored.status} ${await restored.text()}`);
  }

  /** What the runner says it is doing, once it answers. */
  async #ping(box: CloudBox): Promise<string> {
    const until = Date.now() + START_WITHIN_MS;

    for (;;) {
      try {
        const answer = await box.fetch("/ping");

        if (answer.ok) return (await answer.text()).trim();
      } catch (error) {
        if (Date.now() > until) throw error;
      }

      if (Date.now() > until) throw new Error("The cloud machine didn't start listening");
      await scheduler.wait(500);
    }
  }
}
