import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { TaskFeed, TaskRow } from "../automations/contract";
import { makeEdge } from "../core/edge";
import type { Result } from "../core/refusal";
import { Sql } from "../core/sql";
import type { FileStore } from "../files/wiring";
import type { MachineInfo } from "../protocol";
import type { Sandboxes } from "../runners/wiring";
import type { CloudHook, MachineChange, SessionCreds, TaskTokens } from "./contract";
import { type Harness, Host, Machines } from "./machines";
import type { Agent, MachineFacts, TaskReport } from "./runner-protocol";
import { machineExtension } from "./tool";

export { RunnerPipe } from "./pipe";

export class MachineHub {
  retryMs = 1_000;
  cloud: CloudHook | undefined;
  recheckAt: (at: number) => void = () => {};
  #harness: Harness | undefined;
  #wanted: (task: string) => boolean = () => true;
  readonly #watchers = new Set<() => void>();
  readonly #edge;

  constructor(
    storage: DurableObjectStorage,
    feed: TaskFeed,
    sockets: (tag: string) => WebSocket[],
    files: FileStore,
    tokens: TaskTokens,
    creds: SessionCreds,
    sandboxes: Sandboxes
  ) {
    const host = Layer.succeed(Host)({
      feed,
      sockets,
      shared: (task) => files.forTask(task),
      tokens,
      creds,
      sandboxes,
      harness: () => this.#harness,
      wanted: (task) => this.#wanted(task),
      cloud: () => this.cloud,
      recheckAt: (at) => this.recheckAt(at),
      changed: () => this.changed(),
      retryMs: () => this.retryMs
    });

    this.#edge = makeEdge(Machines.layer.pipe(Layer.provide(Layer.mergeAll(Sql.layer(storage), host))));
    this.#edge.run(Machines.use(() => Effect.void));
  }

  attach(harness: Harness, wanted: (task: string) => boolean = () => true): void {
    this.#harness = harness;
    this.#wanted = wanted;
  }

  online(machine: string): boolean {
    return this.#edge.run(Machines.use((machines) => machines.online(machine)));
  }

  recheck(): void {
    this.#edge.run(Machines.use((machines) => machines.recheck));
  }

  refused(machine: string, protocol: number): void {
    this.#edge.run(Machines.use((machines) => machines.refused(machine, protocol)));
  }

  trouble(machine: string, reason: string | null): void {
    this.#edge.run(Machines.use((machines) => machines.trouble(machine, reason)));
  }

  startFailed(machine: string, text: string): Promise<void> {
    return this.#edge.runPromise(Machines.use((machines) => machines.startFailed(machine, text)));
  }

  machines(): MachineInfo[] {
    return this.#edge.run(Machines.use((machines) => machines.machines));
  }

  machine(name: string): MachineInfo | undefined {
    return this.#edge.run(Machines.use((machines) => machines.machine(name)));
  }

  onChange(listener: () => void): void {
    this.#watchers.add(listener);
  }

  changed(): void {
    for (const watcher of this.#watchers) watcher();
  }

  change(name: string, change: MachineChange): Result<MachineInfo> {
    return this.#edge.run(Machines.use((machines) => machines.configure(name, change)));
  }

  seen(machine: string, code?: number): void {
    this.#edge.run(Machines.use((machines) => machines.seen(machine, code)));
  }

  sweepTokens(): Promise<void> {
    return this.#edge.runPromise(Machines.use((machines) => machines.sweepTokens));
  }

  defaultAgent(machine: string): Agent {
    return this.#edge.run(Machines.use((machines) => machines.defaultAgent(machine)));
  }

  start(machine: string, title: string, prompt: string, id: string, parent: string, source = "chat", agent = this.defaultAgent(machine)): TaskRow {
    const { task, queued } = this.#edge.run(Machines.use((machines) => machines.start(machine, title, prompt, id, parent, source, agent)));

    if (queued) this.#deliver(machine);

    return task;
  }

  send(task: TaskRow, message: string, parent?: string): void {
    this.#edge.run(Machines.use((machines) => machines.send(task, message, parent)));
    this.#deliver(task.worker);
  }

  move(task: TaskRow, to: string): string | null {
    const refusal = this.#edge.run(Machines.use((machines) => machines.move(task, to)));

    if (refusal !== null) return refusal;
    void this.#edge.runPromise(Machines.use((machines) => machines.revoke(task.id)));
    this.#deliver(to);

    return null;
  }

  stop(task: TaskRow): Promise<void> {
    return this.#edge.runPromise(Machines.use((machines) => machines.stop(task)));
  }

  remove(machine: string): Promise<string | null> {
    return this.#edge.runPromise(Machines.use((machines) => machines.remove(machine)));
  }

  paired(machine: string, facts: MachineFacts, pairing: string): string | null {
    return this.#edge.run(Machines.use((machines) => machines.paired(machine, facts, pairing)));
  }

  listSandboxes(): { stale: string[]; clashes: string[] } {
    return this.#edge.run(Machines.use((machines) => machines.listSandboxes));
  }

  sandboxFor(repo: string): string | undefined {
    return this.#edge.run(Machines.use((machines) => machines.sandboxFor(repo)));
  }

  cloudOn(): string | undefined {
    return this.#edge.run(Machines.use((machines) => machines.cloudOn));
  }

  busy(machine: string): boolean {
    return this.#edge.run(Machines.use((machines) => machines.busy(machine)));
  }

  turnsEnded(machine: string): number {
    return this.#edge.run(Machines.use((machines) => machines.turnsEnded(machine)));
  }

  pairedAs(machine: string, pairing: string | undefined): boolean {
    return this.#edge.run(Machines.use((machines) => machines.pairedAs(machine, pairing)));
  }

  onReport(machine: string, report: TaskReport, connection: string): Promise<void> {
    return this.#edge.runPromise(Machines.use((machines) => machines.onReport(machine, report, connection)));
  }

  post(task?: string): Promise<void> {
    return this.#edge.runPromise(Machines.use((machines) => machines.post(task)));
  }

  #deliver(machine: string): void {
    void this.#edge.runPromise(Machines.use((machines) => machines.deliver(machine)));
  }
}

export type MachinesWiring = {
  readonly machines: MachineHub;
  readonly feed: TaskFeed;
};

export function machineTools({ machines, feed }: MachinesWiring) {
  return { machines: machineExtension(machines, feed) };
}
