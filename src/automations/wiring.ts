/**
 * The automations domain's edge: the Durable Object holds one Automations, which runs the Automator
 * (src/automations/automations.ts) over its storage. Each method keeps B's shape for its callers: a
 * by-id action answers in one string, what it did or why not; create and update give the row or a
 * refusal; a defect throws, as it did.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Schedule, Scheduler } from "agents/schedules";
import { makeEdge, type Refusable } from "../core/edge";
import { isRefusal, type Result } from "../core/refusal";
import { Sql } from "../core/sql";
import type { Models } from "../models";
import type { Reviews } from "../skills/contract";
import { type AutomationDeps, Automator, type Callbacks, type Fire, type GateCheck, Host } from "./automations";
import { AUTOMATION_SOURCE, type AutomationAuthor, type AutomationDraft, type AutomationRow, type AutomationStatus, type AutomationView, type CheckIns } from "./contract";
import { automationExtension, checkInGuardExtension } from "./tool";

export type { AutomationDeps, AutomationRuntime, GateAnswer, GateCheck } from "./automations";

export { Deliveries, deliveryExtension } from "./delivery";

export { TaskFeed } from "./tasks";

/** A value the domain can't refuse; a refusal here is a bug. */
function sure<A extends object>(result: Result<A>): A {
  if (isRefusal(result)) throw new Error(`Unexpected refusal: ${result.refused}`);

  return result;
}

export class Automations {
  readonly #listeners = new Set<() => void>();
  readonly #deps: AutomationDeps;
  /** Install with `Lifecycle.use()`; its alarm fires the automations. */
  readonly scheduler: Scheduler<Callbacks> = new Scheduler<Callbacks>({
    callbacks: {
      automation: (fire: Fire, schedule: Schedule<Fire>) => this.#void(Automator.use((automator) => automator.fire(fire, schedule))),
      // It only starts the dream, so it never holds up the alarm.
      dream: async () => this.#deps.dream.run(),
      look: async ({ time }) => this.#deps.looks.run(time),
      peers: () => this.#deps.peers(),
      // A runner silent past ONLINE_WITHIN_MS shows offline though its socket looks open.
      machines: async () => this.#deps.machines.recheck()
    }
  });

  readonly #edge;

  constructor(storage: DurableObjectStorage, deps: AutomationDeps) {
    this.#deps = deps;

    const host = Layer.succeed(Host)({
      ...deps,
      scheduler: this.scheduler,
      emit: () => this.#emit(),
      checkGate: (code) => this.checkGate(code)
    });

    this.#edge = makeEdge(Automator.layer.pipe(Layer.provide(Layer.mergeAll(Sql.layer(storage), host))));
    // Built now, so the tables are there before the first request.
    sure(this.#edge.run(Automator.use(() => Effect.succeed({}))));
    // A run's progress changes an automation's last run; the feed does not say which task changed.
    deps.feed.onChange((tasks) => {
      if (tasks.some((task) => task.source.startsWith(AUTOMATION_SOURCE))) this.#emit();
    });
  }

  /** Called when an automation or its last run changes. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(id: string): AutomationRow | undefined {
    return sure(this.#edge.run(Automator.use((automator) => Effect.map(automator.get(id), (row) => ({ row }))))).row;
  }

  /** Newest first; without `all`, only the active and paused ones. */
  async list(all = true): Promise<AutomationView[]> {
    return sure(await this.#edge.runPromise(Automator.use((automator) => automator.list(all))));
  }

  /** The looks' watches (src/dreaming/looks.ts): each automation booked for a watch anticipation, its id and status. */
  watches(): Array<{ readonly id: string; readonly watch: number; readonly status: AutomationStatus }> {
    return sure(this.#edge.run(Automator.use((automator) => automator.watches)));
  }

  /** Whether the dream may book check-ins, and the user's time zone. On until the user turns them off. */
  checkIns(): CheckIns {
    return sure(this.#edge.run(Automator.use((automator) => automator.checkIns)));
  }

  /** Turn check-ins on or off; off pauses the ones waiting. */
  setCheckIns(on: boolean): Promise<void> {
    return this.#void(Automator.use((automator) => automator.setCheckIns(on)));
  }

  /** The user's time zone, from where their browser connects, unless they pinned one. */
  setZone(zone: string): Promise<void> {
    return this.#void(Automator.use((automator) => automator.setZone(zone)));
  }

  /** Pin the user's time zone, an IANA name, which later connects leave alone; one that isn't throws. */
  async pinZone(zone: string): Promise<void> {
    const pinned = await this.#edge.runPromise(Effect.as(Automator.use((automator) => automator.pinZone(zone)), {}));

    if (isRefusal(pinned)) throw new Error(pinned.refused);
  }

  /** Follow where the user's browser connects again, from `detected`, the asking connection's zone, when it has one. */
  unpinZone(detected: string | null): Promise<void> {
    return this.#void(Automator.use((automator) => automator.unpinZone(detected)));
  }

  /** Whether the pi session is a check-in's or a watch's run at work. */
  checkInRun(session: string): boolean {
    return sure(this.#edge.run(Automator.use((automator) => Effect.map(automator.checkInRun(session), (yes) => ({ yes }))))).yes;
  }

  /** A new active automation, booked; or why it was refused. `watch` is the watch anticipation a look books it for. */
  create(draft: AutomationDraft, author: AutomationAuthor, watch: number | null = null): Promise<Result<AutomationRow>> {
    return this.#edge.runPromise(Automator.use((automator) => automator.create(draft, author, watch)));
  }

  /** Change what it is or does; a new time re-books an active one. The changed automation, or why not. */
  update(id: string, patch: Partial<AutomationDraft>): Promise<Result<AutomationRow>> {
    return this.#edge.runPromise(Automator.use((automator) => automator.update(id, patch)));
  }

  pause(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.pause(id)));
  }

  /** Stop the run in progress and leave the automation on its schedule. */
  stop(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.stop(id)));
  }

  archive(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.archive(id)));
  }

  /** Book it again from now; a one-off whose time has passed runs at once. */
  resume(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.resume(id)));
  }

  /** Gone for good: no more fires, the run in progress stops, and the row is removed. */
  delete(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.delete(id)));
  }

  /** Gone for good as delete has it, but by ky: a look's watch, its anticipation left as it is. */
  retire(id: string): Promise<void> {
    return this.#void(Automator.use((automator) => automator.retire(id)));
  }

  /** Back to paused, so resuming it is a separate choice. */
  unarchive(id: string): string {
    const done = this.#edge.run(Automator.use((automator) => Effect.map(automator.unarchive(id), (said) => ({ said }))));

    return isRefusal(done) ? done.refused : done.said;
  }

  /** Fire it now, through the Scheduler like any fire, as its own slot. */
  run(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.run(id)));
  }

  /** Whether a task's report should still reach the chat: not for a paused or archived automation. */
  wanted(feedId: string): boolean {
    return sure(this.#edge.run(Automator.use((automator) => Effect.map(automator.wanted(feedId), (yes) => ({ yes }))))).yes;
  }

  /** Book a look at the machines at `at`, epoch ms (MachineHub.recheck). */
  recheckMachinesAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookAt("machines", at)));
  }

  /** Book peers' sweep at `at`, epoch ms. */
  sweepPeersAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookAt("peers", at)));
  }

  /** One dream at `at`, epoch ms, besides the nightly one; it replaces any such dream already booked. */
  dreamAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.dreamAt(at)));
  }

  /** On start: book the nightly dream, the looks, and any active automation whose booking is missing. */
  recover(): Promise<void> {
    return this.#void(Automator.use((automator) => automator.recover));
  }

  /** Book the looks again: the user changed their times or turned Proactivity on or off. */
  bookLooks(): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookLooks));
  }

  /** Run a gate's program once, as a fire does, and say what it came to. A tool's create and update test it this way. */
  async checkGate(code: string): Promise<GateCheck> {
    return sure(await this.#edge.runPromise(Automator.use((automator) => automator.checkGate(code))));
  }

  /** How the tool names a chat: main, or a side chat's title and session. */
  chatLabel(session: string): string {
    return sure(this.#edge.run(Automator.use((automator) => Effect.sync(() => ({ label: automator.chatLabel(session) }))))).label;
  }

  /** What a by-id action did, or why not, in the words the tool and Activity read. */
  async #say<E extends Refusable>(action: Effect.Effect<string, E, Automator>): Promise<string> {
    const done = await this.#edge.runPromise(Effect.map(action, (said) => ({ said })));

    return isRefusal(done) ? done.refused : done.said;
  }

  async #void(action: Effect.Effect<unknown, never, Automator>): Promise<void> {
    sure(await this.#edge.runPromise(Effect.as(action, {})));
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** What the automations domain's tools are made from, on the agent (src/server.ts). */
export type AutomationsWiring = {
  readonly automations: Automations;
  readonly models: Models;
  readonly reviews: Reviews;
};

/** The automation tool, and the guard that keeps a check-in to its tools. */
export function automationTools({ automations, models, reviews }: AutomationsWiring) {
  return {
    automations: automationExtension(
      automations,
      () => models.resolve("worker").choice,
      (session) => reviews.kind(session) === "dream"
    ),
    checkInGuard: checkInGuardExtension(automations)
  };
}
