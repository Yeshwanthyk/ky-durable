import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Sql } from "../core/sql";
import {
  BROWSE_TABLES,
  type Browsers,
  Failed,
  type Handoff,
  LOGIN_KIND,
  type LoginVault,
  NoBrowser,
  NoPage,
  SavedLogin,
  type Seat,
  type StorageState,
  TookTooLong
} from "./contract";

const TABLE = BROWSE_TABLES.session;

const CONNECT_TIMEOUT_MS = 20_000;

const NAVIGATION_TIMEOUT_MS = 30_000;

const HANDOFF_MS = 30 * 60_000;

const Row = Schema.Struct({ session: Schema.String });

export class Sessions extends Context.Service<
  Sessions,
  {
    readonly current: Effect.Effect<string | undefined>;
    keep(session: string): Effect.Effect<void>;
    drop(session: string): Effect.Effect<void>;
  }
>()("ky/browse/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sql = yield* Sql;

      yield* Effect.orDie(sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), session TEXT NOT NULL, updated_at INTEGER NOT NULL)`));

      return Sessions.of({
        current: Effect.map(Effect.orDie(sql.rows(Row, `SELECT session FROM ${TABLE} WHERE id = 1`)), ([row]) => row?.session),
        keep: (session) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.orDie(
              sql.exec(
                `INSERT INTO ${TABLE} (id, session, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET session = excluded.session, updated_at = excluded.updated_at`,
                session,
                now
              )
            )
          ),
        drop: (session) => Effect.asVoid(Effect.orDie(sql.exec(`DELETE FROM ${TABLE} WHERE session = ?`, session)))
      });
    })
  );
}

export type Desk = { readonly browsers: Browsers; readonly vault: () => LoginVault; readonly lock: Semaphore.Semaphore };

const said = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function timed<A>(what: string, work: () => Promise<A>, ms = CONNECT_TIMEOUT_MS) {
  return Effect.tryPromise({ try: work, catch: (cause) => new Failed({ said: said(cause) }) }).pipe(
    Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.fail(new TookTooLong({ what, ms })) })
  );
}

const SECOND_LEVEL: ReadonlySet<string> = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "ne", "or"]);

/** A host's site, its registrable domain as near as ky tells it: mail.google.com and accounts.google.com are google.com, bbc.co.uk stays whole. */
function siteOf(host: string): string {
  const name = host.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  const labels = name.split(".");

  if (labels.length < 2 || /^[\d.]+$/.test(name) || name.includes(":")) return name;
  const [second = "", top = ""] = labels.slice(-2);
  const country = top.length === 2 && labels.length > 2 && SECOND_LEVEL.has(second);

  return labels.slice(country ? -3 : -2).join(".");
}

export const siteOfUrl = (url: string) => Option.getOrUndefined(Option.map(Option.liftThrowable(() => new URL(url))(), (parsed) => siteOf(parsed.hostname)));

function loginOf(state: StorageState, site: string): StorageState {
  return {
    cookies: state.cookies.filter((cookie) => siteOf(cookie.domain) === site),
    origins: state.origins.filter((origin) => siteOfUrl(origin.origin) === site)
  };
}

export const savedSites = (vault: () => LoginVault) =>
  Effect.tryPromise(() => vault().status()).pipe(
    Effect.map((secrets) => new Set(secrets.flatMap((secret) => (secret.kind === LOGIN_KIND ? [secret.id] : [])))),
    Effect.orElseSucceed(() => new Set<string>())
  );

const restore = (desk: Desk, seat: Seat) =>
  Effect.tryPromise(() => desk.vault().browserLogins()).pipe(
    Effect.flatMap((logins) =>
      Effect.forEach(logins, (login) =>
        Schema.decodeUnknownEffect(SavedLogin)(login).pipe(Effect.flatMap(({ state }) => timed("restoring a login", () => seat.restore(state), NAVIGATION_TIMEOUT_MS)), Effect.ignore)
      )
    ),
    Effect.ignore
  );

const connected = (desk: Desk, session: string) => timed("connecting to ky's browser", () => desk.browsers.connect(session));

const existing = (desk: Desk) =>
  Effect.gen(function* () {
    const session = yield* (yield* Sessions).current;

    if (session === undefined) return Option.none<Seat>();

    return yield* Effect.option(connected(desk, session));
  });

export const seat = (desk: Desk): Effect.Effect<Seat, NoBrowser, Sessions> =>
  Semaphore.withPermit(
    desk.lock,
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const current = yield* sessions.current;

      if (current !== undefined) {
        const again = yield* Effect.option(connected(desk, current));

        if (Option.isSome(again)) return again.value;
        yield* sessions.drop(current);
      }

      const fresh = yield* timed("starting ky's browser", () => desk.browsers.acquire()).pipe(
        Effect.flatMap((session) => Effect.map(connected(desk, session), (opened) => ({ session, opened })))
      );

      yield* sessions.keep(fresh.session);
      yield* restore(desk, fresh.opened);

      return fresh.opened;
    }).pipe(Effect.mapError((error) => new NoBrowser({ said: error._tag === "Failed" ? error.said : error.refusal })))
  );

const disconnect = (opened: Seat) => Effect.ignore(timed("closing ky's browser", () => opened.close()));

export const handOff = (desk: Desk, args: { readonly url?: string | undefined; readonly instructions: string }) =>
  Effect.acquireUseRelease(seat(desk), (opened) =>
    Effect.gen(function* () {
      const tab = args.url === undefined ? yield* timed("finding the open page", () => opened.lastTab()) : yield* timed("opening a page", () => opened.newTab());

      if (tab === undefined) return yield* new NoPage();
      const url = args.url;

      if (url !== undefined) {
        yield* timed("loading the page", () => tab.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }), NAVIGATION_TIMEOUT_MS + 5_000);
      }

      const { target, handoff } = yield* timed("handing the page over", () => opened.handoff(tab, args.instructions, HANDOFF_MS));
      const link = yield* timed("making the live view", () => opened.liveView(tab, HANDOFF_MS));
      const at = tab.url();

      return { handoff, view: { target, site: siteOfUrl(at) ?? at, url: at, link, instructions: args.instructions } satisfies Handoff };
    }),
    disconnect
  );

export type Finished = { readonly title: string; readonly url: string; readonly saved: readonly string[] };

export const finish = (desk: Desk, handoff: Handoff, success: boolean) =>
  Effect.gen(function* () {
    const found = yield* existing(desk);

    if (Option.isNone(found)) return Option.none<Finished>();
    const opened = found.value;

    return yield* Effect.gen(function* () {
      const tab = yield* Effect.orElseSucceed(timed("finding the page", () => opened.tab(handoff.target)), () => undefined);

      if (tab === undefined) return Option.none<Finished>();
      yield* Effect.ignore(timed("ending the hand-off", () => opened.complete(tab, success)));
      const url = tab.url();
      const title = yield* Effect.orElseSucceed(timed("reading the title", () => tab.title()), () => "");
      const saved = success ? yield* keepLogins(desk, opened, [handoff.site, siteOfUrl(url) ?? handoff.site]) : [];
      yield* Effect.ignore(timed("closing the page", () => tab.close()));

      return Option.some({ title, url, saved });
    }).pipe(Effect.ensuring(disconnect(opened)));
  });

const keepLogins = (desk: Desk, opened: Seat, sites: readonly string[]) =>
  timed("reading the login", () => opened.storageState()).pipe(
    Effect.flatMap((state) =>
      Effect.forEach([...new Set(sites)], (site) => {
        const login = loginOf(state, site);

        if (login.cookies.length === 0 && login.origins.length === 0) return Effect.succeed([]);

        return Effect.tryPromise(() => desk.vault().put(LOGIN_KIND, site, login, { cookies: login.cookies.length })).pipe(
          Effect.as([site]),
          Effect.orElseSucceed(() => [])
        );
      })
    ),
    Effect.map((saved) => saved.flat()),
    Effect.orElseSucceed((): string[] => [])
  );

export const forget = (desk: Desk) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const current = yield* sessions.current;

    if (current === undefined) return;
    yield* sessions.drop(current);
    const opened = yield* Effect.option(connected(desk, current));

    if (Option.isSome(opened)) yield* Effect.ignore(timed("ending ky's browser", () => opened.value.end()));
  });
