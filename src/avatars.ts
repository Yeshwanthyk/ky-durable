import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import Type, { type Static } from "typebox";
import { AVATAR_TOOL, type AvatarsView, BLOUBS_FENCE, type BloubSpec, BloubSpecSchema, checkSpec, KY_AVATAR, rollSpec } from "./avatar-spec";
import { decodeOr, parseOr } from "./core/decode";
import { toolReply as text } from "./core/reply";

/**
 * Avatars: a bloub (avatar-spec.ts) for ky or a specialist, kept in this object's SQLite. Who has none
 * looks as before: ky its blob, a specialist the bloub rolled from its id. The `avatar` tool previews,
 * rolls and saves them; the make-avatar skill (seeds.ts) is how a model makes a good one.
 */

const AVATAR_TABLE = "ky_avatars";

const AvatarRow = Type.Object({ owner: Type.String(), spec: Type.String() });

export class Avatars {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${AVATAR_TABLE} (owner TEXT PRIMARY KEY, spec TEXT NOT NULL)`);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** Every saved avatar by owner; a row a restore damaged is left out, so its owner looks as before. */
  all(): AvatarsView {
    const avatars: Record<string, BloubSpec> = {};

    for (const raw of this.#sql.exec(`SELECT owner, spec FROM ${AVATAR_TABLE} ORDER BY owner`).toArray()) {
      const row = decodeOr(AvatarRow, raw, undefined);
      const spec = row ? parseOr(BloubSpecSchema, row.spec, undefined) : undefined;

      if (row && spec) avatars[row.owner] = spec;
    }

    return avatars;
  }

  set(owner: string, spec: BloubSpec): void {
    this.#sql.exec(
      `INSERT INTO ${AVATAR_TABLE} (owner, spec) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET spec = excluded.spec`,
      owner,
      JSON.stringify(spec)
    );
    this.#emit();
  }

  /** Forget an owner's avatar; true if it had one. */
  clear(owner: string): boolean {
    const had = this.#sql.exec(`DELETE FROM ${AVATAR_TABLE} WHERE owner = ?`, owner).rowsWritten > 0;

    if (had) this.#emit();

    return had;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const AvatarInput = Type.Object({
  action: Type.Union([Type.Literal("preview"), Type.Literal("roll"), Type.Literal("set"), Type.Literal("clear"), Type.Literal("list")]),
  for: Type.Optional(Type.String({ description: `set, clear: "${KY_AVATAR}" or a specialist's id. Defaults to ${KY_AVATAR}.` })),
  spec: Type.Optional({ ...BloubSpecSchema, description: "set: the bloub to save." }),
  specs: Type.Optional(Type.Array(BloubSpecSchema, { maxItems: 6, description: "preview: up to six bloubs to show side by side." })),
  count: Type.Optional(Type.Number({ description: "roll: how many random bloubs to offer, 1 to 6; 3 by default." }))
});

type AvatarInput = Static<typeof AvatarInput>;

/** A reply that also shows `specs` in the chat, numbered so the user can pick one. */
const shown = (lead: string, specs: readonly BloubSpec[]) =>
  text(`${lead}\n\n\`\`\`${BLOUBS_FENCE}\n${JSON.stringify(specs)}\n\`\`\``);

/** Each spec checked, or the first refusal with its place in the list. */
function checkAll(specs: readonly BloubSpec[]): { readonly specs: BloubSpec[] } | { readonly refused: string } {
  const checked: BloubSpec[] = [];

  for (const [index, spec] of specs.entries()) {
    const result = checkSpec(spec);

    if ("refused" in result) return { refused: `Option ${index + 1}: ${result.refused}` };
    checked.push(result);
  }

  return { specs: checked };
}

/** The avatar tool. `owners` lists who may have one: ky and the specialists' ids. */
export function avatarTools(avatars: Avatars, owners: () => readonly string[]) {
  const ACTIONS = {
    preview: ({ specs, spec }) => {
      const checked = checkAll(specs ?? (spec ? [spec] : []));

      if ("refused" in checked) return text(checked.refused);

      if (checked.specs.length === 0) return text("preview needs specs.");

      return shown(`Showing ${checked.specs.length}. Ask which one, or what to change; then set it.`, checked.specs);
    },
    roll: ({ count }) => {
      const many = Math.min(6, Math.max(1, Math.round(count ?? 3)));
      const specs = Array.from({ length: many }, () => rollSpec(crypto.randomUUID()));

      return shown(`Rolled ${many}. Ask which one, or what to change; then set it.`, specs);
    },
    set: (input) => {
      const owner = input.for ?? KY_AVATAR;

      if (!owners().includes(owner)) return text(`No one is called ${owner}: use "${KY_AVATAR}" or a specialist's id.`);

      if (!input.spec) return text("set needs a spec.");
      const spec = checkSpec(input.spec);

      if ("refused" in spec) return text(spec.refused);
      avatars.set(owner, spec);

      return shown(`Saved as ${owner === KY_AVATAR ? "ky's" : `@${owner}'s`} avatar.`, [spec]);
    },
    clear: (input) => {
      const owner = input.for ?? KY_AVATAR;

      return text(avatars.clear(owner) ? `${owner} looks as before again.` : `${owner} has no avatar saved.`);
    },
    list: () => {
      const saved = Object.entries(avatars.all());

      return saved.length === 0 ? text("No avatars saved.") : shown(`Saved: ${saved.map(([owner]) => owner).join(", ")}.`, saved.map(([, spec]) => spec));
    }
  } satisfies { readonly [Action in AvatarInput["action"]]: (input: AvatarInput) => ReturnType<typeof text> };

  return defineExtension({
    name: "avatars",
    tools: [
      defineTool({
        name: AVATAR_TOOL,
        description:
          "Make and save avatars: bloubs, small animated characters drawn from a spec of parts, never SVG. " +
          "Actions: preview (specs: show up to six side by side); roll (count: random ones to pick from); " +
          `set (for: "${KY_AVATAR}" or a specialist's id; spec); clear (for); list. ` +
          "Read the make-avatar skill before designing one.",
        parameters: AvatarInput,
        replay: "unsafe",
        execute: async (input) => ACTIONS[input.action](input)
      })
    ]
  });
}
