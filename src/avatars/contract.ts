import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type from "typebox";
import type { Refusable } from "../core/edge";
import { must } from "../core/must";

export const AVATAR_TABLES = Object.freeze({ avatars: "ky_avatars", setup: "ky_setup" } as const);

export const AVATAR_TOOL = "avatar";

export const BLOUBS_FENCE = "bloubs";

export const KY_AVATAR = "ky";

const TOPS = ["none", "antenna", "leaf", "ears", "sprout", "tuft"] as const;

const HEX = "^#[0-9a-fA-F]{6}$";

const NAME_MAX = 24;

const graphemes = new Intl.Segmenter();

const Hex = Schema.String.check(Schema.isPattern(new RegExp(HEX)));

export const BloubSpec = Schema.Struct({
  name: Schema.optional(Schema.String.check(Schema.makeFilter((name: string) => [...graphemes.segment(name)].length <= NAME_MAX))),
  body: Schema.Struct({ w: Schema.Finite, h: Schema.Finite, corner: Schema.Finite, color: Hex }),
  eyes: Schema.Struct({ count: Schema.Literals([1, 2]), size: Schema.Finite }),
  top: Schema.Struct({ kind: Schema.Literals(TOPS), color: Schema.optional(Hex) }),
  cheeks: Schema.Boolean,
  feet: Schema.Boolean
});

export type BloubSpec = typeof BloubSpec.Type;

const TypeHex = Type.String({ pattern: HEX });

export const BloubSpecSchema = Type.Object({
  name: Type.Optional(Type.String({ maxLength: NAME_MAX })),
  body: Type.Object({ w: Type.Number(), h: Type.Number(), corner: Type.Number(), color: TypeHex }),
  eyes: Type.Object({ count: Type.Union([Type.Literal(1), Type.Literal(2)]), size: Type.Number() }),
  top: Type.Object({ kind: Type.Union(TOPS.map((kind) => Type.Literal(kind))), color: Type.Optional(TypeHex) }),
  cheeks: Type.Boolean(),
  feet: Type.Boolean()
});

export type AvatarsView = Readonly<Record<string, BloubSpec>>;

const WHAT_A_SPEC_IS =
  `A spec is { name?, body: { w, h, corner, color: "#rrggbb" }, eyes: { count: 1 | 2, size }, ` +
  `top: { kind: ${TOPS.map((kind) => `"${kind}"`).join(" | ")}, color? }, cheeks: boolean, feet: boolean }.`;

const clamp = (value: number, low: number, high: number) => Math.round(Math.min(high, Math.max(low, value)));

const maxEye = (w: number, count: 1 | 2) => (count === 1 ? Math.min(32, w / 2 - 14) : Math.min(18, (w / 2 - 8) / 2.55));

function fit(spec: BloubSpec): BloubSpec {
  const w = clamp(spec.body.w, 80, 124);
  const h = clamp(spec.body.h, 80, 124);
  const { count } = spec.eyes;
  const name = spec.name?.trim();

  const fitted: BloubSpec = {
    body: { w, h, corner: clamp(spec.body.corner, 0, Math.min(w, h) / 2), color: spec.body.color.toLowerCase() },
    eyes: { count, size: clamp(spec.eyes.size, 8, maxEye(w, count)) },
    top: spec.top.kind === "none" ? { kind: "none" } : { kind: spec.top.kind, color: (spec.top.color ?? spec.body.color).toLowerCase() },
    cheeks: spec.cheeks,
    feet: spec.feet
  };

  return name ? { ...fitted, name } : fitted;
}

export const fitSpec = flow(Schema.decodeUnknownOption(BloubSpec), Option.map(fit));

const BODIES = ["#f0393c", "#3d8bff", "#f4ece0", "#8a5cf6", "#22b8a6", "#ff9f1c", "#ff6fa8", "#7bd389", "#ffd23f", "#5ec8f2", "#b48cff", "#ff7a59"];

const ACCENTS = ["#ffc93c", "#3cc46a", "#ff7ab8", "#7cc4ff", "#ffffff", "#ff5d5d", "#a0e548"];

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

export const EXAMPLES = {
  squarey: { name: "Squarey", body: { w: 112, h: 104, corner: 30, color: "#f0393c" }, eyes: { count: 1, size: 30 }, top: { kind: "antenna", color: "#ffc93c" }, cheeks: true, feet: true },
  pip: { name: "Pip", body: { w: 108, h: 108, corner: 54, color: "#3d8bff" }, eyes: { count: 2, size: 15 }, top: { kind: "leaf", color: "#3cc46a" }, cheeks: true, feet: true },
  mochi: { name: "Mochi", body: { w: 118, h: 96, corner: 44, color: "#f4ece0" }, eyes: { count: 2, size: 12 }, top: { kind: "ears", color: "#f4ece0" }, cheeks: true, feet: false },
  tok: { name: "Tok", body: { w: 88, h: 120, corner: 30, color: "#8a5cf6" }, eyes: { count: 1, size: 24 }, top: { kind: "none" }, cheeks: false, feet: true },
  fern: { name: "Fern", body: { w: 112, h: 100, corner: 40, color: "#22b8a6" }, eyes: { count: 2, size: 16 }, top: { kind: "antenna", color: "#ff7ab8" }, cheeks: true, feet: true }
} as const satisfies Readonly<Record<string, BloubSpec>>;

export class NotASpec extends Schema.TaggedError<NotASpec>()("NotASpec", { option: Schema.optionalKey(Schema.Number) }) implements Refusable {
  get refusal(): string {
    return this.option === undefined ? WHAT_A_SPEC_IS : `Option ${this.option}: ${WHAT_A_SPEC_IS}`;
  }
}

export class SpecMissing extends Schema.TaggedError<SpecMissing>()("SpecMissing", { action: Schema.Literals(["preview", "set"]) }) implements Refusable {
  get refusal(): string {
    return this.action === "preview" ? "preview needs specs." : "set needs a spec.";
  }
}

export class NoOwner extends Schema.TaggedError<NoOwner>()("NoOwner", { owner: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No one is called ${this.owner}: use "${KY_AVATAR}" or a specialist's id.`;
  }
}

export type NotSetUp = { readonly id: string; readonly name: string; readonly needs: string };

export type SetupView = {
  readonly repo: string | null;
  readonly url: string | null;
  readonly missing: readonly NotSetUp[];
};

export type SelfEdit = { readonly repo: string; readonly url: string };

export class NotARepo extends Schema.TaggedError<NotARepo>()("NotARepo", { repo: Schema.String }) implements Refusable {
  get refusal(): string {
    return `"${this.repo}" is not a GitHub repo; write it as owner/name.`;
  }
}

export class PageUnknown extends Schema.TaggedError<PageUnknown>()("PageUnknown", {}) implements Refusable {
  get refusal(): string {
    return "This page's address is unknown; reload it and try again.";
  }
}
