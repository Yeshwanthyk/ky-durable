import type { Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Automations, Delivery, TaskFeed } from "../automations/contract";
import { type Edge, makeEdge, type Refusable, runOrThrow } from "../core/edge";
import { Sql } from "../core/sql";
import type { Models } from "../providers/wiring";
import { Versioned, Versions } from "../dreaming/wiring";
import type {
  AccessChange,
  Machinery,
  Profile,
  ReviewHost,
  ReviewKind,
  SessionKind,
  SkillChange,
  SkillStatus,
  SpecialistAccess,
  SpecialistDraft,
  SpecialistRow,
  SpecialistView
} from "./contract";
import { Machines, Profiles } from "./profiles";
import { Library, REVIEW_AFTER, ReviewLog, skillsExtension, type Watcher } from "./skills";
import { Roster, specialistExtension } from "./specialists";
import { subagentExtension, subagentProgressExtension } from "./subagents";

export { draftFromDemo } from "./skills";

/** A ky with no sandboxes and no Macs: what the node tests run on. */
const NO_MACHINES: Machinery = {
  sandboxes: () => [],
  macs: () => [],
  open: () => {
    throw new Error("This ky has no sandboxes.");
  }
};

/** The specialists, with B's methods: a refusal throws in B's words, and storage is the Durable Object's. */
export class Specialists {
  readonly #edge: Edge<Roster | Versions | Profiles>;
  readonly #listeners = new Set<() => void>();

  /** One edge for the Durable Object's life; its first run makes the tables, as B's constructor did. */
  constructor(storage: DurableObjectStorage, machines: Machinery = NO_MACHINES) {
    const hooks = { listeners: this.#listeners };
    const roster = Roster.layer(hooks).pipe(Layer.provideMerge(Versions.layer));

    this.#edge = makeEdge(
      Profiles.layer(hooks).pipe(Layer.provideMerge(roster), Layer.provide(Layer.succeed(Machines)(machines)), Layer.provide(Sql.layer(storage)))
    );
    this.#run(() => Effect.void);
  }

  #run<A, E extends Refusable>(action: (roster: Roster["Service"]) => Effect.Effect<A, E>): A {
    return runOrThrow(this.#edge, Roster.use(action));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  list(): SpecialistRow[] {
    return this.#run((roster) => roster.list);
  }

  get(id: string): SpecialistRow | undefined {
    return this.#run((roster) => roster.get(id));
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  views(): SpecialistView[] {
    return this.list().map((row) => ({ ...row, brief: this.brief(row.id).view() }));
  }

  brief(id: string): Versioned {
    return new Versioned(this.#edge, `specialist:${id}`, `@${id}'s brief`, { listeners: this.#listeners });
  }

  /** A new specialist, with a sandbox of its own and, when the user made it, the Mac they named. */
  create(id: string, draft: SpecialistDraft, actor: string, conversation: string | null = null): string {
    return runOrThrow(
      this.#edge,
      Effect.gen(function* () {
        const created = yield* Roster.use((roster) => roster.create(id, draft, actor, conversation));
        const profiles = yield* Profiles;
        yield* profiles.found(id, actor === "user" ? (draft.machine ?? null) : null);
        yield* profiles.provide(id);

        return created;
      })
    );
  }

  /** ky's own example specialist: its sandbox is made when it is first asked, so a ky no one asks has one sandbox. */
  seed(id: string, draft: SpecialistDraft): void {
    runOrThrow(
      this.#edge,
      Effect.gen(function* () {
        yield* Roster.use((roster) => roster.create(id, draft, "ky", null));
        yield* Profiles.use((profiles) => profiles.found(id, null));
      })
    );
  }

  /** The user deletes a specialist: its row and its grants. Its sandbox, conversations and brief's versions stay. */
  delete(id: string): string {
    return runOrThrow(
      this.#edge,
      Effect.gen(function* () {
        const deleted = yield* Roster.use((roster) => roster.remove(id));
        yield* Profiles.use((profiles) => profiles.forget(id));

        return deleted;
      })
    );
  }

  /** At boot, after the sandboxes: each specialist made before profiles gets its own. */
  migrate(): void {
    this.#edge.run(Profiles.use((profiles) => profiles.migrate));
  }

  /** `conversation`, started from `parent`, belongs to whoever owns `parent`. */
  adopt(conversation: string, parent: string): void {
    this.#edge.run(Profiles.use((profiles) => profiles.adopt(conversation, parent)));
  }

  /** A Mac removed from ky: every grant of it goes. */
  dropMac(mac: string): void {
    this.#edge.run(Profiles.use((profiles) => profiles.dropMac(mac)));
  }

  /** The profile of whoever answers in `conversation`, as it is now: every scoped tool reads it here. */
  profileOf(conversation: string): Profile {
    return this.#edge.run(Profiles.use((profiles) => profiles.of(conversation)));
  }

  /** `owner`'s profile ("ky" or a specialist's id), as it is now. */
  profile(owner: string): Profile {
    return this.#edge.run(Profiles.use((profiles) => profiles.get(owner)));
  }

  /** Each specialist's machines, for Settings. */
  access(): Readonly<Record<string, SpecialistAccess>> {
    return Object.fromEntries(
      this.list().map(({ id }) => {
        const { home, macs } = this.profile(id);

        return [id, { home: home?.id ?? null, macs }];
      })
    );
  }

  /** The user changes a specialist's machines; a specialist's own tools never can. */
  changeAccess(id: string, change: AccessChange): string {
    return runOrThrow(this.#edge, Profiles.use((profiles) => profiles.change(id, change)));
  }

  /** Change a specialist's description, model or machine; its brief changes through brief(). */
  set(id: string, draft: SpecialistDraft): string {
    return this.#run((roster) => roster.set(id, draft));
  }

  /** Record a conversation as one of `id`'s; a home one becomes its shared conversation. Its first gives it a sandbox, if it has none. */
  attach(session: string, id: string, kind: SessionKind): void {
    this.#edge.run(
      Effect.gen(function* () {
        yield* Roster.use((roster) => roster.attach(session, id, kind));
        yield* Profiles.use((profiles) => profiles.provide(id));
      })
    );
  }

  /** The specialist a conversation belongs to, and how it is used. */
  bySession(session: string): { specialist: SpecialistRow; kind: SessionKind } | undefined {
    return this.#run((roster) => roster.bySession(session));
  }
}

/** The skill library, with B's methods: a refusal throws in B's words, and storage is the Durable Object's. */
export class Skills {
  readonly #edge: Edge<Library>;
  readonly #listeners = new Set<() => void>();
  readonly #writes = new Set<Watcher>();
  /** A turn with at least this many tool calls is reviewed. */
  reviewAfter = REVIEW_AFTER;

  /** One edge for the Durable Object's life; its first run makes the tables, as B's constructor did. */
  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Library.layer({ writes: this.#writes, listeners: this.#listeners }).pipe(Layer.provide(Sql.layer(storage))));
    this.#run(() => Effect.void);
  }

  #run<A, E extends Refusable>(action: (library: Library["Service"]) => Effect.Effect<A, E>): A {
    return runOrThrow(this.#edge, Library.use(action));
  }

  /**
   * Called just before each change is written; a watcher that throws refuses the change. One that returns a
   * function hears the id of the version the change made, once it is written.
   */
  onWrite(watcher: Watcher): () => void {
    this.#writes.add(watcher);

    return () => this.#writes.delete(watcher);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(name: string) {
    return this.#run((library) => library.get(name));
  }

  list(status?: SkillStatus) {
    return this.#run((library) => library.list(status));
  }

  all() {
    return this.#run((library) => library.all);
  }

  history(name: string) {
    return this.#run((library) => library.history(name));
  }

  index() {
    return this.#run((library) => library.index);
  }

  view(name: string) {
    return this.#run((library) => library.view(name));
  }

  versionsSince(at: number, limit: number, exceptActor?: string) {
    return this.#run((library) => library.versionsSince(at, limit, exceptActor));
  }

  apply(change: SkillChange, actor: string, conversation?: string | null) {
    return this.#run((library) => library.apply(change, actor, conversation));
  }

  stale(run: string, now?: number) {
    return this.#run((library) => library.stale(run, now));
  }
}

/** The background conversations' log, with B's methods. */
export class Reviews {
  readonly #edge: Edge<ReviewLog>;

  /** One edge for the Durable Object's life; its first run makes the table, as B's constructor did. */
  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(ReviewLog.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#run(() => Effect.void);
  }

  #run<A>(action: (log: ReviewLog["Service"]) => Effect.Effect<A>): A {
    return runOrThrow(this.#edge, ReviewLog.use(action));
  }

  kind(conversation: string) {
    return this.#run((log) => log.kind(conversation));
  }

  has(conversation: string): boolean {
    return this.kind(conversation) !== undefined;
  }

  run(conversation: string) {
    return this.#run((log) => log.run(conversation));
  }

  add(conversation: string, parent: string, kind?: ReviewKind, mark?: { readonly upto?: number; readonly run?: string; readonly at?: number }): void {
    this.#run((log) => log.add(conversation, parent, kind, mark));
  }

  reached(parent: string, kind: ReviewKind) {
    return this.#run((log) => log.reached(parent, kind));
  }

  window(conversation: string) {
    return this.#run((log) => log.window(conversation));
  }
}

/** What the skills domain's tools are made from, on the agent (src/server.ts). */
export type SkillsWiring = {
  readonly skills: Skills;
  readonly reviews: Reviews;
  readonly specialists: Specialists;
  readonly feed: TaskFeed;
  readonly models: Models;
  readonly automations: Automations;
  /** Where skill reviews and dreams run and report. */
  readonly background: ReviewHost;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
  /** A conversation answering another ky's question (src/peers/peers.ts). */
  readonly peer: (session: string) => boolean;
  /** How an automation run's report reaches the user (src/automations/delivery.ts). */
  readonly deliver: (item: Delivery) => Promise<void>;
};

/** The skill tools, with the reviews of busy turns. */
export function skillTools({ skills, reviews, background, chat, peer }: SkillsWiring): Extension {
  return skillsExtension(skills, reviews, background, chat, peer);
}

/** The main agent's own extensions, which subagents and specialists may be given or not. */
export type MainTools = { readonly soul: Extension; readonly memory: Extension; readonly machines: Extension; readonly automations: Extension; readonly ui: Extension; readonly chats: Extension; readonly site: Extension };

/** Specialists, subagents and their progress steps; `spawn` starts a subagent from outside a tool call. */
export function delegationTools(
  { specialists: store, feed, models, automations, chat, deliver }: SkillsWiring,
  { soul, memory, machines, automations: automationTool, ui, chats, site }: MainTools
) {
  const specialists = specialistExtension(store, feed, chat, (feedId) => automations.wanted(feedId));

  const subagents = subagentExtension(
    feed,
    [soul, memory, machines, automationTool, specialists.manage, ui, chats, site],
    // A run's cards are posted with its report (src/ui-tool.ts).
    [ui],
    () => models.resolve("worker").choice,
    models,
    (feedId) => automations.wanted(feedId),
    {
      store,
      tools: specialists,
      // Specialists keep memory (to search it), machines, and the subagent tool (to ask a peer).
      remove: [soul, automationTool, specialists.manage, ui, chats, site],
      model: (own) => models.worker(own)
    },
    deliver
  );

  return { specialists, subagents: subagents.extension, spawn: subagents.spawn, progress: subagentProgressExtension(feed) };
}
