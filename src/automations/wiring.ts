import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ROOT_SESSION } from "agents/harness/pi";
import { type Schedule, Scheduler } from "agents/schedules";
import { makeEdge, type Refusable } from "../core/edge";
import type { Result } from "../core/refusal";
import { Sql } from "../core/sql";
import type { Models } from "../providers/wiring";
import type { Reviews, Specialists } from "../skills/contract";
import { type AutomationDeps, Automator, type Callbacks, type Fire, type GateCheck, Host } from "./automations";
import { AUTOMATION_SOURCE, type AutomationAuthor, type AutomationDraft, type AutomationRow, type AutomationStatus, type AutomationView, type CheckIns } from "./contract";
import { automationExtension, checkInGuardExtension } from "./tool";

export { Deliveries, deliveryExtension } from "./delivery";

export { TaskFeed } from "./tasks";

export class Automations {
  readonly #listeners = new Set<() => void>();
  readonly #deps: AutomationDeps;
  readonly scheduler: Scheduler<Callbacks>;

  readonly #edge;

  constructor(storage: DurableObjectStorage, deps: AutomationDeps, booker = (callbacks: Callbacks) => new Scheduler<Callbacks>({ callbacks })) {
    this.#deps = deps;
    this.scheduler = booker({
      automation: (fire: Fire, schedule: Schedule<Fire>) => this.#void(Automator.use((automator) => automator.fire(fire, schedule))),
      dream: async () => this.#deps.dream.run(),
      look: async ({ time }) => this.#deps.looks.run(time),
      peers: () => this.#deps.peers(),
      machines: async () => this.#deps.machines.recheck(),
      approvals: async () => this.#deps.approvals(),
      sites: () => this.#deps.sites()
    });

    const host = Layer.succeed(Host)({
      ...deps,
      scheduler: this.scheduler,
      emit: () => this.#emit()
    });

    this.#edge = makeEdge(Automator.layer.pipe(Layer.provide(Layer.mergeAll(Sql.layer(storage), host))));
    this.#edge.run(Automator.use(() => Effect.void));
    deps.feed.onChange((tasks) => {
      if (tasks.some((task) => task.source.startsWith(AUTOMATION_SOURCE))) this.#emit();
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(id: string): AutomationRow | undefined {
    return this.#edge.run(Automator.use((automator) => automator.get(id)));
  }

  async list(all = true): Promise<AutomationView[]> {
    return this.#edge.runPromise(Automator.use((automator) => automator.list(all)));
  }

  watches(): Array<{ readonly id: string; readonly watch: number; readonly status: AutomationStatus }> {
    return this.#edge.run(Automator.use((automator) => automator.watches));
  }

  checkIns(): CheckIns {
    return this.#edge.run(Automator.use((automator) => automator.checkIns));
  }

  setCheckIns(on: boolean): Promise<void> {
    return this.#void(Automator.use((automator) => automator.setCheckIns(on)));
  }

  setZone(zone: string): Promise<void> {
    return this.#void(Automator.use((automator) => automator.setZone(zone)));
  }

  async pinZone(zone: string): Promise<void> {
    await this.#edge.runPromise(Effect.catch(Automator.use((automator) => automator.pinZone(zone)), ({ refusal }) => Effect.die(new Error(refusal))));
  }

  unpinZone(detected: string | null): Promise<void> {
    return this.#void(Automator.use((automator) => automator.unpinZone(detected)));
  }

  checkInRun(session: string): boolean {
    return this.#edge.run(Automator.use((automator) => automator.checkInRun(session)));
  }

  create(draft: AutomationDraft, author: AutomationAuthor, watch: number | null = null): Promise<Result<AutomationRow>> {
    return this.#edge.runPromise(Automator.use((automator) => automator.create(draft, author, watch)));
  }

  update(id: string, patch: Partial<AutomationDraft>): Promise<Result<AutomationRow>> {
    return this.#edge.runPromise(Automator.use((automator) => automator.update(id, patch)));
  }

  pause(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.pause(id)));
  }

  stop(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.stop(id)));
  }

  archive(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.archive(id)));
  }

  resume(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.resume(id)));
  }

  delete(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.delete(id)));
  }

  retire(id: string): Promise<void> {
    return this.#void(Automator.use((automator) => automator.retire(id)));
  }

  unarchive(id: string): string {
    return this.#edge.run(Effect.catch(Automator.use((automator) => automator.unarchive(id)), ({ refusal }) => Effect.succeed(refusal)));
  }

  run(id: string): Promise<string> {
    return this.#say(Automator.use((automator) => automator.run(id)));
  }

  wanted(feedId: string): boolean {
    return this.#edge.run(Automator.use((automator) => automator.wanted(feedId)));
  }

  recheckMachinesAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookAt("machines", at)));
  }

  sweepPeersAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookAt("peers", at)));
  }

  sweepApprovalsAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.approvalsAt(at)));
  }

  flushSitesAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookAt("sites", at)));
  }

  dreamAt(at: number): Promise<void> {
    return this.#void(Automator.use((automator) => automator.dreamAt(at)));
  }

  recover(): Promise<void> {
    return this.#void(Automator.use((automator) => automator.recover));
  }

  bookLooks(): Promise<void> {
    return this.#void(Automator.use((automator) => automator.bookLooks));
  }

  async checkGate(code: string): Promise<GateCheck> {
    return this.#edge.runPromise(Automator.use((automator) => automator.checkGate(code)));
  }

  chatLabel(session: string): string {
    if (session === ROOT_SESSION) return "main";
    const title = this.#deps.chats.list().find((each) => each.session === session)?.title;

    return `${title || "untitled"} (${session})`;
  }

  #say<E extends Refusable>(action: Effect.Effect<string, E, Automator>): Promise<string> {
    return this.#edge.runPromise(Effect.catch(action, ({ refusal }) => Effect.succeed(refusal)));
  }

  #void(action: Effect.Effect<unknown, never, Automator>): Promise<void> {
    return this.#edge.runPromise(Effect.asVoid(action));
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

type AutomationsWiring = {
  readonly automations: Automations;
  readonly models: Models;
  readonly reviews: Reviews;
  readonly specialists: Specialists;
};

export function automationTools({ automations, models, reviews, specialists }: AutomationsWiring) {
  return {
    automations: automationExtension(
      automations,
      () => models.resolve("worker").choice,
      (session) => reviews.kind(session) === "dream",
      (session) => specialists.profileOf(session).owner
    ),
    checkInGuard: checkInGuardExtension(automations)
  };
}
