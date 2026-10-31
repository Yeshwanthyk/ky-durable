import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";
import { NoSandbox } from "../runners/contract";
import { type AccessChange, KY, type Machinery, type Profile, ProfileStored, SKILL_TABLES, type SpecialistDraft, SpecialistSession, type SpecialistRow } from "./contract";
import { storage } from "./skills";
import { NoSpecialist, Roster } from "./specialists";

/**
 * Profiles: what each owner may use. ky's is what ky always had: the default sandbox and every paired
 * Mac. A specialist's is its own sandbox, made with it, and the Macs the user lets it use. Only the user
 * changes one (Settings, or a card they answer), and every scoped tool reads it through `of`.
 *
 * A specialist made before profiles has no row: its profile follows from its machine hint until the user
 * first changes it. A sandbox it names is its home; a Mac it names is its one Mac, beside the default sandbox.
 */

class NotAMac extends Schema.TaggedError<NotAMac>()("NotAMac", { mac: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.mac} isn't one of your paired Macs.`;
  }
}

type Settings = { readonly home: string | null; readonly macs: readonly string[]; readonly tools: Profile["tools"] };

/** A damaged row grants nothing. */
const NOTHING: Settings = { home: null, macs: [], tools: {} };

const asStored = Schema.decodeUnknownOption(ProfileStored);

export class Machines extends Context.Service<Machines, Machinery>()("ky/skills/Machines") {}

interface SpecialistProfiles {
  /** The profile of whoever answers in `conversation`, as it is now. */
  readonly of: (conversation: string) => Effect.Effect<Profile>;
  /** `owner`'s profile, as it is now: "ky", or a specialist's id. One that is gone has nothing. */
  readonly get: (owner: string) => Effect.Effect<Profile>;
  /** A new specialist's own sandbox, and the Mac the user named; why it has no sandbox, if it couldn't get one. */
  readonly open: (id: string, mac: string | null) => Effect.Effect<string | undefined>;
  /** The user grants or revokes a Mac, or moves the specialist to another sandbox. */
  readonly change: (id: string, change: AccessChange) => Effect.Effect<string, NoSpecialist | NotAMac | NoSandbox>;
  readonly forget: (id: string) => Effect.Effect<void>;
}

export class Profiles extends Context.Service<Profiles, SpecialistProfiles>()("ky/skills/Profiles") {
  /** Needs Sql, the Roster and the Machines; makes its table. */
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

        const sandbox = (find: (each: ReturnType<Machinery["sandboxes"]>[number]) => boolean) => {
          const found = machines.sandboxes().find(find);

          return found ? { id: found.id, name: found.name } : null;
        };

        const kyProfile = (): Profile => ({ owner: KY, home: sandbox((each) => each.isDefault), macs: [...machines.macs()], tools: {} });

        const fromHint = (row: SpecialistRow): Settings => {
          const named = row.machine === null ? null : sandbox((each) => each.name === row.machine);

          if (named) return { home: named.id, macs: [], tools: {} };

          return { home: sandbox((each) => each.isDefault)?.id ?? null, macs: row.machine === null ? [] : [row.machine], tools: {} };
        };

        const settings = (row: SpecialistRow) =>
          Effect.map(exec(`SELECT home, macs, tools FROM ${SKILL_TABLES.specialistProfiles} WHERE specialist = ?`, row.id), ([stored]) =>
            stored === undefined ? fromHint(row) : Option.getOrElse(asStored(stored), () => NOTHING)
          );

        const keep = (id: string, next: Settings) =>
          Effect.gen(function* () {
            yield* exec(
              `INSERT INTO ${SKILL_TABLES.specialistProfiles} (specialist, home, macs, tools) VALUES (?, ?, ?, ?)
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
            if (owner === KY) return kyProfile();
            const row = yield* roster.get(owner);

            if (row === undefined) return { owner, home: null, macs: [], tools: {} } satisfies Profile;
            const { home, macs, tools } = yield* settings(row);

            return { owner, home: home === null ? null : sandbox((each) => each.id === home), macs: [...macs], tools: { ...tools } } satisfies Profile;
          });

        /** Change the specialist `id`'s settings; refused for one that isn't. */
        const edit = (id: string, next: (current: Settings) => Settings) =>
          Effect.gen(function* () {
            const row = yield* roster.get(id);

            if (row === undefined) return yield* Effect.fail(new NoSpecialist({ id }));
            yield* keep(id, next(yield* settings(row)));
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
            const found = sandbox((each) => each.id === home);

            if (found === null) return yield* Effect.fail(new NoSandbox({ id: home }));
            yield* edit(id, (current) => ({ ...current, home }));

            return `@${id} works on ${found.name}.`;
          });

        return {
          of: (conversation) =>
            Effect.flatMap(rows(SpecialistSession, `SELECT specialist, kind FROM ${SKILL_TABLES.specialistSessions} WHERE session = ?`, conversation), ([found]) =>
              get(found?.specialist ?? KY)
            ),
          get,
          open: (id, mac) =>
            Effect.try({ try: () => machines.open(id), catch: (cause) => (cause instanceof Error ? cause.message : String(cause)) }).pipe(
              Effect.match({ onSuccess: (made) => ({ home: made.id, why: undefined }), onFailure: (why) => ({ home: null, why }) }),
              Effect.tap(({ home }) => keep(id, { home, macs: mac !== null && machines.macs().includes(mac) ? [mac] : [], tools: {} })),
              Effect.map(({ why }) => why)
            ),
          change: (id, change) => ("home" in change ? setHome(id, change.home) : change.grant ? grantMac(id, change.mac) : revokeMac(id, change.mac)),
          forget: (id) => Effect.asVoid(exec(`DELETE FROM ${SKILL_TABLES.specialistProfiles} WHERE specialist = ?`, id))
        };
      })
    );
}

/** A new specialist, with its own sandbox (asleep until used) and, when the user made it, the Mac they named. */
export const createSpecialist = (id: string, draft: SpecialistDraft, actor: string, conversation: string | null) =>
  Effect.gen(function* () {
    const created = yield* Roster.use((roster) => roster.create(id, draft, actor, conversation));
    const why = yield* Profiles.use((profiles) => profiles.open(id, actor === "user" ? (draft.machine ?? null) : null));

    if (why !== undefined) yield* Effect.logWarning(`@${id} has no sandbox of its own: ${why}`);

    return created;
  });

/** Deleting a specialist goes through here: today its row and its grants; its sandbox and conversations stay. */
export const deleteSpecialist = (id: string) =>
  Effect.gen(function* () {
    const deleted = yield* Roster.use((roster) => roster.remove(id));
    yield* Profiles.use((profiles) => profiles.forget(id));

    return deleted;
  });
