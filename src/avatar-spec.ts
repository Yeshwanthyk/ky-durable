import Type, { type Static } from "typebox";
import { decodeOr } from "./core/decode.ts";
import { must } from "./core/must.ts";

/**
 * A bloub: an avatar as a few choices from a fixed parts list, which ui/Bloub.tsx draws and animates.
 * A model fills one in; it never writes SVG, so nothing it says reaches the page as markup. Shared by
 * the server, which checks and stores specs, and the page, which draws them. No runtime imports
 * beyond typebox and the decoder, so both can load it.
 */

/** A colour as #rrggbb. */
const Hex = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });

/** What sits on top of the body. */
const TopKind = Type.Union([
  Type.Literal("none"),
  Type.Literal("antenna"),
  Type.Literal("leaf"),
  Type.Literal("ears"),
  Type.Literal("sprout"),
  Type.Literal("tuft")
]);

const TOPS = TopKind.anyOf.map((kind) => kind.const);

export const BloubSpecSchema = Type.Object({
  name: Type.Optional(Type.String({ maxLength: 24 })),
  body: Type.Object({ w: Type.Number(), h: Type.Number(), corner: Type.Number(), color: Hex }),
  eyes: Type.Object({ count: Type.Union([Type.Literal(1), Type.Literal(2)]), size: Type.Number() }),
  top: Type.Object({ kind: TopKind, color: Type.Optional(Hex) }),
  cheeks: Type.Boolean(),
  feet: Type.Boolean()
});

export type BloubSpec = Static<typeof BloubSpecSchema>;

/** The tool that previews, rolls and saves bloubs (avatars.ts). */
export const AVATAR_TOOL = "avatar";

/** Where an avatar tool result carries its specs, for the chat to draw them: a fenced block of this language. */
export const BLOUBS_FENCE = "bloubs";

/** Saved bloubs by who wears them: "ky", or a specialist's id. */
export type AvatarsView = Readonly<Record<string, BloubSpec>>;

/** Who an avatar is for: ky, or a specialist by id. */
export const KY_AVATAR = "ky";

const clamp = (value: number, low: number, high: number) => Math.round(Math.min(high, Math.max(low, value)));

/** The largest eye that fits the body: one big one, or two that leave room for cheeks. */
const maxEye = (w: number, count: 1 | 2) => (count === 1 ? Math.min(32, w / 2 - 14) : Math.min(18, (w / 2 - 8) / 2.55));

/** A spec that fits: sizes clamped into the ranges the renderer draws well, a corner no rounder than a circle. */
function fit(spec: BloubSpec): BloubSpec {
  const w = clamp(spec.body.w, 80, 124);
  const h = clamp(spec.body.h, 80, 124);
  const { count } = spec.eyes;

  const fitted: BloubSpec = {
    body: { w, h, corner: clamp(spec.body.corner, 0, Math.min(w, h) / 2), color: spec.body.color.toLowerCase() },
    eyes: { count, size: clamp(spec.eyes.size, 8, maxEye(w, count)) },
    top: spec.top.kind === "none" ? { kind: "none" } : { kind: spec.top.kind, color: (spec.top.color ?? spec.body.color).toLowerCase() },
    cheeks: spec.cheeks,
    feet: spec.feet
  };

  if (spec.name?.trim()) fitted.name = spec.name.trim();

  return fitted;
}

/**
 * `value` as a spec that draws well, or why it isn't one. Unknown parts and colours that aren't #rrggbb
 * are refused; sizes out of range are pulled in, not refused.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary: a tool's or a row's spec is checked here.
export function checkSpec(value: unknown): BloubSpec | { readonly refused: string } {
  const spec = decodeOr(BloubSpecSchema, value, undefined);

  if (!spec) {
    return {
      refused:
        `A spec is { name?, body: { w, h, corner, color: "#rrggbb" }, eyes: { count: 1 | 2, size }, ` +
        `top: { kind: ${TOPS.map((kind) => `"${kind}"`).join(" | ")}, color? }, cheeks: boolean, feet: boolean }.`
    };
  }

  return fit(spec);
}

/** Bright, friendly body colours, and the accents that sit well on top of them. */
const BODIES = ["#f0393c", "#3d8bff", "#f4ece0", "#8a5cf6", "#22b8a6", "#ff9f1c", "#ff6fa8", "#7bd389", "#ffd23f", "#5ec8f2", "#b48cff", "#ff7a59"];

const ACCENTS = ["#ffc93c", "#3cc46a", "#ff7ab8", "#7cc4ff", "#ffffff", "#ff5d5d", "#a0e548"];

/** A small seeded random source (mulberry32 over a hash of `seed`), so the same seed always rolls the same bloub. */
function random(seed: string): () => number {
  let state = 2166136261;

  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random bloub, the same one for the same seed: a specialist's look until one is chosen, and the options a roll offers. */
export function rollSpec(seed: string): BloubSpec {
  const next = random(seed);
  const pick = <Item>(items: readonly Item[]): Item => must(items[Math.floor(next() * items.length)], "a roll past the end");
  const between = (low: number, high: number) => low + next() * (high - low);
  const w = between(90, 120);
  const h = between(90, 118);
  const count = next() < 0.35 ? 1 : 2;
  const color = pick(BODIES);
  const kind = pick(TOPS);

  return fit({
    body: { w, h, corner: between(0.25, 0.5) * Math.min(w, h), color },
    eyes: { count, size: count === 1 ? between(22, 30) : between(11, 17) },
    top: kind === "ears" ? { kind, color } : { kind, color: pick(ACCENTS.filter((accent) => accent !== color)) },
    cheeks: next() < 0.75,
    feet: next() < 0.7
  });
}

/** Finished bloubs, for the make-avatar skill to show what good ones look like, and for tests. */
export const EXAMPLES = {
  squarey: { name: "Squarey", body: { w: 112, h: 104, corner: 30, color: "#f0393c" }, eyes: { count: 1, size: 30 }, top: { kind: "antenna", color: "#ffc93c" }, cheeks: true, feet: true },
  pip: { name: "Pip", body: { w: 108, h: 108, corner: 54, color: "#3d8bff" }, eyes: { count: 2, size: 15 }, top: { kind: "leaf", color: "#3cc46a" }, cheeks: true, feet: true },
  mochi: { name: "Mochi", body: { w: 118, h: 96, corner: 44, color: "#f4ece0" }, eyes: { count: 2, size: 12 }, top: { kind: "ears", color: "#f4ece0" }, cheeks: true, feet: false },
  tok: { name: "Tok", body: { w: 88, h: 120, corner: 30, color: "#8a5cf6" }, eyes: { count: 1, size: 24 }, top: { kind: "none" }, cheeks: false, feet: true },
  fern: { name: "Fern", body: { w: 112, h: 100, corner: 40, color: "#22b8a6" }, eyes: { count: 2, size: 16 }, top: { kind: "antenna", color: "#ff7ab8" }, cheeks: true, feet: true }
} as const satisfies Readonly<Record<string, BloubSpec>>;
