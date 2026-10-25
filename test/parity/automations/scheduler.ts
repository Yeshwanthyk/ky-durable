/**
 * The Agents SDK Scheduler (`agents/schedules`) as automations use it, in memory: what `set`, `get`, `list` and
 * `cancel` answer, by the rules of node_modules/agents/dist/scheduler-*.js. A Date books a one-shot ("scheduled",
 * its time in seconds) and a string a cron; an idempotent one-shot finds the booking with the same callback and
 * payload whatever its time, and a cron finds one with the same cron, unless `idempotent: false`. `due` runs what
 * is due at `Date.now()`, oldest first: a callback that throws is tried again, three times in all, then a one-shot
 * is dropped and a cron moves to its next time. The parity world and the invariants run both sides on it.
 */
import type { Schedule, ScheduleOptions, SchedulerHandlers, SchedulerPayload } from "agents/schedules";
import { parseCronExpression } from "cron-schedule";

/** A callback's tries before the Scheduler gives up on a fire. */
const ATTEMPTS = 3;

/** The most fires one `due` runs, so a callback that books itself now can't loop forever. */
const MOST_FIRES = 200;

const nextCron = (cron: string, now: number) => Math.floor(parseCronExpression(cron).getNextDate(new Date(now)).getTime() / 1000);

type Job = Schedule<unknown> & { readonly type: "scheduled" | "cron" };

export class Bookings<Callbacks extends SchedulerHandlers = SchedulerHandlers> {
  readonly #callbacks: Callbacks;
  readonly #jobs = new Map<string, Job>();
  #made = 0;
  /** The last fire run, which `redeliver` runs again: the Scheduler delivers at least once. */
  #last: Job | undefined;

  constructor({ callbacks }: { callbacks: Callbacks }) {
    this.#callbacks = callbacks;
  }

  async set<Name extends keyof Callbacks & string>(when: Date | string, callback: Name, payload?: SchedulerPayload<Callbacks[Name]>, options?: ScheduleOptions): Promise<Schedule<SchedulerPayload<Callbacks[Name]>>> {
    const timing = when instanceof Date ? { type: "scheduled" as const, time: Math.floor(when.getTime() / 1000) } : { type: "cron" as const, time: nextCron(when, Date.now()), cron: when };
    const idempotent = timing.type === "cron" ? options?.idempotent !== false : options?.idempotent === true;
    const json = JSON.stringify(payload);
    const found = idempotent ? [...this.#jobs.values()].find((job) => job.type === timing.type && job.callback === callback && JSON.stringify(job.payload) === json && (job.type !== "cron" || !("cron" in timing) || job.cron === timing.cron)) : undefined;
    let job = found;

    if (!job) {
      this.#made += 1;
      // Payloads go through storage, as the real one's do.
      job = { id: `s${this.#made}`, callback, payload: structuredClone(payload), ...timing };
      this.#jobs.set(job.id, job);
    }

    // SAFETY: a booking's payload is what its callback was booked with.
    return { ...job } as Schedule<SchedulerPayload<Callbacks[Name]>>;
  }

  async get(id: string): Promise<Schedule<unknown> | undefined> {
    const job = this.#jobs.get(id);

    return job && { ...job };
  }

  async list(): Promise<Array<Schedule<unknown>>> {
    return [...this.#jobs.values()].map((job) => ({ ...job }));
  }

  async cancel(id: string): Promise<boolean> {
    return this.#jobs.delete(id);
  }

  /** Take over `other`'s bookings, as an object started again over the same storage finds them. */
  adopt(other: Bookings): void {
    for (const job of other.#jobs.values()) this.#jobs.set(job.id, job);
    this.#made = other.#made;
  }

  /** When the next fire is due, in ms; null with nothing booked. */
  nextAlarm(): number | null {
    const times = [...this.#jobs.values()].map((job) => job.time * 1000);

    return times.length === 0 ? null : Math.min(...times);
  }

  /** Every fire due by now, oldest first; one booked now by a fire runs too. */
  async due(): Promise<void> {
    for (let fires = 0; fires < MOST_FIRES; fires += 1) {
      const job = [...this.#jobs.values()].filter((each) => each.time * 1000 <= Date.now()).sort((a, b) => a.time - b.time || Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];

      if (!job) return;
      await this.#run(job);

      // A fire may cancel its own booking; what is left ends or moves on.
      if (this.#jobs.get(job.id) === job) {
        if (job.type === "cron") this.#jobs.set(job.id, { ...job, time: nextCron(job.cron, Date.now()) });
        else this.#jobs.delete(job.id);
      }
    }
  }

  /** The last fire, delivered again, as the Scheduler may after an eviction. */
  async redeliver(): Promise<void> {
    if (this.#last) await this.#run(this.#last);
  }

  async #run(job: Job): Promise<void> {
    this.#last = job;
    const handler = this.#callbacks[job.callback];

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        // SAFETY: a booking's payload is what its callback was booked with.
        await handler?.(structuredClone(job.payload) as never, { ...job } as never);

        return;
      } catch {
        // The real one logs it and tries again.
      }
    }
  }
}
