import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import fc from "fast-check";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { Sql } from "../../src/core/sql";
import { Anticipating, Anticipations, type Call } from "../../src/dreaming/anticipations";
import { DreamNotes, DreamRuns } from "../../src/dreaming/dreaming";
import { Presence, PresenceStore } from "../../src/dreaming/presence";
import { Proactivity } from "../../src/dreaming/proactivity";
import { Verdicts } from "../../src/dreaming/verdicts";
import { Surfaced, SurfacedStore } from "../../src/dreaming/surfaced";
import { budget } from "../parity/kit";
import {
  aChange,
  actorOf,
  advances,
  aGoodAdd,
  anticipatingFor,
  anArgs,
  aSession,
  CHATS,
  DAY,
  dreamOf,
  enter,
  here,
  HOUR,
  type Here,
  isDream,
  json,
  listOnly,
  MEMORIES,
  passOf,
  type Role,
  SEED,
  START,
  storageFor,
  TERMS,
  TEXTS
} from "../parity/anticipations/world";

const runs = () => ({ numRuns: budget().numRuns, seed: budget().seed });

const rowsOf = (db: DatabaseSync, query: string, ...bindings: SQLInputValue[]) => json(db.prepare(query).all(...bindings));

const layerOf = <A, E>(world: Here, layer: Layer.Layer<A, E, Sql>) => Layer.mergeAll(layer, TestClock.layer()).pipe(Layer.provide(Sql.layer(storageFor(world.db))));

type Out = { readonly answer: unknown } | { readonly refused: string };

const outOf = <A, E extends { readonly refusal: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, { onFailure: (error): Out => ({ refused: error.refusal }), onSuccess: (answer): Out => ({ answer: json(answer) }) });

const no = (refused: string): Out => ({ refused });

const yes = <A>(answer: A): Out => ({ answer: json(answer) });

const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const bytes = (text: string) => new TextEncoder().encode(text).length;

const KINDS = ["open_loop", "upcoming", "predicted_ask", "watch"];

const TERMINAL = ["done", "dismissed", "expired"];

type Entry = { readonly id: number; readonly conversation: number; readonly role: Role };

type Row = {
  id: number;
  created_at: number;
  created_by: string;
  kind: string;
  text: string;
  evidence: string;
  prepared: string | null;
  window_from: number | null;
  window_to: number | null;
  status: string;
  pinned: number;
  absorbed_into: number | null;
  closed_at: number | null;
  recalled_at: number | null;
};

type Model = { now: number; entries: Entry[]; rows: Row[]; memories: string[]; closed: number };

type Args = {
  readonly action: string;
  readonly id?: number;
  readonly kind?: string;
  readonly text?: string;
  readonly messages?: readonly number[];
  readonly memories?: readonly number[];
  readonly prepared?: string;
  readonly from?: string;
  readonly to?: string;
  readonly outcome?: string;
  readonly note?: string;
  readonly into?: number;
  readonly about?: string;
  readonly hours?: number;
};

const evidenceOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Schema.Number), memories: Schema.Array(Schema.Number) })));

const looksOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const unique = <T>(values: readonly T[]) => [...new Set(values)];

const live = (row: Row) => row.status === "open" || row.status === "surfaced";

const askers = (model: Model, conversation: number) => model.entries.filter((entry) => entry.conversation === conversation && entry.role !== "ky").sort((a, b) => b.id - a.id);

const latestAsk = (model: Model, conversation: number) =>
  askers(model, conversation)
    .slice(0, 20)
    .find((entry) => entry.role === "user")?.id;

const startedByUser = (model: Model, conversation: number) => askers(model, conversation)[0]?.role === "user";

const cited = (ids: readonly number[]) => ids.map((id) => `#${id}`).join(", ");

const line = (row: Row, now: number) => {
  const days = Math.max(0, Math.floor((now - row.created_at) / DAY));
  const age = days === 0 ? "today" : days === 1 ? "1 day old" : `${days} days old`;
  const window = row.window_from === null || row.window_to === null ? "" : `, ${isoOf(row.window_from)} to ${isoOf(row.window_to)}`;
  const { messages, memories } = evidenceOf(row.evidence);
  const rests = [...messages.map((id) => `message #${id}`), ...memories.map((id) => `memory #${id}`)].join(", ");

  return `- #${row.id} ${row.kind}, ${row.status}, ${age}, by ${row.created_by}${row.pinned === 1 ? ", pinned" : ""}${window}: ${row.text} (rests on ${rests})`;
};

const listed = (rows: readonly Row[], now: number) => (rows.length === 0 ? "None open." : rows.map((row) => line(row, now)).join("\n"));

const windowed = (row: Row, now: number) => row.window_from !== null && row.window_to !== null && row.window_from <= now && row.window_to >= now;

const rank = (row: Row, now: number) => (row.window_from === null ? 0 : windowed(row, now) ? 2 : 1);

function matching(model: Model, terms: readonly string[], limit: number, before: number): Row[] {
  const words = unique(terms.flatMap((term) => (term.trim().length >= 3 ? [term.trim().toLowerCase()] : []))).slice(0, 12);
  const hit = (row: Row) => words.some((word) => row.text.toLowerCase().includes(word) || (row.prepared ?? "").toLowerCase().includes(word));

  return model.rows
    .filter((row) => live(row) && ((windowed(row, model.now) && (row.recalled_at === null || row.recalled_at < before)) || hit(row)))
    .sort((a, b) => rank(b, model.now) - rank(a, model.now) || b.id - a.id)
    .slice(0, limit);
}

const due = (model: Model, until: number) =>
  model.rows
    .filter((row) => live(row) && row.kind === "upcoming" && row.window_from !== null && row.window_to !== null && row.window_from <= until && row.window_to >= model.now)
    .sort((a, b) => (a.window_from ?? 0) - (b.window_from ?? 0) || a.id - b.id);

type Window = { readonly from: number; readonly to: number } | undefined;

function windowOf(from: string | undefined, to: string | undefined, now: number): { readonly window: Window } | { readonly refused: string } {
  if (to === undefined) return from === undefined ? { window: undefined } : { refused: "A window needs a to." };
  const date = (value: string, what: string) => (Number.isNaN(Date.parse(value)) ? `${what} "${value}" is not a date; write it like 2026-10-17T08:00:00+02:00.` : undefined);
  const bad = (from === undefined ? undefined : date(from, "from")) ?? date(to, "to");

  if (bad !== undefined) return { refused: bad };

  return { window: { from: from === undefined ? now : Date.parse(from), to: Date.parse(to) } };
}

type Draft = { readonly kind: string; readonly text: string; readonly messages: readonly number[]; readonly memories: readonly number[]; readonly prepared?: string; readonly window: Window };

const PASS = { parent: 1, after: 2, upto: 12 };

type Adding = {
  readonly model: Model;
  readonly draft: Draft;
  readonly by: string;
  readonly pass: boolean;
  readonly text: string;
  readonly prepared: string | null;
  readonly messages: readonly number[];
  readonly memories: readonly number[];
};

type Rule<C> = readonly [(context: C) => boolean, (context: C) => string];

const entryOf = (model: Model, id: number) => model.entries.find((each) => each.id === id);

const absentOf = ({ model, messages, memories }: Adding) => [
  ...messages.filter((id) => !entryOf(model, id)).map((id) => `message #${id}`),
  ...memories.filter((id) => id < 0 || id >= model.memories.length).map((id) => `memory #${id}`)
];

const elsewhereOf = ({ model, messages }: Adding) => messages.filter((id) => !CHATS.has(String(entryOf(model, id)?.conversation)));

const noticesOf = ({ model, messages }: Adding) => messages.filter((id) => entryOf(model, id)?.role === "notice");

const outsideOf = ({ model, messages }: Adding) =>
  messages.filter((id) => id <= PASS.after || id > PASS.upto || entryOf(model, id)?.role !== "user" || entryOf(model, id)?.conversation !== PASS.parent);

const inStretch = (model: Model, id: number) => id > PASS.after && id <= PASS.upto && entryOf(model, id)?.conversation === PASS.parent;

const episodeAdded = (model: Model) => model.rows.filter((row) => row.created_by === "episode" && evidenceOf(row.evidence).messages.some((id) => inStretch(model, id))).length;

const dreamAdded = (model: Model) => model.rows.filter((row) => row.created_by === "dream" && row.created_at > model.now - 12 * HOUR).length;

const notDates = ({ window }: Draft) => window !== undefined && (!Number.isFinite(window.from) || !Number.isFinite(window.to));

const ADD_RULES: readonly Rule<Adding>[] = [
  [({ draft }) => !KINDS.includes(draft.kind), ({ draft }) => `No kind ${draft.kind}: one of open_loop, upcoming, predicted_ask, watch.`],
  [({ prepared }) => prepared !== null && prepared.length > 1500, ({ prepared }) => `prepared is ${prepared?.length} characters, limit 1500.`],
  [({ draft }) => notDates(draft), () => "A window needs a from and a to that are dates."],
  [({ draft }) => draft.window !== undefined && draft.window.to < draft.window.from, () => "A window's to is before its from."],
  [({ draft }) => draft.kind === "upcoming" && draft.window === undefined, () => "An upcoming one needs a window: from and to."],
  [({ text }) => text === "", () => "Empty. An anticipation is one line of text."],
  [({ text }) => /[\r\n]/.test(text), () => "An anticipation is one line."],
  [({ text }) => bytes(text) > 280, ({ text }) => `Too long: ${bytes(text)} bytes, limit 280.`],
  [({ messages, memories }) => messages.length + memories.length === 0, () => "No evidence: cite the chat messages (#rowid) or memories (#id) it rests on."],
  [(context) => absentOf(context).length > 0, (context) => `No such ${absentOf(context).join(", ")}: cite only what is there.`],
  [
    (context) => elsewhereOf(context).length > 0,
    (context) => `Message ${cited(elsewhereOf(context))} is not from a chat (a dream, a subagent or a task said it): cite what the user and ky said in a chat.`
  ],
  [
    (context) => noticesOf(context).length > 0,
    (context) => `Message ${cited(noticesOf(context))} is a notice ky relayed (mail, a peer, a report), not the user's words: cite what the user and ky said.`
  ],
  [({ by, pass }) => by === "episode" && !pass, () => "Only an episode reflection's own fork adds as an episode."],
  [({ by, messages }) => by === "episode" && messages.length === 0, () => "Cite the user's own messages (#id) it rests on."],
  [
    (context) => context.by === "episode" && outsideOf(context).length > 0,
    (context) => `Message ${cited(outsideOf(context))} is not the user's own words in the stretch you read: cite only the user's lines above.`
  ],
  [({ by, model }) => by === "episode" && episodeAdded(model) >= 3, () => "An episode reflection adds at most 3; this one has."],
  [({ by, model }) => by !== "user" && model.rows.filter(live).length >= 20, () => "20 are open already: close or absorb one first."],
  [({ by, model }) => by === "dream" && dreamAdded(model) >= 5, () => "A dream adds at most 5; this one has."]
];

function add(model: Model, draft: Draft, by: string, pass: boolean): Out {
  const context: Adding = { model, draft, by, pass, text: draft.text.trim(), prepared: draft.prepared?.trim() || null, messages: unique(draft.messages), memories: unique(draft.memories) };
  const broken = ADD_RULES.find(([breaks]) => breaks(context));

  if (broken !== undefined) return no(broken[1](context));
  const id = model.rows.length + 1;

  model.rows.push({
    id,
    created_at: model.now,
    created_by: by,
    kind: draft.kind,
    text: context.text,
    evidence: JSON.stringify({ messages: context.messages, memories: context.memories }),
    prepared: context.prepared,
    window_from: draft.window?.from ?? null,
    window_to: draft.window?.to ?? null,
    status: "open",
    pinned: 0,
    absorbed_into: null,
    closed_at: null,
    recalled_at: null
  });

  return yes(id);
}

function changeable(model: Model, id: number, by: string): Row | { readonly refused: string } {
  const row = model.rows.find((each) => each.id === id);

  if (row === undefined) return { refused: `No anticipation #${id}.` };

  if (by === "episode") return { refused: "An episode reflection only adds and lists; the dream and the user close, extend and absorb." };

  if (by !== "user" && row.created_by === "user") return { refused: `#${id} is the user's; only they change it.` };

  if (by !== "user" && row.pinned === 1) return { refused: `#${id} is pinned; only the user changes it.` };

  return row;
}

function close(model: Model, row: Row, to: string, into: number | null) {
  row.status = to;
  row.closed_at = model.now;
  row.absorbed_into = into;
  model.closed++;
}

const USER_ACTS = ["add", "close", "extend", "absorb", "pin", "unpin"];

type Acting = { readonly model: Model; readonly by: string; readonly session: string; readonly args: Args };

const needs = (what: string) => no(`This action needs ${what}.`);

function addDraft({ model, by, session, args }: Acting, kind: string, text: string, window: Window): Out {
  const asked = by === "user" ? latestAsk(model, Number(session)) : undefined;
  const messages = [...(args.messages ?? []), ...(asked === undefined ? [] : [asked])];
  const saved = add(model, { kind, text, messages, memories: args.memories ?? [], prepared: args.prepared, window }, by, by === "episode");

  return "refused" in saved ? saved : { answer: `Saved as #${String(saved.answer)}.` };
}

function adding(acting: Acting): Out {
  const { args, model } = acting;

  if (args.kind === undefined) return needs("kind");

  if (args.text === undefined) return needs("text");
  const window = windowOf(args.from, args.to, model.now);

  return "refused" in window ? window : addDraft(acting, args.kind, args.text, window.window);
}

const cannotBecome = (row: Row, outcome: string) => row.status !== "open" && !(row.status === "surfaced" && TERMINAL.includes(outcome));

const doneNote = (row: Row, note: string | undefined) => note?.trim() || (bytes(`Done: ${row.text}`) <= 280 ? `Done: ${row.text}` : row.text);

function closeRow({ model, by, args }: Acting, id: number, outcome: string): Out {
  const row = changeable(model, id, by);

  if ("refused" in row) return row;

  if (cannotBecome(row, outcome)) return no(`#${row.id} is ${row.status}; it cannot become ${outcome}.`);

  if (outcome === "done") model.memories.push(doneNote(row, args.note));
  close(model, row, outcome, null);

  return { answer: `#${row.id} is ${outcome}${outcome === "done" ? "; its outcome is a memory now" : ""}.` };
}

function closing(acting: Acting): Out {
  const { args } = acting;

  if (args.id === undefined) return needs("id");

  return args.outcome === undefined ? needs("outcome") : closeRow(acting, args.id, args.outcome);
}

function extendRow({ model, by }: Acting, id: number, window: { readonly from: number; readonly to: number }): Out {
  const row = changeable(model, id, by);

  if ("refused" in row) return row;

  if (TERMINAL.includes(row.status)) return no(`#${row.id} is ${row.status}; only an open one moves.`);

  if (window.to < window.from) return no("A window's to is before its from.");
  row.window_from = window.from;
  row.window_to = window.to;

  return { answer: `#${row.id} now matters from ${isoOf(window.from)} to ${isoOf(window.to)}.` };
}

function extending(acting: Acting): Out {
  const { args, model } = acting;

  if (args.id === undefined) return needs("id");
  const window = windowOf(args.from, args.to, model.now);

  if ("refused" in window) return window;

  return window.window === undefined ? needs("to") : extendRow(acting, args.id, window.window);
}

function absorbRow({ model, by }: Acting, id: number, into: number): Out {
  const row = changeable(model, id, by);

  if ("refused" in row) return row;
  const target = model.rows.find((each) => each.id === into);

  if (target === undefined) return no(`No anticipation #${into}.`);

  if (target.id === row.id || TERMINAL.includes(target.status)) return no(`#${into} is not another open anticipation.`);

  if (TERMINAL.includes(row.status)) return no(`#${row.id} is ${row.status}; it cannot become dismissed.`);
  close(model, row, "dismissed", target.id);

  return { answer: `#${row.id} is folded into #${target.id}.` };
}

function absorbing(acting: Acting): Out {
  const { args } = acting;

  if (args.id === undefined) return needs("id");

  return args.into === undefined ? needs("into") : absorbRow(acting, args.id, args.into);
}

function pinRow(model: Model, id: number, pinned: boolean): Out {
  const row = model.rows.find((each) => each.id === id);

  if (row === undefined) return no(`No anticipation #${id}.`);
  row.pinned = pinned ? 1 : 0;

  return { answer: pinned ? `#${row.id} is pinned: it never expires, and only the user changes it.` : `#${row.id} is unpinned.` };
}

function pinning({ model, by, args }: Acting): Out {
  if (by !== "user") return no("Only the user pins.");

  return args.id === undefined ? needs("id") : pinRow(model, args.id, args.action === "pin");
}

function listing({ model, args }: Acting): Out {
  if (args.about !== undefined) return { answer: listed(matching(model, args.about.split(/[^\p{L}\p{N}_]+/u), 5, Number.MAX_SAFE_INTEGER), model.now) };

  if (args.hours !== undefined) return { answer: listed(due(model, model.now + args.hours * HOUR), model.now) };

  return { answer: listed(model.rows.filter(live), model.now) };
}

const ACTS = new Map([
  ["add", adding],
  ["close", closing],
  ["extend", extending],
  ["absorb", absorbing],
  ["pin", pinning],
  ["unpin", pinning]
]);

function act(model: Model, session: string, args: Args): Out {
  const by = actorOf(session);

  if (args.action !== "list" && listOnly(session)) return no("A look may only list anticipations.");

  if (by === "user" && USER_ACTS.includes(args.action) && !startedByUser(model, Number(session))) {
    return no("This turn was started by a notice, not the user: ask the user before changing anticipations.");
  }

  return (ACTS.get(args.action) ?? listing)({ model, by, session, args });
}

function expire(model: Model): number {
  const expired = model.rows.filter((row) => row.status === "open" && row.pinned === 0 && row.window_to !== null && row.window_to < model.now);

  for (const row of expired) {
    row.status = "expired";
    row.closed_at = model.now;
  }

  if (expired.length > 0) model.closed++;

  return expired.length;
}

type Step =
  | { readonly kind: "tool"; readonly session: string; readonly args: Args }
  | { readonly kind: "fill"; readonly count: number; readonly window: boolean }
  | { readonly kind: "burst"; readonly session: string; readonly count: number }
  | { readonly kind: "say"; readonly conversation: number; readonly role: Role }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "expire" }
  | { readonly kind: "match"; readonly terms: readonly string[]; readonly limit: number }
  | { readonly kind: "recallable"; readonly terms: readonly string[]; readonly limit: number }
  | { readonly kind: "recalled"; readonly ids: readonly number[] }
  | { readonly kind: "due"; readonly hours: number }
  | { readonly kind: "plant"; readonly hours: number }
  | { readonly kind: "newest"; readonly session: string; readonly args: Args }
  | { readonly kind: "recallNewest" };

const aTerms = fc.subarray(TERMS, { minLength: 1, maxLength: 3 });

const FILLERS = Array.from({ length: 12 }, (_, at) => `f${String(at).padStart(2, "0")}`);

const manyTerms = fc.tuple(fc.integer({ min: 10, max: 12 }), fc.constantFrom("lease", "tea", "dentist")).map(([count, hit]) => [...FILLERS.slice(0, count), hit]);

const aReach = fc.record({
  action: fc.constantFrom("pin", "close", "extend", "absorb"),
  id: fc.integer({ min: 1, max: 8 }),
  outcome: fc.constantFrom("done", "dismissed"),
  to: fc.integer({ min: 1, max: 96 }).map((hours) => new Date(START + hours * HOUR).toISOString()),
  into: fc.integer({ min: 1, max: 8 })
});

const aCite = fc.record({
  action: fc.constant("add"),
  kind: fc.constantFrom("open_loop", "predicted_ask", "watch"),
  text: fc.constantFrom(...TEXTS),
  messages: fc.subarray([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 99], { maxLength: 3 }),
  memories: fc.subarray([0, 1, 7], { maxLength: 2 })
});

const aStep: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("tool" as const), session: aSession, args: anArgs }), weight: 8 },
  { arbitrary: fc.record({ kind: fc.constant("tool" as const), session: fc.constantFrom("1", "5", "7"), args: aGoodAdd }), weight: 6 },
  { arbitrary: fc.record({ kind: fc.constant("tool" as const), session: fc.constantFrom("1", "1", "5", "7"), args: aChange }), weight: 5 },
  { arbitrary: fc.record({ kind: fc.constant("fill" as const), count: fc.integer({ min: 5, max: 21 }), window: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("tool" as const), session: fc.constantFrom("1", "2", "5", "7"), args: aCite }), weight: 5 },
  { arbitrary: fc.record({ kind: fc.constant("tool" as const), session: fc.constantFrom("1", "7"), args: aReach }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("burst" as const), session: fc.constantFrom("5", "7"), count: fc.integer({ min: 1, max: 7 }) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("say" as const), conversation: fc.constantFrom(1, 2, 7), role: fc.constantFrom<Role>("user", "user", "notice", "ky") }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("wait" as const), ms: advances }), weight: 3 },
  fc.constant({ kind: "expire" as const }),
  fc.record({ kind: fc.constant("match" as const), terms: fc.oneof(aTerms, manyTerms), limit: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ kind: fc.constant("recallable" as const), terms: aTerms, limit: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ kind: fc.constant("recalled" as const), ids: fc.subarray([1, 2, 3, 4, 5, 6], { maxLength: 3 }) }),
  fc.record({ kind: fc.constant("due" as const), hours: fc.integer({ min: 1, max: 72 }) })
);

const USER_TURN: Step = { kind: "say", conversation: 1, role: "user" };

const DREAM_ADD: Step = { kind: "tool", session: "7", args: { action: "add", kind: "watch", text: "tea with Ana", messages: [5] } };

const aDreamChange = fc.tuple(aChange, fc.constantFrom("close", "extend", "absorb")).map(([args, action]) => ({ ...args, action }));

const aRun: fc.Arbitrary<readonly Step[]> = fc.oneof(
  { arbitrary: aStep.map((step) => [step]), weight: 12 },
  fc.integer({ min: 1, max: 48 }).map((hours): Step[] => [USER_TURN, { kind: "plant", hours }, { kind: "wait", ms: hours * HOUR }, { kind: "expire" }]),
  fc
    .integer({ min: 12 * HOUR, max: DAY })
    .map((ms): Step[] => [USER_TURN, { kind: "plant", hours: 48 }, { kind: "recallNewest" }, { kind: "wait", ms }, { kind: "recallable", terms: ["zz"], limit: 6 }]),
  fc
    .tuple(aGoodAdd, aDreamChange)
    .map(([args, change]): Step[] => [USER_TURN, { kind: "tool", session: "7", args }, { kind: "newest", session: "1", args: { action: "pin" } }, { kind: "newest", session: "7", args: change }]),
  fc.integer({ min: 1, max: 6 }).map((limit): Step[] => [DREAM_ADD, { kind: "match", terms: [...FILLERS.slice(0, 11), "tea"], limit }]),
  fc.subarray([1, 5, 10], { minLength: 1 }).map((messages): Step[] => [{ kind: "tool", session: "1", args: { action: "add", kind: "watch", text: "tea with Ana", messages } }]),
  fc.subarray([0, 1], { minLength: 1 }).map((memories): Step[] => [{ kind: "tool", session: "5", args: { action: "add", kind: "watch", text: "tea with Ana", memories } }]),
  fc
    .tuple(fc.constantFrom("done", "dismissed"), fc.integer({ min: 1, max: 96 }))
    .map(([outcome, hours]): Step[] => [
      USER_TURN,
      { kind: "tool", session: "1", args: { action: "add", kind: "watch", text: "tea with Ana", messages: [1] } },
      { kind: "newest", session: "1", args: { action: "close", outcome } },
      { kind: "newest", session: "1", args: { action: "extend", to: new Date(START + hours * HOUR).toISOString() } }
    ]),
  fc.integer({ min: HOUR, max: 2.5 * HOUR }).map((ms): Step[] => [...Array.from({ length: 5 }, (): Step[] => [DREAM_ADD, { kind: "wait", ms }]).flat(), DREAM_ADD])
);

const plantArgs = (hours: number, now: number): Args => ({
  action: "add",
  kind: "upcoming",
  text: "Book the dentist",
  messages: [1],
  from: new Date(now).toISOString(),
  to: new Date(now + hours * HOUR).toISOString()
});

const fillArgs = (window: boolean, now: number): Args =>
  window
    ? { action: "add", kind: "upcoming", text: "Book the dentist", messages: [1], from: new Date(now).toISOString(), to: new Date(now + 6 * HOUR).toISOString() }
    : { action: "add", kind: "watch", text: "Book the dentist", messages: [1] };

const toolCall = (session: string, args: Args): Call => {
  const by = actorOf(session);

  // SAFETY: the tool's parameters arrive unchecked from the model; args are shaped as them, with a kind the schema would name and refuse.
  return { args: args as Call["args"], by, session, pass: by === "episode" ? passOf(session) : undefined, listOnly: listOnly(session) };
};

type CallStep = Extract<Step, { readonly kind: "tool" | "fill" | "burst" | "plant" | "newest" }>;

type OtherStep = Exclude<Step, CallStep>;

const CALL_KINDS: readonly string[] = ["tool", "fill", "burst", "plant", "newest"];

const isCallStep = (step: Step): step is CallStep => CALL_KINDS.includes(step.kind);

const BURST_ARGS: Args = { action: "add", kind: "watch", text: "tea with Ana", messages: [5] };

function callsOf(step: CallStep, model: Model): readonly (readonly [string, Args])[] {
  switch (step.kind) {
    case "tool":
      return [[step.session, step.args]];
    case "fill":
      return Array.from({ length: step.count }, () => ["1", fillArgs(step.window, model.now)] as const);
    case "burst":
      return Array.from({ length: step.count }, () => [step.session, BURST_ARGS] as const);
    case "plant":
      return [["1", plantArgs(step.hours, model.now)]];
    case "newest":
      return [[step.session, { ...step.args, id: model.rows.length }]];
  }
}

function stamp(model: Model, ids: readonly number[]) {
  for (const row of model.rows) if (ids.includes(row.id)) row.recalled_at = model.now;
}

const freshModel = (): Model => ({ now: START, entries: SEED.map(([conversation, role], at) => ({ id: at + 1, conversation, role })), rows: [], memories: [...MEMORIES], closed: 0 });

const rowsOfModel = (rows: readonly Row[]) => json(rows.map((row) => ({ ...row })));

describe("the anticipate tool and the anticipations it keeps", () => {
  it(
    "answers, refuses and stores as the rules say, over generated runs of calls, chat lines and time",
    () =>
      fc.assert(
        fc.asyncProperty(fc.array(aRun, { maxLength: 30, size: "max" }), async (sequences) => {
          const steps = sequences.flat();
          const world = here();
          const model = freshModel();

          const program = Effect.gen(function* () {
            const store = yield* Anticipating;
            const call = (session: string, args: Args) => outOf(store.act(toolCall(session, args)));

            const ids = (rows: readonly { readonly id: number }[]) => json(rows.map((row) => row.id));

            const other = Effect.fnUntraced(function* (step: OtherStep) {
              switch (step.kind) {
                case "say":
                  enter(world.db, step.conversation, step.role);
                  model.entries.push({ id: model.entries.length + 1, conversation: step.conversation, role: step.role });
                  break;
                case "wait":
                  model.now += step.ms;
                  break;
                case "expire":
                  expect(yield* store.expire(undefined)).toBe(expire(model));
                  break;
                case "match":
                  expect(ids(yield* store.match(step.terms, model.now, step.limit))).toEqual(ids(matching(model, step.terms, step.limit, Number.MAX_SAFE_INTEGER)));
                  break;
                case "recallable":
                  expect(ids(yield* store.recallable(step.terms, model.now, step.limit))).toEqual(ids(matching(model, step.terms, step.limit, model.now - DAY)));
                  break;
                case "recalled":
                  yield* store.recalled(step.ids, undefined);
                  stamp(model, step.ids);
                  break;
                case "recallNewest":
                  yield* store.recalled([model.rows.length], undefined);
                  stamp(model, [model.rows.length]);
                  break;
                case "due":
                  expect(ids(yield* store.due(model.now, model.now + step.hours * HOUR))).toEqual(ids(due(model, model.now + step.hours * HOUR)));
                  break;
              }
            });

            for (const step of steps) {
              yield* TestClock.setTime(model.now);

              if (!isCallStep(step)) yield* other(step);
              else for (const [session, args] of callsOf(step, model)) expect(yield* call(session, args)).toEqual(act(model, session, args));
            }
          });

          await Effect.runPromise(
            program.pipe(
              Effect.provide(
                layerOf(
                  world,
                  anticipatingFor(world, () => void world.seen.closed++)
                )
              )
            )
          );

          expect(rowsOf(world.db, "SELECT * FROM ky_anticipations ORDER BY id")).toEqual(rowsOfModel(model.rows));
          expect(rowsOf(world.db, "SELECT text FROM memo_log ORDER BY id")).toEqual(json(model.memories.map((text) => ({ text }))));
          expect(world.seen.closed).toBe(model.closed);
          world.db.close();
        }),
        runs()
      ),
    600_000
  );

  const aDraft = fc.record({
    kind: fc.constantFrom("open_loop", "upcoming", "watch", "someday"),
    window: fc.constantFrom<Window>(undefined, { from: Number.NaN, to: START }, { from: START, to: Number.POSITIVE_INFINITY }, { from: START, to: START + HOUR }),
    by: fc.constantFrom("user", "dream", "episode"),
    at: fc.integer({ min: 0, max: 3 * DAY })
  });

  it("refuses an unknown kind, a window that isn't dates and an episode without its pass, and stamps a saved one with the clock", () =>
    fc.assert(
      fc.asyncProperty(aDraft, async ({ kind, window, by, at }) => {
        const world = here();
        const model = { ...freshModel(), now: START + at };
        const draft = { kind, text: "Book the dentist", messages: [5], memories: [], window };
        const expected = add(model, draft, by, false);

        const got = await Effect.runPromise(
          Effect.gen(function* () {
            yield* TestClock.setTime(START + at);
            const store = yield* Anticipating;

            // SAFETY: a stored or relayed draft can carry a kind the type does not name; add refuses it.
            return yield* outOf(Effect.map(store.add({ ...draft, kind: kind as "watch", evidence: { messages: draft.messages, memories: [] } }, by as "user", undefined, undefined), (row) => row.id));
          }).pipe(
            Effect.provide(
              layerOf(
                world,
                anticipatingFor(world, () => undefined)
              )
            )
          )
        );

        expect(got).toEqual(expected);
        expect(rowsOf(world.db, "SELECT * FROM ky_anticipations ORDER BY id")).toEqual(rowsOfModel(model.rows));
        world.db.close();
      }),
      runs()
    ));
});

type Kind = "event" | "look" | "post" | "recall";

type Shown = { id: number; kind: Kind; loop: Kind; ref: string; item: string; text: string; shown_at: number; expires_at: number; outcome: string | null; outcome_at: number | null };

type SurfacedStep =
  | { readonly kind: "shown"; readonly surface: Kind; readonly item: string; readonly ref: string; readonly hours: number; readonly text: string }
  | { readonly kind: "outcome"; readonly surface: Kind; readonly item: string; readonly outcome: "expired" | "missed" }
  | { readonly kind: "outcomeOf"; readonly surface: Kind; readonly item: string }
  | { readonly kind: "items"; readonly surface: Kind; readonly prefix: string; readonly back: number; readonly limit: number }
  | { readonly kind: "lastShown"; readonly surface: Kind }
  | { readonly kind: "prune" }
  | { readonly kind: "settle" }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "until"; readonly pick: number };

const aSurface = fc.constantFrom<Kind>("event", "look", "post", "recall");

const anItem = fc.constantFrom("1#4", "1#9", "2#7", "look-a");

const aSurfacedStep: fc.Arbitrary<SurfacedStep> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("shown" as const),
      surface: aSurface,
      item: anItem,
      ref: fc.constantFrom("a", "b"),
      hours: fc.integer({ min: 1, max: 48 }),
      text: fc.constantFrom("about", "again about")
    }),
    weight: 3
  },
  { arbitrary: fc.record({ kind: fc.constant("outcome" as const), surface: aSurface, item: anItem, outcome: fc.constantFrom("expired" as const, "missed" as const) }), weight: 2 },
  fc.record({ kind: fc.constant("outcomeOf" as const), surface: aSurface, item: anItem }),
  fc.record({ kind: fc.constant("items" as const), surface: aSurface, prefix: fc.constantFrom("1#", "2#", "look"), back: fc.integer({ min: 0, max: 96 }), limit: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant("lastShown" as const), surface: aSurface }),
  fc.constant({ kind: "prune" as const }),
  fc.constant({ kind: "settle" as const }),
  {
    arbitrary: fc.record({
      kind: fc.constant("wait" as const),
      ms: fc.oneof(fc.integer({ min: 1_000, max: DAY }), fc.integer({ min: DAY, max: 40 * DAY }), fc.integer({ min: 59 * DAY, max: 61 * DAY }))
    }),
    weight: 3
  }
);

const aSurfacedRun: fc.Arbitrary<readonly SurfacedStep[]> = fc.oneof(
  { arbitrary: aSurfacedStep.map((step) => [step]), weight: 10 },
  fc.integer({ min: 0, max: 3 }).map((pick): SurfacedStep[] => [{ kind: "until", pick }, { kind: "settle" }]),
  fc.tuple(aSurface, fc.integer({ min: 60_000, max: 2 * HOUR }), fc.integer({ min: 1, max: 2 })).map(([surface, ms, limit]): SurfacedStep[] => [
    { kind: "shown", surface, item: "1#4", ref: "a", hours: 48, text: "about" },
    { kind: "wait", ms },
    { kind: "shown", surface, item: "1#9", ref: "b", hours: 48, text: "about" },
    { kind: "items", surface, prefix: "1#", back: 96, limit }
  ])
);

type SurfacedModel = { rows: Shown[]; now: number };

type SurfacedRead = Extract<SurfacedStep, { readonly kind: "outcomeOf" | "items" | "lastShown" }>;

type SurfacedWrite = Exclude<SurfacedStep, SurfacedRead>;

const SURFACED_READS: readonly string[] = ["outcomeOf", "items", "lastShown"];

const isSurfacedRead = (step: SurfacedStep): step is SurfacedRead => SURFACED_READS.includes(step.kind);

const shownAs = (surfaced: SurfacedModel, kind: Kind, item: string) => surfaced.rows.find((row) => row.kind === kind && row.item === item);

function settleSurfaced(surfaced: SurfacedModel) {
  const due = surfaced.rows.filter((row) => row.outcome === null && row.expires_at <= surfaced.now);

  for (const row of due) {
    row.outcome = "expired";
    row.outcome_at = row.expires_at;
  }

  return due.length;
}

function showSurfaced(surfaced: SurfacedModel, step: Extract<SurfacedStep, { readonly kind: "shown" }>) {
  if (shownAs(surfaced, step.surface, step.item)) return yes(null);
  surfaced.rows.push({
    id: Math.max(0, ...surfaced.rows.map((row) => row.id)) + 1,
    kind: step.surface,
    loop: step.surface,
    ref: step.ref,
    item: step.item,
    text: `${step.text} ${step.item}`,
    shown_at: surfaced.now,
    expires_at: surfaced.now + step.hours * HOUR,
    outcome: null,
    outcome_at: null
  });

  return yes(null);
}

function settleOne(surfaced: SurfacedModel, step: Extract<SurfacedStep, { readonly kind: "outcome" }>) {
  settleSurfaced(surfaced);
  const row = shownAs(surfaced, step.surface, step.item);

  if (row === undefined) return no(`Nothing shown as ${step.item}.`);

  if (row.outcome !== null) return no(`${step.item} is ${row.outcome} already.`);
  row.outcome = step.outcome;
  row.outcome_at = surfaced.now;

  return yes(null);
}

function pruneSurfaced(surfaced: SurfacedModel) {
  const old = surfaced.rows.filter((row) => row.outcome_at !== null && row.outcome_at < surfaced.now - 60 * DAY);
  surfaced.rows = surfaced.rows.filter((row) => !old.includes(row));

  return yes(old.length);
}

function untilSurfaced(surfaced: SurfacedModel, pick: number) {
  const waiting = surfaced.rows.filter((row) => row.outcome === null && row.expires_at >= surfaced.now);
  surfaced.now = waiting[pick % Math.max(1, waiting.length)]?.expires_at ?? surfaced.now;
}

function writeSurfaced(surfaced: SurfacedModel, step: SurfacedWrite): Out | undefined {
  switch (step.kind) {
    case "shown":
      return showSurfaced(surfaced, step);
    case "outcome":
      return settleOne(surfaced, step);
    case "prune":
      return pruneSurfaced(surfaced);
    case "settle":
      return yes(settleSurfaced(surfaced));
    case "wait":
      surfaced.now += step.ms;

      return undefined;
    case "until":
      untilSurfaced(surfaced, step.pick);

      return undefined;
  }
}

function lastShownOf(surfaced: SurfacedModel, kind: Kind) {
  const last = new Map<string, number>();

  for (const row of surfaced.rows.filter((each) => each.kind === kind)) last.set(row.ref, Math.max(last.get(row.ref) ?? 0, row.shown_at));

  return [...last].sort(([a], [b]) => a.localeCompare(b));
}

function readSurfaced(surfaced: SurfacedModel, step: SurfacedRead): Out {
  switch (step.kind) {
    case "outcomeOf": {
      const row = shownAs(surfaced, step.surface, step.item);

      return yes(row === undefined ? undefined : row.outcome);
    }

    case "items":
      return yes(
        surfaced.rows
          .filter((row) => row.kind === step.surface && row.item.startsWith(step.prefix) && row.shown_at >= surfaced.now - step.back * HOUR)
          .sort((a, b) => b.shown_at - a.shown_at || b.id - a.id)
          .slice(0, step.limit)
          .map(({ item, text }) => ({ item, text }))
      );
    case "lastShown":
      return yes(lastShownOf(surfaced, step.surface));
  }
}

describe("what was surfaced", () => {
  it("keeps one row a kind and item, settles it once (expired at its expiry), reads it back newest first and forgets settled ones after 60 days", () =>
    fc.assert(
      fc.asyncProperty(fc.array(aSurfacedRun, { maxLength: 24, size: "max" }), async (sequences) => {
        const steps = sequences.flat();
        const world = here();
        const surfaced: SurfacedModel = { rows: [], now: START };

        const program = Effect.gen(function* () {
          const store = yield* SurfacedStore;

          const read = (step: SurfacedRead) => {
            switch (step.kind) {
              case "outcomeOf":
                return outOf(store.outcomeOf(step.surface, step.item));
              case "items":
                return outOf(store.items(step.surface, step.prefix, surfaced.now - step.back * HOUR, step.limit));
              case "lastShown":
                return outOf(Effect.map(store.lastShown(step.surface), (last) => [...last].sort(([a], [b]) => a.localeCompare(b))));
            }
          };

          const write = (step: SurfacedWrite) => {
            switch (step.kind) {
              case "shown":
                return outOf(store.shown({ kind: step.surface, ref: step.ref, item: step.item, text: `${step.text} ${step.item}`, expiresAt: surfaced.now + step.hours * HOUR }, undefined));
              case "outcome":
                return outOf(store.outcome(step.surface, step.item, step.outcome, undefined));
              case "prune":
                return outOf(store.prune(undefined));
              case "settle":
                return outOf(store.expire(undefined));
              case "wait":
              case "until":
                return Effect.succeed(undefined);
            }
          };

          for (const step of steps) {
            const want = isSurfacedRead(step) ? readSurfaced(surfaced, step) : writeSurfaced(surfaced, step);
            yield* TestClock.setTime(surfaced.now);
            expect(yield* isSurfacedRead(step) ? read(step) : write(step)).toEqual(want);
          }
        });

        await Effect.runPromise(program.pipe(Effect.provide(layerOf(world, SurfacedStore.layer))));
        expect(rowsOf(world.db, "SELECT * FROM ky_surfaced ORDER BY id")).toEqual(json(surfaced.rows.map((row) => ({ ...row }))));
        world.db.close();
      }),
      runs()
    ));
});

describe("Settings › Proactivity", () => {
  const aCall = fc.oneof(
    fc.record({ kind: fc.constant("level" as const), level: fc.constantFrom("off" as const, "on" as const) }),
    fc.record({ kind: fc.constant("looks" as const), times: fc.subarray(["08:00", "12:30", "23:59", "24:00", "8:00", "18:00", "08:00", "21:15", "07:60"], { maxLength: 6 }) }),
    fc.record({ kind: fc.constant("looks" as const), times: fc.subarray(["06:45", "08:00", "12:30", "18:00", "21:15", "23:59"], { minLength: 3, maxLength: 6 }) }),
    fc.record({ kind: fc.constant("rightAway" as const), most: fc.constantFrom(-1, 0, 1, 3, 24, 25, 2.5) }),
    fc.constant({ kind: "view" as const })
  );

  it("keeps the level, at most 4 valid look times earliest first and a right-away count of 0 to 24, each defaulted until set, telling listeners of level and look changes", () =>
    fc.assert(
      fc.property(fc.array(aCall, { maxLength: 12, size: "max" }), (calls) => {
        const world = here();
        const proactivity = new Proactivity(storageFor(world.db));
        let changed = 0;
        let told = 0;
        let row: { id: number; level: string; looks: string | null; right_away: number | null } | undefined;
        proactivity.onChange(() => void told++);
        const view = () => ({ level: row?.level === "off" ? "off" : "on", looks: row?.looks ? looksOf(row.looks) : ["08:00", "13:00", "18:00"], rightAway: row?.right_away ?? 6 });
        const upsert = (change: Partial<NonNullable<typeof row>>) => (row = { id: 1, level: view().level, looks: null, right_away: null, ...row, ...change });

        for (const call of calls) {
          const got = (() => {
            try {
              return yes(
                call.kind === "level"
                  ? proactivity.set(call.level)
                  : call.kind === "looks"
                    ? proactivity.setLooks(call.times)
                    : call.kind === "rightAway"
                      ? proactivity.setRightAway(call.most)
                      : proactivity.view()
              );
            } catch (error) {
              return no(error instanceof Error ? error.message : String(error));
            }
          })();

          const want = (() => {
            if (call.kind === "level") {
              upsert({ level: call.level });
              changed++;
            }

            if (call.kind === "looks") {
              const looks = unique(call.times).sort();

              if (looks.some((time) => !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time))) return no("A look time is HH:MM, like 08:00.");

              if (looks.length > 4) return no("At most 4 look times.");
              upsert({ looks: JSON.stringify(looks) });
              changed++;
            }

            if (call.kind === "rightAway") {
              if (!Number.isInteger(call.most) || call.most < 0 || call.most > 24) return no("Right away is a whole number from 0 to 24.");
              upsert({ right_away: call.most });
            }

            return yes(view());
          })();

          expect(got).toEqual(want);
        }

        expect(told).toBe(changed);
        expect(rowsOf(world.db, "SELECT * FROM ky_proactivity")).toEqual(json(row ? [row] : []));
        world.db.close();
      }),
      runs()
    ));
});

describe("presence and a dream's notes", () => {
  it("presence is when the user was last seen, by the clock unless told, and 0 before", () =>
    fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(fc.integer({ min: 1, max: DAY }), fc.constant(0)), { maxLength: 8, size: "max" }), async (waits) => {
        const world = here();
        let now = START;
        let last = 0;

        await Effect.runPromise(
          Effect.gen(function* () {
            const presence = yield* PresenceStore;
            expect(yield* presence.last).toBe(0);

            for (const wait of waits) {
              now += wait;
              yield* TestClock.setTime(now);
              yield* presence.seen(wait === 0 ? now - HOUR : undefined);
              last = wait === 0 ? now - HOUR : now;
              expect(yield* presence.last).toBe(last);
            }
          }).pipe(Effect.provide(layerOf(world, PresenceStore.layer)))
        );

        expect(rowsOf(world.db, "SELECT * FROM ky_presence")).toEqual(json(waits.length === 0 ? [] : [{ id: 1, at: last }]));
        world.db.close();
      }),
      runs()
    ));

  it("a dream notes at most 15 memories a run, counted per dream session, and other sessions are never counted", () =>
    fc.assert(
      fc.property(fc.array(fc.record({ check: fc.constantFrom(true, false, false, false), session: fc.constantFrom("1", "7", "7", "7") }), { maxLength: 60, size: "max" }), (calls) => {
        const world = here();
        const notes = new DreamNotes(storageFor(world.db), isDream);
        let noted = 0;

        for (const { check, session } of calls) {
          if (check) {
            const got = (() => {
              try {
                notes.check(session);

                return yes(null);
              } catch (error) {
                return no(error instanceof Error ? error.message : String(error));
              }
            })();

            expect(got).toEqual(session === "7" && noted >= 15 ? no("A dream notes at most 15 memories a run; this one has. Note nothing more tonight.") : yes(null));
          } else {
            notes.noted(session);

            if (session === "7") noted++;
          }
        }

        expect(rowsOf(world.db, "SELECT * FROM ky_dream_notes")).toEqual(json(noted === 0 ? [] : [{ conversation: "7", notes: noted }]));
        world.db.close();
      }),
      runs()
    ));
});

type DreamStep =
  | { readonly kind: "seen" }
  | { readonly kind: "say" }
  | { readonly kind: "note" }
  | { readonly kind: "plant"; readonly hours: number }
  | { readonly kind: "missed" }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "digest"; readonly checkIns: boolean }
  | { readonly kind: "dream"; readonly answered: boolean }
  | { readonly kind: "at"; readonly minute: number };

const aDreamStep: fc.Arbitrary<DreamStep> = fc.oneof(
  fc.constant({ kind: "seen" as const }),
  fc.constant({ kind: "say" as const }),
  fc.constant({ kind: "note" as const }),
  fc.record({ kind: fc.constant("plant" as const), hours: fc.integer({ min: 1, max: 12 }) }),
  fc.constant({ kind: "missed" as const }),
  { arbitrary: fc.record({ kind: fc.constant("wait" as const), ms: fc.oneof(fc.integer({ min: 60_000, max: 3 * HOUR }), fc.integer({ min: 3 * HOUR, max: 40 * DAY })) }), weight: 3 },
  fc.record({ kind: fc.constant("digest" as const), checkIns: fc.boolean() }),
  { arbitrary: fc.record({ kind: fc.constant("dream" as const), answered: fc.boolean() }), weight: 3 }
);

const aDreamRun: fc.Arbitrary<readonly DreamStep[]> = fc.oneof(
  { arbitrary: aDreamStep.map((step) => [step]), weight: 8 },
  fc
    .tuple(fc.integer({ min: 6 * 60, max: 8 * 60 }), fc.integer({ min: 60_000, max: 2 * HOUR - 60_000 }), fc.boolean())
    .map(([minute, ms, answered]): DreamStep[] => [{ kind: "at", minute }, { kind: "seen" }, { kind: "wait", ms }, { kind: "dream", answered }]),
  fc.tuple(fc.integer({ min: 59 * DAY, max: 62 * DAY }), fc.boolean()).map(([ms, answered]): DreamStep[] => [{ kind: "missed" }, { kind: "wait", ms }, { kind: "dream", answered }])
);

type DreamModel = {
  now: number;
  last: number;
  mark: { memories: number; at: number; said: number };
  marked: boolean;
  memories: number;
  sessions: number;
  shown: number;
  later: number[];
  planted: { to: number; status: string }[];
  missed: number[];
};

type DreamSides = { readonly world: ReturnType<typeof here>; readonly anticipations: Anticipations; readonly presence: Presence; readonly surfaced: Surfaced };

const quietOf = (model: DreamModel, said: readonly string[]) => said.length - Math.max(0, model.mark.said - SEED.length) <= 0 && model.memories <= model.mark.memories;

function dreamWorld(model: DreamModel, sides: DreamSides, step: Exclude<DreamStep, { readonly kind: "digest" | "dream" }>) {
  switch (step.kind) {
    case "seen":
      sides.presence.seen(model.now);
      model.last = model.now;
      break;
    case "say":
      sides.world.said.push(`user: line ${sides.world.said.length}`);
      break;
    case "note":
      sides.world.memory.note(`the user noted ${model.memories}`);
      model.memories++;
      break;
    case "plant":
      sides.anticipations.add({ kind: "watch", text: "tea with Ana", evidence: { messages: [1], memories: [] }, window: { from: model.now, to: model.now + step.hours * HOUR } }, "user", model.now);
      model.planted.push({ to: model.now + step.hours * HOUR, status: "open" });
      break;
    case "missed":
      sides.surfaced.shown({ kind: "post", ref: "a", item: `p${++model.shown}`, text: "a post", expiresAt: model.now + DAY }, model.now);
      sides.surfaced.outcome("post", `p${model.shown}`, "missed", model.now);
      model.missed.push(model.now);
      break;
    case "wait":
      model.now += step.ms;
      break;
    case "at":
      model.now = model.now - (model.now % DAY) + step.minute * 60_000 + (model.now % DAY > step.minute * 60_000 ? DAY : 0);
      break;
  }
}

function bookLater(model: DreamModel) {
  const minutes = Math.floor((model.now % DAY) / 60_000);

  if (minutes < 8 * 60 && model.last + 2 * HOUR < model.now + (8 * 60 - minutes) * 60_000) model.later.push(model.last + 2 * HOUR);
}

function dreamed(model: DreamModel, said: readonly string[], answered: boolean) {
  if (model.now - model.last < 2 * HOUR) return bookLater(model);

  for (const each of model.planted) if (each.status === "open" && each.to < model.now) each.status = "expired";
  model.missed = model.missed.filter((at) => at >= model.now - 60 * DAY);

  if (quietOf(model, said)) return;
  model.sessions++;

  if (!answered) return;
  model.mark = { memories: model.memories, at: model.now, said: SEED.length + said.length };
  model.marked = true;
}

describe("a dream's run", () => {
  it("waits while the user is about (booking a look 2 hours after them before 08:00), skips a quiet night, and moves its mark only when the dream answered", () =>
    fc.assert(
      fc.asyncProperty(fc.array(aDreamRun, { maxLength: 20, size: "max" }), async (sequences) => {
        const steps = sequences.flat();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const world = here();
        const anticipations = new Anticipations(storageFor(world.db), world.memory, (session) => CHATS.has(session));
        const presence = new Presence(storageFor(world.db));
        const surfaced = new Surfaced(storageFor(world.db));
        const parts = { ...dreamOf(world), anticipations, presence, surfaced, verdicts: new Verdicts(storageFor(world.db)) };
        const model: DreamModel = { now: START, last: 0, mark: { memories: 0, at: 0, said: 0 }, marked: false, memories: MEMORIES.length, sessions: 0, shown: 0, later: [], planted: [], missed: [] };
        const sides: DreamSides = { world, anticipations, presence, surfaced };

        const program = Effect.gen(function* () {
          const runs = yield* DreamRuns;

          for (const step of steps) {
            yield* TestClock.setTime(model.now);

            if (step.kind === "digest") {
              const text = yield* runs.digest(yield* runs.mark, { on: step.checkIns, zone: null, waiting: ["water the plants"] });
              expect(text).toEqual(quietOf(model, world.said) ? undefined : expect.stringContaining(`Now: ${new Date(model.now).toISOString()}; the user's time zone: unknown`));
              expect(text?.includes("water the plants") ?? step.checkIns).toBe(step.checkIns);
            } else if (step.kind === "dream") {
              world.answered = step.answered;
              yield* runs.run;
              dreamed(model, world.said, step.answered);
            } else dreamWorld(model, sides, step);
          }
        });

        await Effect.runPromise(program.pipe(Effect.provide(layerOf(world, DreamRuns.layer(parts)))));
        expect(world.seen.later).toEqual(model.later);
        expect(world.seen.sessions).toBe(model.sessions);
        expect(rowsOf(world.db, "SELECT memories, at, said FROM ky_dream")).toEqual(json(model.marked ? [model.mark] : []));
        expect(rowsOf(world.db, "SELECT status FROM ky_anticipations ORDER BY id")).toEqual(json(model.planted.map(({ status }) => ({ status }))));
        expect(rowsOf(world.db, "SELECT outcome_at FROM ky_surfaced ORDER BY id")).toEqual(json(model.missed.map((at) => ({ outcome_at: at }))));
        vi.restoreAllMocks();
        world.db.close();
      }),
      runs()
    ));
});
