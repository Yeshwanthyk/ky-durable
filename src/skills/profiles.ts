import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ToolPolicy } from "../approvals/contract";
import type { Refusable } from "../core/edge";
import { NoSandbox } from "../runners/contract";
import { type AccessChange, KY, type Machinery, type Profile, ProfileSchema, ProfileStored, SKILL_TABLES, SpecialistSession } from "./contract";
import { storage } from "./skills";
import { NoSpecialist, Roster } from "./specialists";

/**
 * Profiles: what each owner may use. ky's is what ky always had: the default sandbox, every other one
 * no specialist calls home, and every paired Mac. A specialist's is its own sandbox and the Macs the user
 * lets it use. Only the user changes one (Settings, or a card they answer), and every scoped tool reads
 * it through `of`. A specialist made before profiles gets its row once, at boot (`migrate`). A run of an
 * automation a specialist owns is pinned to the profile it started with: what the user grants later
 * isn't added to it, and what they take away is taken from it too.
 */

const PROFILES = SKILL_TABLES.specialistProfiles;

const OWNED = SKILL_TABLES.specialistOwned;

class NotAMac extends Schema.TaggedError<NotAMac>()("NotAMac", { mac: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.mac} isn't one of your paired Macs.`;
  }
}

class NotItsSandbox extends Schema.TaggedError<NotItsSandbox>()("NotItsSandbox", { sandbox: Schema.String, owner: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.owner === KY ? `${this.sandbox} is ky's default sandbox.` : `${this.sandbox} is @${this.owner}'s sandbox.`;
  }
}

/** Why a specialist has no sandbox of its own: the sandbox couldn't be made. */
class NoOwnSandbox extends Schema.TaggedError<NoOwnSandbox>()("NoOwnSandbox", { why: Schema.String }) {}

type Settings = { readonly home: string | null; readonly macs: readonly string[]; readonly tools: Profile["tools"] };

/** A damaged row, or none, grants nothing. */
const NOTHING: Settings = { home: null, macs: [], tools: {} };

const asStored = Schema.decodeUnknownOption(ProfileStored);

const HomeRow = Schema.Struct({ specialist: Schema.String, home: Schema.String });

const OwnedRow = Schema.Struct({ specialist: Schema.String, profile: Schema.NullOr(Schema.String) });

const asPinned = Schema.decodeUnknownOption(Schema.fromJsonString(ProfileSchema));

export class Machines extends Context.Service<Machines, Machinery>()("ky/skills/Machines") {}

interface SpecialistProfiles {
  /** The profile of whoever answers in `conversation`, as it is now. */
  readonly of: (conversation: string) => Effect.Effect<Profile>;
  /** `owner`'s profile, as it is now: "ky", or a specialist's id. One that is gone has nothing. */
  readonly get: (owner: string) => Effect.Effect<Profile>;
  /** A new specialist's first profile, with no sandbox yet and the one Mac the user gave it, if any. */
  readonly found: (id: string, mac: string | null) => Effect.Effect<void>;
  /** A sandbox of its own for a specialist that has none, if one can be made; asleep until a task wakes it. */
  readonly provide: (id: string) => Effect.Effect<void>;
  /** `conversation`, started from `parent`, belongs to whoever owns `parent`: a subagent, a machine task, a run. */
  readonly adopt: (conversation: string, parent: string) => Effect.Effect<void>;
  /** `conversation` is a run of `profile.owner`'s, and keeps `profile` (a snapshot) to its end. */
  readonly pin: (conversation: string, profile: Profile) => Effect.Effect<void>;
  /** The user grants or revokes a Mac, or moves the specialist to another sandbox. */
  readonly change: (id: string, change: AccessChange) => Effect.Effect<string, NoSpecialist | NotAMac | NoSandbox | NotItsSandbox>;
  /** A Mac removed from ky: no grant of it survives a different computer paired under its name. */
  readonly dropMac: (mac: string) => Effect.Effect<void>;
  /** Each specialist made before profiles: its own sandbox, and the Mac its hint named, granted once. */
  readonly migrate: Effect.Effect<void>;
  readonly forget: (id: string) => Effect.Effect<void>;
}

export class Profiles extends Context.Service<Profiles, SpecialistProfiles>()("ky/skills/Profiles") {
  /** Needs Sql, the Roster and the Machines; makes its tables. */
  static readonly layer = (hooks: { readonly listeners: ReadonlySet<() => void> }) =>
    Layer.effect(Profiles)(
      Effect.gen(function* () {
        const { exec, rows } = yield* storage;
        const roster = yield* Roster;
        const machines = yield* Machines;

        yield* exec(`CREATE TABLE IF NOT EXISTS ${SKILL_TABLES.specialistProfiles} (
          specialist TEXT PRIMARY KEY,
          home TEXT,
          macs TEXT NOT NULL DEFAULT '[]',
          tools TEXT NOT NULL DEFAULT '{}')`);
        yield* exec(`CREATE TABLE IF NOT EXISTS ${SKILL_TABLES.specialistOwned} (
          conversation TEXT PRIMARY KEY,
          specialist TEXT NOT NULL,
          profile TEXT)`);

        const ref = ({ id, name }: { readonly id: string; readonly name: string }) => ({ id, name });

        /** Each live specialist's home, by sandbox id. */
        const homes = Effect.map(
          rows(HomeRow, `SELECT p.specialist, p.home FROM ${PROFILES} p JOIN ${SKILL_TABLES.specialists} s ON s.id = p.specialist WHERE p.home IS NOT NULL`),
          (found) => new Map(found.map((row) => [row.home, row.specialist]))
        );

        const kyProfile = Effect.map(homes, (taken): Profile => {
          const sandboxes = machines.sandboxes().filter((each) => !taken.has(each.id));
          const home = sandboxes.find((each) => each.isDefault);

          return { owner: KY, home: home ? ref(home) : null, sandboxes: sandboxes.map(ref), macs: [...machines.macs()], tools: {} };
        });

        const settings = (id: string) =>
          Effect.map(exec(`SELECT home, macs, tools FROM ${PROFILES} WHERE specialist = ?`, id), ([stored]) =>
            stored === undefined ? undefined : Option.getOrElse(asStored(stored), () => NOTHING)
          );

        const keep = (id: string, next: Settings) =>
          Effect.gen(function* () {
            yield* exec(
              `INSERT INTO ${PROFILES} (specialist, home, macs, tools) VALUES (?, ?, ?, ?)
               ON CONFLICT (specialist) DO UPDATE SET home = excluded.home, macs = excluded.macs, tools = excluded.tools`,
              id,
              next.home,
              JSON.stringify(next.macs),
              JSON.stringify(next.tools)
            );
            yield* Effect.sync(() => {
              for (const listener of hooks.listeners) listener();
            });
          });

        const get = (owner: string) =>
          Effect.gen(function* () {
            if (owner === KY) return yield* kyProfile;
            const row = yield* roster.get(owner);
            const { home, macs, tools } = (row && (yield* settings(owner))) ?? NOTHING;
            const live = machines.sandboxes().find((each) => each.id === home);

            return { owner, home: live ? ref(live) : null, sandboxes: live ? [ref(live)] : [], macs: [...macs], tools: { ...tools } } satisfies Profile;
          });

        const ownedRow = (conversation: string) =>
          Effect.map(rows(OwnedRow, `SELECT specialist, profile FROM ${OWNED} WHERE conversation = ?`, conversation), ([row]) => row);

        /** A run's snapshot, less what its owner no longer has: a damaged one grants nothing. */
        const pinned = (owner: string, stored: string) =>
          Effect.gen(function* () {
            const now = yield* get(owner);
            const kept = Option.getOrUndefined(Option.filter(asPinned(stored), (profile) => profile.owner === owner));

            if (kept === undefined) return { owner, home: null, sandboxes: [], macs: [], tools: {} } satisfies Profile;
            const live = (sandbox: { readonly id: string }) => now.sandboxes.some((each) => each.id === sandbox.id);

            return {
              ...kept,
              home: kept.home && live(kept.home) ? kept.home : null,
              sandboxes: kept.sandboxes.filter(live),
              macs: kept.macs.filter((mac) => now.macs.includes(mac)),
              // A tool policy is the user's control as it is now, so a Block set mid-run stops the run's next call.
              tools: now.tools
            } satisfies Profile;
          });

        const of = (conversation: string) =>
          Effect.gen(function* () {
            const owned = yield* ownedRow(conversation);

            if (owned?.profile != null) return yield* pinned(owned.specialist, owned.profile);
            const [own] = yield* rows(SpecialistSession, `SELECT specialist, kind FROM ${SKILL_TABLES.specialistSessions} WHERE session = ?`, conversation);

            return yield* get(own?.specialist ?? owned?.specialist ?? KY);
          });

        const own = (conversation: string, owner: string, profile: string | null) =>
          exec(`INSERT OR REPLACE INTO ${OWNED} (conversation, specialist, profile) VALUES (?, ?, ?)`, conversation, owner, profile);

        /** Change the specialist `id`'s settings; refused for one that isn't. */
        const edit = (id: string, next: (current: Settings) => Settings) =>
          Effect.gen(function* () {
            if ((yield* roster.get(id)) === undefined) return yield* Effect.fail(new NoSpecialist({ id }));
            yield* keep(id, next((yield* settings(id)) ?? NOTHING));
          });

        const grantMac = (id: string, mac: string) =>
          Effect.gen(function* () {
            if (!machines.macs().includes(mac)) return yield* Effect.fail(new NotAMac({ mac }));
            yield* edit(id, (current) => ({ ...current, macs: [...new Set([...current.macs, mac])] }));

            return `@${id} can use ${mac}.`;
          });

        const revokeMac = (id: string, mac: string) =>
          Effect.as(
            edit(id, (current) => ({ ...current, macs: current.macs.filter((each) => each !== mac) })),
            `@${id} can no longer use ${mac}.`
          );

        const setHome = (id: string, home: string) =>
          Effect.gen(function* () {
            const found = machines.sandboxes().find((each) => each.id === home);

            if (found === undefined) return yield* Effect.fail(new NoSandbox({ id: home }));
            const owner = (yield* homes).get(home) ?? (found.isDefault ? KY : undefined);

            if (owner !== undefined && owner !== id) return yield* Effect.fail(new NotItsSandbox({ sandbox: found.name, owner }));
            yield* edit(id, (current) => ({ ...current, home }));

            return `@${id} works on ${found.name}.`;
          });

        /** The user sets how `id`'s turns treat `tool`, or (null) lets ky's policy decide again. */
        const setTool = (id: string, tool: string, policy: ToolPolicy | null) =>
          Effect.as(
            edit(id, (current) => ({ ...current, tools: policy === null ? Object.fromEntries(Object.entries(current.tools).filter(([each]) => each !== tool)) : { ...current.tools, [tool]: policy } })),
            policy === null ? `@${id} follows ky's policy for ${tool}.` : `@${id}'s ${tool}: ${policy}.`
          );

        const found = (id: string, mac: string | null) => keep(id, { home: null, macs: mac !== null && machines.macs().includes(mac) ? [mac] : [], tools: {} });

        const provide = (id: string) =>
          Effect.gen(function* () {
            const current = yield* settings(id);

            if (current === undefined || current.home !== null) return;
            const made = yield* Effect.try({ try: () => machines.open(id), catch: (cause) => new NoOwnSandbox({ why: cause instanceof Error ? cause.message : String(cause) }) });
            yield* keep(id, { ...current, home: made.id });
          }).pipe(Effect.catchTag("NoOwnSandbox", ({ why }) => Effect.logWarning(`@${id} has no sandbox of its own: ${why}`)));

        return {
          of,
          get,
          found,
          provide,
          adopt: (conversation, parent) =>
            Effect.gen(function* () {
              const owned = yield* ownedRow(parent);

              if (owned?.profile != null) return yield* own(conversation, owned.specialist, owned.profile);
              const { owner } = yield* of(parent);

              if (owner !== KY) yield* own(conversation, owner, null);
            }),
          pin: (conversation, profile) => Effect.asVoid(own(conversation, profile.owner, JSON.stringify(profile))),
          change: (id, change) => {
            if ("home" in change) return setHome(id, change.home);

            if ("tool" in change) return setTool(id, change.tool, change.policy);

            return change.grant ? grantMac(id, change.mac) : revokeMac(id, change.mac);
          },
          dropMac: (mac) =>
            Effect.gen(function* () {
              for (const { id } of yield* roster.list) {
                const current = yield* settings(id);

                if (current?.macs.includes(mac)) yield* keep(id, { ...current, macs: current.macs.filter((each) => each !== mac) });
              }
            }),
          migrate: Effect.gen(function* () {
            for (const row of yield* roster.list) {
              if ((yield* settings(row.id)) !== undefined) continue;
              yield* found(row.id, row.machine);
              yield* provide(row.id);
            }
          }),
          forget: (id) => Effect.asVoid(exec(`DELETE FROM ${PROFILES} WHERE specialist = ?`, id))
        };
      })
    );
}
