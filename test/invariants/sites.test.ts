import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicSiteRoute as legacyPublicRoute, siteRoute as legacySiteRoute } from "../../src/sites/legacy/site-routes";
import { legacySiteExtension as legacyExtension } from "../../src/sites/legacy/sites";
import { publicSiteRoute, siteExtension, siteRoute } from "../../src/sites/wiring";
import { assertParity, budget, type Clock, type Instance, type Json, type Parity } from "../parity/kit";
import { type FakeFile, fakeBucket, fakeFiles, requestOf, seededRandom, siteId, sortedMeta, toolOf } from "../parity/sites/world";

const ORIGIN = "https://ky.test";

const MB = 1024 * 1024;

const CHAT = 1;

const SIDE = 2;

const isChat = (session: string) => session === String(CHAT);

const Stored = Schema.fromJsonString(Schema.Struct({ title: Schema.String, created: Schema.Number, token: Schema.optional(Schema.String) }));

const storedOf = (text: string | undefined) => (text === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(Stored)(text)));

afterEach(() => {
  vi.restoreAllMocks();
});

function port(seed: Record<string, string> = {}, files: Record<string, FakeFile> = {}) {
  const bucket = fakeBucket(seed);
  const fs = fakeFiles(files);

  return { bucket, fs, tool: toolOf(siteExtension(isChat, bucket, { fs }, () => ORIGIN)), request: requestOf({ siteRoute, publicSiteRoute }, bucket) };
}

const metaOf = (title: string, created: number, token?: string) => JSON.stringify(token === undefined ? { title, created } : { title, created, token });

const fillers = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, at) => [`sites/${siteId(1000 + at)}/.site`, metaOf(`filler ${at}`, at)]));

const SEEDED = { [`sites/${siteId(5)}/.site`]: metaOf("Five", 5), [`sites/${siteId(5)}/index.html`]: "five", [`sites/${siteId(6)}/index.html`]: "cut off" };

function titled(args: Record<string, string>, title: string | undefined) {
  if (title === undefined) return args;

  return { ...args, title };
}

const refusal = (text: string) => ({ text, failed: true });

const anyArgs = fc.record(
  {
    action: fc.constantFrom("publish", "list", "make_public", "make_private", "delete"),
    id: fc.oneof(fc.constant(siteId(5)), fc.string()),
    title: fc.string(),
    html: fc.string(),
    dir: fc.constantFrom("/workspace/one", "/")
  },
  { requiredKeys: ["action"] }
);

describe("refusals", () => {
  it("I-S1: refuses every action in a conversation that is no chat, and changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(anyArgs, async (args) => {
        const { bucket, tool } = port(SEEDED, { "/workspace/one/index.html": { body: "one" } });
        const before = bucket.dump();

        expect(await tool(args, SIDE)).toEqual(refusal("Not done: only a chat with the user may publish sites."));
        expect(bucket.dump()).toEqual(before);
      }),
      budget()
    );
  });

  it("I-S2: refuses a site that has no metadata, by its id, and changes nothing", async () => {
    const missing = fc.oneof(fc.string(), fc.stringMatching(/^[0-9a-f]{32}$/), fc.constant(siteId(6))).filter((id) => id !== siteId(5));

    await fc.assert(
      fc.asyncProperty(missing, fc.constantFrom("publish", "make_public", "make_private", "delete"), async (id, action) => {
        fc.pre(!(action === "delete" && id === siteId(6)));
        const { bucket, tool } = port(SEEDED);
        const before = bucket.dump();

        expect(await tool({ action, id, html: "x" })).toEqual(refusal(`No site ${id}.`));
        expect(bucket.dump()).toEqual(before);
      }),
      budget()
    );
  });

  it("I-S3: publishes a new site only while ky keeps fewer than 50", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 45, max: 55 }), async (count) => {
        const { bucket, tool } = port(fillers(count));
        const said = await tool({ action: "publish", html: "x" });
        const sites = new Set([...bucket.objects.keys()].map((key) => key.split("/")[1]));

        if (count >= 50) {
          expect(said).toEqual(refusal("Not published: ky keeps at most 50 sites. Delete one first."));
          expect(sites.size).toBe(count);
        } else {
          expect(said.failed).toBe(false);
          expect(sites.size).toBe(count + 1);
        }
      }),
      budget()
    );
  });

  it("I-S4: publishes from html or dir, never both or neither", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.option(fc.string(), { nil: undefined }), async (both, title) => {
        const { bucket, tool } = port({}, { "/workspace/one/index.html": { body: "one" } });
        const given: Record<string, string> = both ? { html: "<p>x</p>", dir: "/workspace/one" } : {};

        expect(await tool(titled({ action: "publish", ...given }, title))).toEqual(refusal("Not published: give either html or dir."));
        expect(bucket.dump()).toEqual({});
      }),
      budget()
    );
  });

  it("I-S5: refuses a folder that is the root or climbs out with ..", async () => {
    const segments = fc.array(fc.constantFrom("", ".", "..", "workspace", "one"), { maxLength: 5 });

    await fc.assert(
      fc.asyncProperty(segments, fc.boolean(), async (parts, rooted) => {
        const dir = `${rooted ? "/" : ""}${parts.join("/")}`;
        const { bucket, tool } = port({}, { "/workspace/one/index.html": { body: "one" } });
        const said = await tool({ action: "publish", dir });
        const named = parts.filter((part) => part !== "" && part !== ".");
        const refused = refusal(`Not published: name a folder in the workspace, such as /workspace/site, not ${dir}.`);

        if (named.length === 0 || named.includes("..")) {
          expect(said).toEqual(refused);
          expect(bucket.dump()).toEqual({});
        } else expect(said).not.toEqual(refused);
      }),
      budget()
    );
  });

  it("I-S6: refuses a folder with no files but hidden ones", async () => {
    const hiddenPath = fc.tuple(fc.constantFrom(".env", ".git/config", ".cache/a/b.html", "sub/.secret"), fc.string({ minLength: 1, maxLength: 4 }));

    await fc.assert(
      fc.asyncProperty(fc.array(hiddenPath, { minLength: 1, maxLength: 4 }), async (paths) => {
        const files = Object.fromEntries(paths.map(([path, body]) => [`/workspace/site/${path}`, { body }]));
        const { bucket, tool } = port({}, files);

        expect(await tool({ action: "publish", dir: "/workspace/site" })).toEqual(refusal("Not published: /workspace/site has no files."));
        expect(bucket.dump()).toEqual({});
      }),
      budget()
    );
  });

  it("I-S7: publishes a folder of at most 200 files, all of them", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 195, max: 205 }), async (count) => {
        const files = Object.fromEntries(Array.from({ length: count }, (_, at) => [`/workspace/many/d${at % 7}/${at}.html`, { body: "x" }]));
        const { bucket, tool } = port({}, files);
        const said = await tool({ action: "publish", dir: "/workspace/many" });

        if (count > 200) {
          expect(said).toEqual(refusal("Not published: a site holds at most 200 files, and /workspace/many has more."));
          expect(bucket.dump()).toEqual({});
        } else {
          expect(said.text).toContain(`${count} files`);
          expect(bucket.objects.size).toBe(count + 1);
        }
      }),
      budget()
    );
  });

  it("I-S8: refuses a site over 10 MB, by its size, before reading any file", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 4 * MB }), { minLength: 1, maxLength: 5 }), async (sizes) => {
        const files = Object.fromEntries(sizes.map((size, at) => [`/workspace/big/${at}.html`, { body: "x", size }]));
        const { bucket, fs, tool } = port({}, files);
        const total = sizes.reduce((sum, size) => sum + size, 0);
        const said = await tool({ action: "publish", dir: "/workspace/big" });

        if (total > 10 * MB) {
          expect(said).toEqual(refusal(`Not published: a site holds at most 10 MB, and this is ${(total / MB).toFixed(1)} MB.`));
          expect(fs.reads).toEqual([]);
          expect(bucket.dump()).toEqual({});
        } else expect(said.failed).toBe(false);
      }),
      budget()
    );
  });

  it("I-S9: refuses a folder it can't read, saying why, and stores nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.nat(), fc.string(), async (count, broken, why) => {
        const files = Object.fromEntries(Array.from({ length: count }, (_, at) => [`/workspace/site/${at}.html`, at === broken % count ? { body: "", fails: why } : { body: "ok" }]));
        const { bucket, tool } = port({}, files);

        expect(await tool({ action: "publish", dir: "/workspace/site" })).toEqual(refusal(`Couldn't read /workspace/site: ${why}`));
        expect(bucket.dump()).toEqual({});
      }),
      budget()
    );
  });
});

const now = (at: number) => vi.spyOn(Date, "now").mockImplementation(() => at);

type Port = ReturnType<typeof port>;

const storedAt = async ({ bucket }: Port, id: string) => storedOf(await bucket.get(`sites/${id}/.site`).then((object) => object?.text()));

const newSite = async ({ tool }: Port, args: Record<string, string>) => /id ([0-9a-f]{32})/.exec((await tool(args)).text)?.[1] ?? "";

const publicObjects = ({ bucket }: Port) => Object.fromEntries(Object.entries(bucket.dump()).flatMap(([key, id]) => (key.startsWith("sites-public/") ? [[key.slice("sites-public/".length), id]] : [])));

const tokenAt = async (site: Port, id: string) => (await storedAt(site, id))?.token;

const stepArgs = (action: string, id: string): Parameters<Port["tool"]>[0] => (action === "publish" ? { action, id, html: "again" } : { action, id });

const RETIRES = new Set(["make_private", "delete"]);

async function expectGone(site: Port, retired: Set<string>) {
  for (const each of retired) expect([publicObjects(site)[each], await site.request("GET", `/p/${each}/`)]).toMatchObject([undefined, { status: 404 }]);
}

async function tokenStep(site: Port, action: string, id: string, retired: Set<string>) {
  const was = await tokenAt(site, id);
  const said = await site.tool(stepArgs(action, id));
  const token = await tokenAt(site, id);

  if (action === "make_public" && !said.failed) expect([said.text.includes(`/p/${token}/`), was ?? token]).toEqual([true, token]);

  if (RETIRES.has(action) && was !== undefined) retired.add(was);
  await expectGone(site, retired);
}

describe("stored metadata", () => {
  it("I-S10: a site was created when it was first published, however often it is published again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 2 ** 40 }), { minLength: 1, maxLength: 5 }), async (times) => {
        const site = port();
        now(times[0] ?? 0);
        const id = await newSite(site, { action: "publish", html: "x" });

        for (const at of times.slice(1)) {
          now(at);
          await site.tool({ action: "publish", id, html: String(at) });
        }

        expect((await storedAt(site, id))?.created).toBe(times[0]);
        expect(await site.request("GET", "/api/sites")).toMatchObject({ body: JSON.stringify([{ id, title: "Untitled", created: times[0], public: false }]) });
      }),
      budget()
    );
  });

  it("I-S11: a site's title is the last one given, Untitled until one is", async () => {
    const titles = fc.array(fc.option(fc.string(), { nil: undefined }), { minLength: 1, maxLength: 5 });

    await fc.assert(
      fc.asyncProperty(titles, async ([first, ...rest]) => {
        const site = port();
        const id = await newSite(site, titled({ action: "publish", html: "x" }, first));

        for (const title of rest) await site.tool(titled({ action: "publish", id, html: "y" }, title));
        const expected = [first, ...rest].reduce<string | undefined>((last, title) => title ?? last, undefined) ?? "Untitled";

        expect((await storedAt(site, id))?.title).toBe(expected);
      }),
      budget()
    );
  });

  it("I-S12: a site is public exactly while its metadata names a token whose object names it, and a token made private never works again", async () => {
    const step = fc.record({ action: fc.constantFrom("make_public", "make_private", "delete", "publish"), at: fc.constantFrom(0, 1) });

    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 20 }), async (steps) => {
        const site = port();
        const ids = [await newSite(site, { action: "publish", html: "x" }), await newSite(site, { action: "publish", html: "x" })];
        const retired = new Set<string>();

        for (const { action, at } of steps) await tokenStep(site, action, ids[at] ?? "", retired);
        const named = await Promise.all(ids.map(async (id) => [(await storedAt(site, id))?.token, id] as const));

        expect(publicObjects(site)).toEqual(Object.fromEntries(named.filter(([token]) => token !== undefined)));
      }),
      budget()
    );
  });
});

const MANY = Object.fromEntries(Array.from({ length: 201 }, (_, at) => [`/workspace/many/${at % 9}/${at}.html`, { body: "m" }]));

const WORKSPACE = {
  "/workspace/one/index.html": { body: "<h1>One</h1>" },
  "/workspace/web/index.html": { body: "<!doctype html><link rel=stylesheet href=css/app.css>" },
  "/workspace/web/css/app.css": { body: "h1 { color: red }" },
  "/workspace/web/js/app.js": { body: "console.log(1)" },
  "/workspace/web/v1.2/LICENSE": { body: "MIT" },
  "/workspace/web/.env": { body: "KEY=secret" },
  "/workspace/web/.git/config": { body: "[core]" },
  "/workspace/empty/.hidden": { body: "x" },
  "/workspace/broken/index.html": { body: "ok" },
  "/workspace/broken/z.html": { body: "", fails: "EIO: input/output error" },
  "/workspace/big/a.html": { body: "a", size: 6 * MB },
  "/workspace/big/b.html": { body: "b", size: 6 * MB },
  ...MANY
} satisfies Record<string, FakeFile>;

const WORLD = {
  ...fillers(44),
  [`sites/${siteId(901)}/.site`]: "{not json",
  [`sites/${siteId(901)}/index.html`]: "corrupt",
  [`sites/${siteId(902)}/index.html`]: "cut off",
  [`sites/${siteId(903)}/.site`]: JSON.stringify({ title: "Older", created: 3, token: "AAAAAAAAAAAAAAAAAAAAAA", note: "from a newer ky" }),
  [`sites/${siteId(903)}/index.html`]: "<p>older</p>",
  "sites-public/AAAAAAAAAAAAAAAAAAAAAA": siteId(903)
};

const IDS = [siteId(1), siteId(2), siteId(3), siteId(901), siteId(902), siteId(903), "nope", ""];

type Action =
  | { readonly kind: "tool"; readonly chat: boolean; readonly args: Record<string, string> }
  | { readonly kind: "request"; readonly method: string; readonly path: string }
  | { readonly kind: "public"; readonly method: string; readonly at: number; readonly rest: string };

const toolAction = fc.record({
  kind: fc.constant("tool" as const),
  chat: fc.oneof({ weight: 9, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  args: fc.record(
    {
      action: fc.constantFrom("publish", "publish", "publish", "list", "make_public", "make_public", "make_private", "delete"),
      id: fc.constantFrom(...IDS),
      title: fc.constantFrom("Hello", ""),
      html: fc.constantFrom("<h1>Hi</h1>", "<!DOCTYPE html><p>typed</p>"),
      dir: fc.constantFrom("/workspace/one", "/workspace/./web/", "/", "/workspace/..", "/workspace/empty", "/workspace/broken", "/workspace/big", "/workspace/many", "/workspace/none")
    },
    { requiredKeys: ["action"] }
  )
});

const method = fc.constantFrom("GET", "GET", "GET", "HEAD", "POST");

const requestAction = fc.record({
  kind: fc.constant("request" as const),
  method,
  path: fc.oneof(
    fc.constant("/api/sites"),
    fc.constantFrom("/s/zz/", "/p/abc/", "/p/AAAAAAAAAAAAAAAAAAAAAA/", "/elsewhere"),
    fc
      .tuple(fc.constantFrom(...IDS.slice(0, 6)), fc.constantFrom("/", "", "/?embed", "/?embed=dark", "/css/app.css", "/v1.2/LICENSE", "/js/app.js", "/.site", "/%2e%2e/x", "/css%2F..%2Fx", "/%E0%A4%A"))
      .map(([id, rest]) => `/s/${id}${rest}`)
  )
});

const publicAction = fc.record({ kind: fc.constant("public" as const), method, at: fc.nat({ max: 2 }), rest: fc.constantFrom("/", "", "/css/app.css", "/.site") });

function side(clock: Clock, make: (bucket: ReturnType<typeof fakeBucket>, files: ReturnType<typeof fakeFiles>) => { tool: ReturnType<typeof toolOf>; request: ReturnType<typeof requestOf> }): Instance<Action> {
  const bucket = fakeBucket(WORLD);
  const files = fakeFiles(WORKSPACE);
  const random = seededRandom();
  const { tool, request } = make(bucket, files);

  return {
    apply: async (action) => {
      random.use();
      vi.spyOn(Date, "now").mockImplementation(() => clock.now());

      if (action.kind === "tool") return tool(action.args, action.chat ? CHAT : SIDE);

      if (action.kind === "request") return request(action.method, action.path);
      const tokens = [...bucket.objects.keys()].filter((key) => key.startsWith("sites-public/")).sort((a, b) => (a < b ? -1 : 1));
      const token = tokens[action.at % Math.max(tokens.length, 1)]?.slice("sites-public/".length) ?? "none";

      return request(action.method, `/p/${token}${action.rest}`);
    },
    tables: async () => sortedMeta(bucket.dump()),
    effects: async (): Promise<Json> => ({ reads: [...files.reads] }),
    dispose: async () => {}
  };
}

const asB = {
  // SAFETY: B's site tool reads only head, get, put, delete and list of the bucket and find, stat and readFile of the workspace, what the port's types name.
  extension: legacyExtension as typeof siteExtension,
  // SAFETY: B's routes read only FILES of the Worker's env, and of it what the port's types name.
  siteRoute: legacySiteRoute as typeof siteRoute,
  // SAFETY: as siteRoute's.
  publicSiteRoute: legacyPublicRoute as typeof publicSiteRoute
};

const sites: Parity<Action> = {
  domain: "sites",
  actions: fc.oneof({ weight: 3, arbitrary: toolAction }, { weight: 2, arbitrary: requestAction }, { weight: 1, arbitrary: publicAction }),
  advances: fc.integer({ min: 0, max: 10_000 }),
  start: Date.UTC(2026, 0, 1),
  legacy: async (clock) =>
    side(clock, (bucket, files) => ({
      tool: toolOf(asB.extension(isChat, bucket, { fs: files }, () => ORIGIN)),
      request: requestOf(asB, bucket)
    })),
  next: async (clock) => side(clock, (bucket, files) => ({ tool: toolOf(siteExtension(isChat, bucket, { fs: files }, () => ORIGIN)), request: requestOf({ siteRoute, publicSiteRoute }, bucket) }))
};

describe("parity", () => {
  it("answers every tool call and request as B did, and leaves the bucket as B left it", () => assertParity(sites));
});
