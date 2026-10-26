import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addressOf, MAIL_BYTES, MAIL_TABLES, mailLimits } from "../../src/mail/contract";
import * as B from "../../src/mail/legacy/mail";
import { assertParity, budget, type Clock, type Instance, type Json, type Parity } from "../parity/kit";
import { blocked, type Deps, legacyOf, said, type Side } from "../parity/mail/legacy";
import { portOf } from "../parity/mail/port";
import { StoredRow } from "../parity/skills/storage";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

const ADDRESS = "ky@mail.test";

const OWNER = "owner@ky.test";

const LIMITS = { dailySends: 2, hourlyTriages: 2 };

const MAIN = "1";

const SIDE = "2";

const CHATS = new Set([MAIN, SIDE]);

const SESSIONS = [MAIN, SIDE, "3"] as const;

const TRIAGERS = ["7", "8"] as const;

type Incoming = {
  readonly from: string;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly html: boolean;
  readonly id: string;
  readonly inReplyTo: string;
};

type Triage = { readonly start: string | null; readonly said: string | undefined };

type Tool = {
  readonly tool: "send" | "reply" | "list" | "read" | "expect";
  readonly session: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly pick: number;
  readonly from: string;
  readonly minutes: number | null;
};

type Action =
  | { readonly receive: Incoming; readonly triage: Triage }
  | Tool
  | { readonly approve: number }
  | { readonly discard: number }
  | { readonly disallow: string }
  | { readonly view: true }
  | { readonly block: string }
  | { readonly setUp: boolean }
  | { readonly sendFails: boolean };

const anIncoming: fc.Arbitrary<Incoming> = fc.record({
  from: fc.constantFrom("a@b.test", "Bea <BEA@b.test>", "news@github.com", "code@mail.github.com", OWNER),
  name: fc.constantFrom("", "Bea"),
  subject: fc.constantFrom("Your code", "", "x".repeat(320)),
  body: fc.constantFrom("Your code is 4821", "<p>Hi &amp; <b>bye</b></p><style>p{}</style>", "  ", "y".repeat(20_100)),
  html: fc.boolean(),
  id: fc.constantFrom("m1", "m2", "m3", ""),
  inReplyTo: fc.constantFrom("", "<sent-1@ky.test>", "<sent-2@ky.test>", "<m1@sender.test>")
});

const aTriage: fc.Arbitrary<Triage> = fc.record({
  start: fc.constantFrom(null, ...TRIAGERS),
  said: fc.constantFrom(undefined, "  ", "NOTHING_NEW", "Bea sent a code: 4821")
});

const aTool: fc.Arbitrary<Tool> = fc.record({
  tool: fc.constantFrom<Tool["tool"]>("send", "reply", "list", "read", "expect"),
  session: fc.constantFrom(...SESSIONS, ...TRIAGERS),
  to: fc.constantFrom("a@b.test", "Owner <OWNER@ky.test>", "news@github.com", "not an address", "a@b.test, c@d.test"),
  subject: fc.constantFrom("Hello", "", "re: Your code", "Your code"),
  text: fc.constantFrom("Hi there", "  ", "z".repeat(20_001)),
  pick: fc.integer({ min: 0, max: 5 }),
  from: fc.constantFrom("github.com", "@GitHub.com", "a@b.test", "", "two words"),
  minutes: fc.constantFrom(null, 0, 5, 2.6, 1e6)
});

const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ receive: anIncoming, triage: aTriage }), weight: 5 },
  { arbitrary: aTool, weight: 6 },
  { arbitrary: fc.record({ approve: fc.integer({ min: 0, max: 5 }) }), weight: 3 },
  { arbitrary: fc.record({ discard: fc.integer({ min: 0, max: 5 }) }), weight: 1 },
  { arbitrary: fc.record({ disallow: fc.constantFrom("a@b.test", "A <A@B.test>", "news@github.com", "nobody@x.test") }), weight: 1 },
  { arbitrary: fc.constant({ view: true as const }), weight: 1 },
  { arbitrary: fc.record({ block: fc.constantFrom(...SESSIONS, ...TRIAGERS) }), weight: 1 },
  { arbitrary: fc.record({ setUp: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ sendFails: fc.boolean() }), weight: 1 }
);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(observed: Json): Json {
  const seen = new Map<string, string>();

  return JSON.stringify(observed).replace(UUID, (id) => {
    const known = seen.get(id) ?? `id-${seen.size}`;
    seen.set(id, known);

    return known;
  });
}

function raw(mail: Incoming): string {
  return [
    `From: ${mail.name ? `${mail.name} <${mail.from}>` : mail.from}`,
    `To: ${ADDRESS}`,
    `Subject: ${mail.subject}`,
    ...(mail.id ? [`Message-ID: <${mail.id}@sender.test>`] : []),
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`, `References: <older@sender.test> ${mail.inReplyTo}`] : []),
    `Content-Type: text/${mail.html ? "html" : "plain"}; charset=utf-8`,
    "",
    mail.body
  ].join("\r\n");
}

const rowsDecoded = Schema.decodeUnknownSync(Schema.Array(StoredRow));

function rowsOf(db: DatabaseSync, table: string): Json[] {
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(table).length === 0) return [];

  return [...rowsDecoded(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())];
}

type Seen = { readonly told: [string | null, string, string][]; readonly triaged: Json[]; readonly sent: string[] };

type Make = (db: DatabaseSync, deps: Deps, chat: (session: string) => boolean) => Side;

const next: Make = portOf;

function world(db: DatabaseSync, make: Make) {
  const seen: Seen = { told: [], triaged: [], sent: [] };
  const triage: Triage = { start: null, said: undefined };
  const state = { setUp: true, sendFails: false, triage };

  const boundary = {
    address: ADDRESS,
    send: async (message: EmailMessageBuilder) => {
      if (state.sendFails) throw new Error("the daily quota is spent");
      seen.sent.push(JSON.stringify(message));

      return { messageId: `sent-${seen.sent.length}@ky.test` };
    }
  };

  const deps: Deps = {
    get boundary() {
      return state.setUp ? boundary : undefined;
    },
    limits: LIMITS,
    owners: () => [OWNER],
    tell: async (session, content, requestId) => void seen.told.push([session, content, requestId]),
    triage: async (mail, content, started) => {
      seen.triaged.push([mail.id, content]);

      if (state.triage.start) started(state.triage.start);

      return state.triage.said;
    }
  };

  const side = make(db, deps, (session) => CHATS.has(session));
  const idAt = (pick: number) => side.recent(50)[pick]?.id ?? "none";

  const apply = async (action: Action): Promise<Json> => {
    if ("receive" in action) {
      state.triage = action.triage;
      const mail = await side.readMail(raw(action.receive), { from: "bounce@sender.test", to: `Ky <${ADDRESS.toUpperCase()}>` });
      await side.receive(mail);

      return { ...mail, answers: [...mail.answers] };
    }

    if ("tool" in action) {
      const { tool, session, pick, minutes, ...args } = action;
      const call = { ...args, action: tool, id: idAt(pick) };

      return said(side.extension, minutes === null ? call : { ...call, minutes }, session);
    }

    if ("approve" in action) return side.approve(idAt(action.approve));

    if ("discard" in action) return side.discard(idAt(action.discard));

    if ("disallow" in action) return side.disallow(action.disallow);

    if ("view" in action) {
      const shown = side.view();

      return { ...shown, held: [...shown.held], recent: [...shown.recent], allowed: [...shown.allowed] };
    }

    if ("block" in action) return blocked(side.extension, action.block);

    if ("setUp" in action) {
      state.setUp = action.setUp;

      return null;
    }

    state.sendFails = action.sendFails;

    return null;
  };

  return { seen, side, apply, idAt };
}

function instance(db: DatabaseSync, make: Make): Instance<Action> {
  const made = world(db, make);

  return {
    apply: made.apply,
    tables: async () => ({
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'ky_mail%' ORDER BY name")
        .all()
        .map(({ type, name, sql }) => ({ type: String(type), name: String(name), sql: String(sql).replace(/\s+/g, " ") })),
      mail: rowsOf(db, MAIL_TABLES.mail),
      allowed: rowsOf(db, MAIL_TABLES.allowed),
      expect: rowsOf(db, MAIL_TABLES.expect)
    }),
    effects: async () => made.seen,
    dispose: async () => db.close()
  };
}

function useClock(clock: Clock): void {
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
}

afterEach(() => {
  vi.restoreAllMocks();
});

const mailParity: Parity<Action> = {
  domain: "mail",
  actions,
  start: START,
  advances: fc.oneof(fc.integer({ min: 0, max: 2 * HOUR }), fc.constantFrom(HOUR, HOUR + 1, DAY, 5 * 60_000)),
  normalize,
  legacy: async (clock) => {
    useClock(clock);

    return instance(new DatabaseSync(":memory:"), legacyOf);
  },
  next: async (clock) => {
    useClock(clock);

    return instance(new DatabaseSync(":memory:"), next);
  }
};

describe("mail parity", () => {
  it("answers, stores, tells, triages and sends what B does, step for step", async () => {
    await assertParity(mailParity);
  });
});

const MailStored = Schema.Struct({
  id: Schema.String,
  direction: Schema.String,
  message_id: Schema.NullOr(Schema.String),
  answers: Schema.NullOr(Schema.String),
  party: Schema.String,
  party_name: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  state: Schema.String,
  session: Schema.String,
  note: Schema.String,
  at: Schema.Number
});

const AllowedStored = Schema.Struct({ address: Schema.String, at: Schema.Number });

const ExpectStored = Schema.Struct({ session: Schema.String, sender: Schema.String, until: Schema.Number });

function port() {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const db = new DatabaseSync(":memory:");
  const made = world(db, next);

  return {
    ...made,
    tool: (args: Record<string, string | number>, session = MAIN) => said(made.side.extension, { action: "send", ...args }, session),
    mail: () => Schema.decodeUnknownSync(Schema.Array(MailStored))(db.prepare(`SELECT * FROM ${MAIL_TABLES.mail} ORDER BY rowid`).all()),
    allowed: () => Schema.decodeUnknownSync(Schema.Array(AllowedStored))(db.prepare(`SELECT * FROM ${MAIL_TABLES.allowed} ORDER BY rowid`).all()),
    expecting: () => Schema.decodeUnknownSync(Schema.Array(ExpectStored))(db.prepare(`SELECT * FROM ${MAIL_TABLES.expect} ORDER BY rowid`).all()),
    now: () => at,
    advance: (ms: number) => void (at += ms),
    [Symbol.dispose]: () => db.close()
  };
}

const runs = () => ({ numRuns: budget().numRuns * 4, seed: budget().seed });

const SET_UP = "ky has no address yet: the user sets it up in Settings › Mail.";

describe("writing a mail", () => {
  it("is refused, in this order, when ky has no address, the address isn't one, the subject or text is empty, or the text is too long", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom("a@b.test", "Bea <a@b.test>", "not an address", "a@b", "a@b.test, c@d.test"),
        fc.constantFrom("Hello", " ", ""),
        fc.constantFrom("Hi", "\n", "w".repeat(20_000), "w".repeat(20_001)),
        async (setUp, to, subject, text) => {
          using ky = port();
          await ky.apply({ setUp });
          const bare = (/<([^>]+)>/.exec(to)?.[1] ?? to).trim().toLowerCase();

          const words = !setUp
            ? SET_UP
            : !/^[^\s@<>()",;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare)
              ? `${to} isn't one email address.`
              : subject.trim() === "" || text.trim() === ""
                ? "A mail needs a subject and some text."
                : text.length > 20_000
                  ? "A mail is at most 20000 characters."
                  : undefined;

          const answer = await ky.tool({ to, subject, text });

          if (words) {
            expect(answer).toBe(words);
            expect(ky.mail()).toEqual([]);
          } else expect(answer).toMatch(/^Held for the user: ky hasn't written to a@b\.test before/);
          vi.restoreAllMocks();
        }
      ),
      runs()
    );
  });

  it("keeps what was written: an outbound row with its party, subject, body, the writing chat, a state and the clock's time", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("a@b.test", OWNER), fc.constantFrom(MAIN, SIDE), fc.integer({ min: 0, max: DAY }), fc.constantFrom("Hi there", "w".repeat(20_000)), async (to, session, elapsed, text) => {
        using ky = port();
        ky.advance(elapsed);
        await ky.tool({ to: to.toUpperCase(), subject: "Hello", text }, session);
        const [row] = ky.mail();

        expect(row?.id).toMatch(UUID);
        expect(row).toEqual({
          id: row?.id,
          direction: "out",
          message_id: to === OWNER ? "<sent-1@ky.test>" : null,
          answers: null,
          party: to,
          party_name: "",
          subject: "Hello",
          body: text,
          state: to === OWNER ? "sent" : "held",
          session,
          note: "",
          at: START + elapsed
        });
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("sending", () => {
  it("stops at the daily cap, counted over the clock's last day, and records why", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 2 * DAY }), async (more, gap) => {
        using ky = port();
        const answers: string[] = [];

        for (let i = 0; i < LIMITS.dailySends; i++) answers.push(await ky.tool({ to: OWNER, subject: `s${i}`, text: "Hi" }));
        ky.advance(gap);

        for (let i = 0; i < more; i++) answers.push(await ky.tool({ to: OWNER, subject: `t${i}`, text: "Hi" }));
        const capped = gap < DAY;

        expect(answers.slice(LIMITS.dailySends)).toEqual(
          Array.from({ length: more }, (_, i) => (!capped && i < LIMITS.dailySends ? `Sent to ${OWNER}.` : `ky sent ${LIMITS.dailySends} mails today, its most; try tomorrow.`))
        );
        const refused = ky.mail().filter((row) => row.state === "failed");
        expect(refused.every((row) => row.note === `ky sends at most ${LIMITS.dailySends} mails a day.`)).toBe(true);
        vi.restoreAllMocks();
      }),
      runs()
    );
  });

  it("answers Email Service's refusal in its words, keeps the mail failed with why, and names the mail a reply answers", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (fails) => {
        using ky = port();
        await ky.apply({ receive: { from: OWNER, name: "", subject: "Hi", body: "Hello", html: false, id: "m1", inReplyTo: "" }, triage: { start: null, said: "hello" } });
        await ky.apply({ sendFails: fails });
        const answer = await ky.tool({ action: "reply", id: ky.idAt(0), text: "Thanks" });
        const out = ky.mail().find((row) => row.direction === "out");

        expect(answer).toBe(fails ? "Email Service refused it: the daily quota is spent" : `Sent to ${OWNER}.`);
        expect(out).toMatchObject({ state: fails ? "failed" : "sent", note: fails ? "the daily quota is spent" : "", subject: "Re: Hi", answers: ky.mail()[0]?.id });
        expect(ky.seen.sent).toEqual(fails ? [] : [expect.stringContaining('"headers":{"In-Reply-To":"<m1@sender.test>","References":"<m1@sender.test>"}')]);
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("a held mail", () => {
  it("is sent or discarded once: after that, or for an id never held, it isn't waiting any more", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("approve", "discard"), fc.constantFrom("approve", "discard"), async (first, second) => {
        using ky = port();
        await ky.tool({ to: "a@b.test", subject: "Hello", text: "Hi" });
        const id = ky.idAt(0);
        const act = (how: string, which: string) => (how === "approve" ? ky.side.approve(which) : ky.side.discard(which));

        expect(await act(first, id)).toEqual({});
        expect(await act(second, id)).toEqual({ refused: "That mail isn't waiting any more." });
        expect(await act(second, crypto.randomUUID())).toEqual({ refused: "That mail isn't waiting any more." });
        expect(ky.mail()[0]?.state).toBe(first === "approve" ? "sent" : "discarded");
        vi.restoreAllMocks();
      }),
      runs()
    );
  });

  it("sent by the user allows its address from then on, at the clock's time; disallowing one that isn't allowed is refused", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: DAY }), fc.boolean(), async (elapsed, approve) => {
        using ky = port();
        await ky.tool({ to: "a@b.test", subject: "Hello", text: "Hi" });
        ky.advance(elapsed);

        if (approve) await ky.apply({ approve: 0 });

        expect(ky.allowed()).toEqual(approve ? [{ address: "a@b.test", at: START + elapsed }] : []);
        expect(await ky.tool({ to: "a@b.test", subject: "Again", text: "Hi" })).toEqual(approve ? "Sent to a@b.test." : expect.stringMatching(/^Held for the user/));
        expect(await ky.apply({ disallow: "Bea <A@B.test>" })).toEqual(approve ? {} : { refused: "Bea <A@B.test> isn't allowed." });
        expect(await ky.apply({ disallow: "a@b.test" })).toEqual({ refused: "a@b.test isn't allowed." });
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("reading mail with the tool", () => {
  it("refuses to reply to a mail that didn't come in, and to read one there isn't", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (outbound) => {
        using ky = port();

        if (outbound) await ky.tool({ to: "a@b.test", subject: "Hello", text: "Hi" });
        const id = outbound ? ky.idAt(0) : "nope";

        expect(await ky.tool({ action: "reply", id, text: "Hi" })).toBe(`No mail ${id} came to ky.`);
        expect(await ky.tool({ action: "read", id })).toBe(outbound ? "[ky's mail to a@b.test, held]\nSubject: Hello\n\nHi" : `No mail ${id}.`);
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("expecting mail", () => {
  it("needs a sender, waits 1 to 1440 whole minutes from the clock, and keeps the chat and the bare sender", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("GitHub.com", "@github.com", " a@b.test ", "", "two words"), fc.option(fc.double({ min: -10, max: 5000, noNaN: true }), { nil: undefined }), fc.constantFrom(MAIN, SIDE), async (from, minutes, session) => {
        using ky = port();
        ky.advance(1234);
        const answer = await ky.tool(minutes === undefined ? { action: "expect", from } : { action: "expect", from, minutes }, session);
        const sender = from.trim().toLowerCase().replace(/^@/, "");

        if (!sender || /\s/.test(sender)) {
          expect(answer).toBe("expect needs from: an address, or a domain like github.com.");
          expect(ky.expecting()).toEqual([]);
        } else {
          const wait = Math.min(Math.max(1, Math.round(minutes ?? 60)), 1440);
          expect(answer).toBe(`Mail from ${sender} in the next ${wait} minutes comes to this chat, read for you.`);
          expect(ky.expecting()).toEqual([{ session, sender, until: START + 1234 + wait * 60_000 }]);
        }

        vi.restoreAllMocks();
      }),
      runs()
    );
  });

  it("brings a mail from the sender, its domain or under it to the waiting chat until the clock passes the wait", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("news@github.com", "code@mail.github.com", "a@b.test"), fc.integer({ min: 0, max: 2 * 60 * 60_000 }), async (from, elapsed) => {
        using ky = port();
        await ky.tool({ action: "expect", from: "github.com", minutes: 60 }, SIDE);
        ky.advance(elapsed);
        await ky.apply({ receive: { from, name: "", subject: "Code", body: "4821", html: false, id: "m1", inReplyTo: "" }, triage: { start: null, said: "the code is 4821" } });
        const waits = from.endsWith("github.com") && elapsed < 60 * 60_000;

        expect(ky.seen.told.map(([session]) => session)).toEqual([waits ? SIDE : null]);
        expect(ky.expecting().length).toBe(elapsed < 60 * 60_000 ? 1 : 0);
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("a mail that came in", () => {
  it("is kept as read off SMTP, at the clock's time, with the mail of ky's it answers, its triage and its summary", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("", "Bea"),
        fc.constantFrom("Your code is 4821", "<p>A &amp; B</p><script>x()</script>"),
        fc.boolean(),
        fc.constantFrom(null, ...TRIAGERS),
        fc.constantFrom(undefined, " ", "a code"),
        fc.integer({ min: 0, max: DAY }),
        async (name, body, answers, start, summary, elapsed) => {
          using ky = port();
          await ky.tool({ to: OWNER, subject: "Hello", text: "Hi" });
          ky.advance(elapsed);
          await ky.apply({ receive: { from: "BEA@b.test", name, subject: "Re: Hello", body, html: body.startsWith("<"), id: "m1", inReplyTo: answers ? "<sent-1@ky.test>" : "" }, triage: { start, said: summary } });
          const [out, row] = ky.mail();

          expect(row?.id).toMatch(UUID);
          expect(row).toEqual({
            id: row?.id,
            direction: "in",
            message_id: "<m1@sender.test>",
            answers: answers ? out?.id : null,
            party: "bea@b.test",
            party_name: name,
            subject: "Re: Hello",
            body: body.startsWith("<") ? "A & B" : body,
            state: "triaged",
            session: start ?? "",
            note: summary?.trim() || "ky couldn't read this mail just now.",
            at: START + elapsed
          });
          expect(await blocked(ky.side.extension, start ?? "9")).toBe(start ? "Reading a mail, you call no tools: say what it says." : null);
          vi.restoreAllMocks();
        }
      ),
      runs()
    );
  });

  it("is only kept past the hourly triage cap, counted over the clock's last hour, and once however often SMTP delivers it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 2 * HOUR }), fc.boolean(), async (more, gap, again) => {
        using ky = port();
        const mail = (id: string) => ({ receive: { from: "a@b.test", name: "", subject: "Hi", body: "Hello", html: false, id, inReplyTo: "" }, triage: { start: null, said: "hello" } });

        for (let i = 0; i < LIMITS.hourlyTriages; i++) await ky.apply(mail(`m${i}`));
        ky.advance(gap);

        for (let i = 0; i < more; i++) await ky.apply(mail(`n${i}`));

        if (again) await ky.apply(mail("m0"));
        const late = ky.mail().slice(LIMITS.hourlyTriages);
        const capped = gap < HOUR;

        expect(late.map((row) => row.state)).toEqual(Array.from({ length: more }, (_, i) => (!capped && i < LIMITS.hourlyTriages ? "triaged" : "kept")));
        expect(ky.mail().length).toBe(LIMITS.hourlyTriages + more);
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("the Worker's mail settings", () => {
  it("read an address, the caps and the size ky takes as B does", () => {
    const part = fc.constantFrom("", " ", "0", "7", "-3", "2.5", "x", "40", "a@B.test", "<A@b.TEST>", "Bea <BEA@b.test>", "<>");

    fc.assert(
      fc.property(part, part, part, (text, daily, hourly) => {
        const vars = { KY_MAIL_DAILY_SENDS: daily, KY_MAIL_HOURLY_TRIAGES: hourly };

        expect(addressOf(text)).toBe(B.addressOf(text));
        expect(mailLimits(vars)).toEqual(B.mailLimits(vars));
        expect(mailLimits({})).toEqual(B.mailLimits({}));
        expect(MAIL_BYTES).toBe(B.MAIL_BYTES);
      }),
      runs()
    );
  });
});
