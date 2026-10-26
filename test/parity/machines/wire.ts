import * as Schema from "effect/Schema";
import fc from "fast-check";

const FACTS = {
  os: "darwin",
  chrome: true,
  repos: [{ name: "api", remote: "https://github.com/acme/api.git" }, { name: "web", remote: null }],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
  ports: [3000, 65_535],
  kind: "computer"
};

const CODEX = { accessToken: "at", refreshToken: null, idToken: "it", accountId: "acct", expiresAt: 1_000 };

export const REPORTS: Json[] = [
  { type: "hello", protocol: 4, version: "1.2.0", active: ["t1"], facts: FACTS },
  { type: "hello", protocol: 3, version: "1.0.0", active: [], facts: FACTS },
  { type: "ack", seq: 1 },
  { type: "session", task: "t1", turn: 1, session: "r1" },
  { type: "step", task: "t1", turn: 2, text: "Reading", call: "k1", input: "{}", state: "done", detail: "d", output: "o" },
  { type: "step", task: "t1", turn: 1, text: "Thinking" },
  { type: "result", task: "t1", turn: 1, ok: true, text: "Done.", session: null, agent: "codex", turns: 0, costUsd: 0.5 },
  { type: "http_head", id: "h1", status: 200, headers: { "content-type": "text/html" } },
  { type: "http_chunk", id: "h1", data: "aGk=" },
  { type: "http_end", id: "h1" },
  { type: "http_error", id: "h1", message: "refused" }
];

export const FRAMES: Json[] = [
  { type: "run", seq: 1, task: "t1", turn: 1, prompt: "Go", session: null, agent: "claude", taskToken: "tok", creds: { claude: { oauthToken: "o" }, codex: CODEX } },
  { type: "run", seq: 2, task: "t1", turn: 2, prompt: "More", session: "r1", agent: "codex", taskToken: "tok" },
  { type: "stop", seq: 3, task: "t1", turn: 2 },
  { type: "creds", seq: 4, task: "t1", codex: CODEX },
  { type: "http_request", id: "h1", port: 1, method: "GET", path: "/", headers: {}, body: "" },
  { type: "http_cancel", id: "h1" },
  { type: "goodbye", reason: "replaced", expected: 4409 },
  { type: "goodbye", reason: "bye" }
];

export const PAIRS: Json[] = [{ code: "c0de", name: "mini", facts: FACTS }, { code: "", name: "mini", facts: null }, { code: "x", name: "-bad", facts: 1 }];

const EDGES: Json[] = [-1, 0, 1, 1.5, 99, 100, 599, 600, 65_535, 65_536, null, true, "", "x", "claude", "codex", "done", "failed", "computer", "cloud", "run", "hello", [], {}];

type Json = Schema.Json;

const json = (depth?: number) => fc.jsonValue({ maxDepth: depth }).map(Schema.decodeUnknownSync(Schema.Json));

const isNumber = Schema.is(Schema.Number);

const isList = Schema.is(Schema.Array(Schema.Json));

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

type Step = { readonly index: number } | { readonly key: string };

type Path = readonly Step[];

function pathsOf(value: Json | undefined, at: Path = []): Path[] {
  if (isList(value)) return [at, ...value.flatMap((each, index) => pathsOf(each, [...at, { index }]))];

  if (!isList(value) && isObject(value)) return [at, ...Object.entries(value).flatMap(([key, each]) => pathsOf(each, [...at, { key }]))];

  return [at];
}

type Edit = { readonly pick: number; readonly how: "drop" | "set" | "add" | "nudge"; readonly to: Json };

function edited(value: Json | undefined, path: Path, edit: Edit): Json | undefined {
  const [step, ...rest] = path;

  if (step === undefined) {
    if (edit.how === "set") return edit.to;

    if (edit.how === "nudge" && isNumber(value)) return value + (isNumber(edit.to) && edit.to < 0 ? -1 : 1);

    if (edit.how === "add" && !isList(value) && isObject(value)) return Object.fromEntries([...Object.entries(value), ["extra", edit.to]]);

    return value;
  }

  if (isList(value) && "index" in step) {
    if (rest.length === 0 && edit.how === "drop") return value.filter((_, index) => index !== step.index);

    return value.map((each, index) => (index === step.index ? (edited(each, rest, edit) ?? null) : each));
  }

  if (!isList(value) && isObject(value) && "key" in step) {
    if (rest.length === 0 && edit.how === "drop") return Object.fromEntries(Object.entries(value).filter(([name]) => name !== step.key));

    return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, name === step.key ? (edited(each, rest, edit) ?? null) : each]));
  }

  return value;
}

const edit: fc.Arbitrary<Edit> = fc.record({ pick: fc.nat(), how: fc.constantFrom("drop" as const, "set" as const, "add" as const, "nudge" as const), to: fc.oneof(fc.constantFrom(...EDGES), json(1)) });

export const texts = (seeds: Json[]): fc.Arbitrary<{ value: Json | undefined; text: string }> =>
  fc.oneof(
    { weight: 8, arbitrary: fc.tuple(fc.constantFrom(...seeds), fc.array(edit, { maxLength: 2 })) },
    { weight: 1, arbitrary: fc.tuple(json(), fc.constant([])) }
  ).map(([seed, edits]) => {
    const value = edits.reduce<Json | undefined>((was, each) => {
      const paths = pathsOf(was);

      return edited(was, paths[each.pick % paths.length] ?? [], each);
    }, seed);

    return { value, text: JSON.stringify(value) ?? "" };
  });
