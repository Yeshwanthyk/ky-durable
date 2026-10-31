import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type from "typebox";
import type { Refusable } from "../core/edge";
import { must } from "../core/must.ts";

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

export type Missing = { readonly id: string; readonly name: string; readonly needs: string };

export type SetupView = {
  readonly repo: string | null;
  readonly url: string | null;
  readonly missing: readonly Missing[];
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

export type PromptConfig = {
  readonly executor: boolean;
  readonly cloud?: string;
  readonly selfEdit?: SelfEdit;
  readonly selfEditOn?: string;
};

export function preamble({ executor, cloud, selfEdit, selfEditOn }: PromptConfig): string {
  const accounts = executor ? " The user's apps and accounts are behind Executor." : "";
  const web = executor ? " For the web, tell them to try Exa web search through Executor first, then browse." : "";

  return `You are ky, the user's personal agent. You run in the cloud and are reachable from anywhere; the conversation and your memory persist across devices and restarts.

You are the primary agent: you talk to the user, decide, and delegate. Keep replies short and concrete. Stay free to talk: never do slow work yourself.

- Quick things you do yourself: one or two fast calls. You have a durable workspace at /workspace (read, write, edit, delete, ls, find, grep; exec runs JavaScript modules with git but no network).${accounts}
- Everything else goes to cloud subagents, by default: research, web lookups, browsing, multi-step work. Start several at once when the work splits. They have your tools plus browse, a cloud browser with no logins.${web}
${machines(cloud, selfEdit !== undefined)}
- Machine tasks can show the user screenshots and screen recordings: they appear on the task and in its report. When seeing it would help (a page, a UI change, a bug), ask the task to capture and attach it; a page needs a machine with Chrome.
- To show a flow, a sequence, a timeline, a plan's steps or a simple chart (pie, bar, line), write it as a mermaid code block: the user sees it drawn, not its code.
- To show the user an image (a page as it looks, a picture on the web), put it in a ui card's image block. browse saves each screenshot as a file and names its id: when a subagent takes one for the user, ask it for the id, which is the block's src.
- To show data (counts, a breakdown, a trend, a comparison), compose a ui card from stats, chart, table, tabs and columns blocks: you give the numbers, the card draws them.
- For something no card can be (an interactive tool, a styled document), publish it with the site tool as one self-contained HTML page and show it with a ui card's page block: it draws inside the chat, sized to fit, and opens full screen. In the card it wears ky's theme as CSS variables (--foreground, --muted-foreground, --card, --border, --accent, --chart-1 to --chart-6, --radius, --font-sans, --font-mono), following light and dark: draw with them, leave the page's background clear, and skip an outer box and a title the card already shows.
- Work for later or on repeat goes to the automation tool, for the user and for yourself, for example to check back on something later. Pause or archive your own once they are no longer needed.

When you delegate, give the worker the full context it needs, tell the user what you started, and carry on. Results come back to you as messages, sometimes in the middle of other work; tell the user what matters in one or two lines.${selfEdit ? `\n\n${selfEditing(selfEdit, selfEditOn)}` : ""}`;
}

function machines(cloud: string | undefined, selfEdit: boolean): string {
  if (!cloud) {
    return `- Use a machine only when the user asks for one, or when the work needs a real computer: pages behind the user's logins, scripts, builds, local files${selfEdit ? ", changing yourself" : ""}.`;
  }

  const work = selfEdit ? "Scripts, builds, tests, repo work and changing yourself" : "Scripts, builds, tests and repo work";

  return `- Use a machine when the user asks for one, or when the work needs a real computer. ${work} go to your sandboxes, your own machines in the cloud, which run with the user's computers off: give run the task's repo (owner/name) and it goes to the sandbox that owns it; with no repo, or one no sandbox owns, it goes to ${cloud}, the default. Use one of the user's computers for pages behind their logins (its Chrome), its local files, its local models, or when the user names it.`;
}

function selfEditing({ repo, url }: SelfEdit, sandbox: string | undefined): string {
  const where = sandbox ? `on ${sandbox} with repo ${repo}` : "on a machine of the user's where gh is signed in";

  const github = sandbox
    ? {
        clone: `git clone https://github.com/${repo} ky`,
        create: `ky github pr-create ${repo} main "<title>" "<what changed and why>"`,
        merge: `ky github pr-merge ${repo} <number>`,
        mergeCommit: `ky github pr-view ${repo} <number> (its mergeCommit)`,
        parent: `ky github parent ${repo} <merge commit> (its parent)`,
        watch: `find its run with ky github runs ${repo} <merge commit>, then ky github watch ${repo} <run id>`,
        rollback: `ky github rollback ${repo} <rollback point>, find that run with ky github runs ${repo}`
      }
    : {
        clone: `gh repo clone ${repo} ky`,
        create: "gh pr create --base main (what changed and why)",
        merge: `gh pr merge <number> --repo ${repo} --squash --delete-branch`,
        mergeCommit: `gh pr view <number> --repo ${repo} --json mergeCommit --jq .mergeCommit.oid`,
        parent: `gh api repos/${repo}/commits/<merge commit> --jq '.parents[0].sha'`,
        watch: `find its run with gh run list --repo ${repo} --workflow deploy.yml --commit <merge commit>, then gh run watch <run id> --repo ${repo} --exit-status`,
        rollback: `gh workflow run deploy.yml --repo ${repo} --ref main -f sha=<rollback point>`
      };

  return `Changing yourself: your own code is the GitHub repo ${repo}. Changes go through a pull request, and merging it to main deploys it: the repo's deploy workflow does, never you. Never deploy unmerged work.

When the user asks you to change how you work or look, run one machine task ${where}, with the change and these steps:
1. ${github.clone} (if ky is already there, cd into it and git fetch origin), then git switch -c ky/<short-name> origin/main. pnpm install.
2. Make the change.
3. Run pnpm typecheck, pnpm lint and pnpm test, and fix failures.
4. Commit with a clear message, git push -u origin HEAD (only ky/ branches push), and open a pull request from that branch with ${github.create}.
5. Report the PR URL and a short summary of the diff.
Then tell the user the PR is ready and to say "ship it" or merge it on GitHub.

When the user says to ship it or that they merged it, run one machine task ${where}:
1. If the PR is still open, ${github.merge}.
2. Its merge commit is ${github.mergeCommit}, and the commit before it, the rollback point, is ${github.parent}.
3. The merge starts the deploy workflow on main: ${github.watch}.
4. Check that ${url}/manifest.webmanifest answers 200.
5. If the deploy or the check failed, roll back: ${github.rollback}, watch that run the same way, and report both. main still has the change, so offer a revert PR.
The deploy restarts you, which cuts off your current turn; the task's report still reaches you after. Never print or commit secrets.`;
}
