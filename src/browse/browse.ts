import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Sql } from "../core/sql";
import { KY, ownedId } from "../skills/contract";
import {
  BROWSE_TABLES,
  type Browsers,
  Failed,
  type Handoff,
  LOGIN_KIND,
  LoginTaken,
  LoginsUnknown,
  type LoginVault,
  NoBrowser,
  NoLogin,
  type Recorded,
  NoPage,
  ownedLogin,
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

const BEFORE_OWNERS = BROWSE_TABLES.beforeOwners;

const Named = Schema.Struct({ name: Schema.String });

export class Sessions extends Context.Service<
  Sessions,
  {
    current(owner: string): Effect.Effect<string | undefined>;
    keep(owner: string, session: string): Effect.Effect<void>;
    drop(session: string): Effect.Effect<void>;
  }
>()("ky/browse/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sql = yield* Sql;

      // Each owner's one session; the single row from before owners becomes ky's once, and leaves its old table empty.
      yield* Effect.orDie(
        Effect.gen(function* () {
          yield* sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (owner TEXT PRIMARY KEY, session TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
          const old = yield* sql.rows(Named, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", BEFORE_OWNERS);

          if (old.length === 0) return;
          yield* sql.transaction(
            Effect.gen(function* () {
              yield* sql.exec(`INSERT OR IGNORE INTO ${TABLE} (owner, session, updated_at) SELECT ?, session, updated_at FROM ${BEFORE_OWNERS}`, KY);
              yield* sql.exec(`DELETE FROM ${BEFORE_OWNERS}`);
            })
          );
        })
      );

      return Sessions.of({
        current: (owner) => Effect.map(Effect.orDie(sql.rows(Row, `SELECT session FROM ${TABLE} WHERE owner = ?`, owner)), ([row]) => row?.session),
        keep: (owner, session) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.orDie(
              sql.exec(
                `INSERT INTO ${TABLE} (owner, session, updated_at) VALUES (?, ?, ?) ON CONFLICT (owner) DO UPDATE SET session = excluded.session, updated_at = excluded.updated_at`,
                owner,
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

/** Every saved login, by owner and site; never its value. */
export const savedLogins = (vault: () => LoginVault) =>
  Effect.tryPromise({ try: () => vault().status(), catch: () => new LoginsUnknown() }).pipe(
    Effect.map((secrets) => secrets.flatMap((secret) => (secret.kind === LOGIN_KIND ? [ownedLogin(secret.id)] : [])))
  );

const restore = (desk: Desk, owner: string, seat: Seat) =>
  Effect.tryPromise(() => desk.vault().browserLogins(owner)).pipe(
    Effect.flatMap((logins) =>
      Effect.forEach(logins, (login) =>
        Schema.decodeUnknownEffect(SavedLogin)(login).pipe(Effect.flatMap(({ state }) => timed("restoring a login", () => seat.restore(state), NAVIGATION_TIMEOUT_MS)), Effect.ignore)
      )
    ),
    Effect.ignore
  );

const connected = (desk: Desk, session: string) => timed("connecting to ky's browser", () => desk.browsers.connect(session));

const existing = (desk: Desk, owner: string) =>
  Effect.gen(function* () {
    const session = yield* (yield* Sessions).current(owner);

    if (session === undefined) return Option.none<Seat>();

    return yield* Effect.option(connected(desk, session));
  });

/** `owner`'s one session, found again or started with its logins and no other owner's. */
export const seat = (desk: Desk, owner: string): Effect.Effect<Seat, NoBrowser, Sessions> =>
  Semaphore.withPermit(
    desk.lock,
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const current = yield* sessions.current(owner);

      if (current !== undefined) {
        const again = yield* Effect.option(connected(desk, current));

        if (Option.isSome(again)) return again.value;
        yield* sessions.drop(current);
      }

      const fresh = yield* timed("starting ky's browser", () => desk.browsers.acquire()).pipe(
        Effect.flatMap((session) => Effect.map(connected(desk, session), (opened) => ({ session, opened })))
      );

      yield* sessions.keep(owner, fresh.session);
      yield* restore(desk, owner, fresh.opened);

      return fresh.opened;
    }).pipe(Effect.mapError((error) => new NoBrowser({ said: error._tag === "Failed" ? error.said : error.refusal })))
  );

const disconnect = (opened: Seat) => Effect.ignore(timed("closing ky's browser", () => opened.close()));

export const handOff = (desk: Desk, owner: string, args: { readonly url?: string | undefined; readonly instructions: string; readonly teach?: boolean | undefined }) =>
  Effect.acquireUseRelease(seat(desk, owner), (opened) =>
    Effect.gen(function* () {
      const tab = args.url === undefined ? yield* timed("finding the open page", () => opened.lastTab()) : yield* timed("opening a page", () => opened.newTab());

      if (tab === undefined) return yield* new NoPage();
      const from = args.teach === true ? Option.some(yield* timed("starting the recorder", () => opened.record(tab))) : Option.none<number>();
      const url = args.url;

      if (url !== undefined) {
        yield* timed("loading the page", () => tab.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }), NAVIGATION_TIMEOUT_MS + 5_000);
      }

      const { target, handoff } = yield* timed("handing the page over", () => opened.handoff(tab, args.instructions, HANDOFF_MS));
      const link = yield* timed("making the live view", () => opened.liveView(tab, HANDOFF_MS));
      const at = tab.url();

      const view: Handoff = { target, site: siteOfUrl(at) ?? at, url: at, link, instructions: args.instructions, owner };

      return { handoff, view: Option.match(from, { onNone: () => view, onSome: (index) => ({ ...view, teach: { from: index } }) }) };
    }),
    disconnect
  );

export type Finished = { readonly title: string; readonly url: string; readonly saved: readonly string[]; readonly recorded: Option.Option<Recorded> };

export const finish = (desk: Desk, handoff: Handoff, success: boolean) =>
  Effect.gen(function* () {
    const owner = handoff.owner ?? KY;
    const found = yield* existing(desk, owner);

    if (Option.isNone(found)) return Option.none<Finished>();
    const opened = found.value;

    return yield* Effect.gen(function* () {
      const tab = yield* Effect.orElseSucceed(timed("finding the page", () => opened.tab(handoff.target)), () => undefined);

      if (tab === undefined) return Option.none<Finished>();
      const recorded = success && handoff.teach !== undefined ? yield* Effect.option(timed("reading what the user did", () => opened.recorded(tab))) : Option.none<Recorded>();
      yield* Effect.ignore(timed("ending the hand-off", () => opened.complete(tab, success)));
      const url = tab.url();
      const title = yield* Effect.orElseSucceed(timed("reading the title", () => tab.title()), () => "");
      // Under the lock, so a move or a removal of this login can't land between reading the session and saving it.
      const saved = success ? yield* Semaphore.withPermit(desk.lock, keepLogins(desk, owner, opened, [handoff.site, siteOfUrl(url) ?? handoff.site])) : [];
      yield* Effect.ignore(timed("closing the page", () => tab.close()));

      return Option.some({ title, url, saved, recorded });
    }).pipe(Effect.ensuring(disconnect(opened)));
  });

const keepLogins = (desk: Desk, owner: string, opened: Seat, sites: readonly string[]) =>
  timed("reading the login", () => opened.storageState()).pipe(
    Effect.flatMap((state) =>
      Effect.forEach([...new Set(sites)], (site) => {
        const login = loginOf(state, site);

        if (login.cookies.length === 0 && login.origins.length === 0) return Effect.succeed([]);

        return Effect.tryPromise(() => desk.vault().put(LOGIN_KIND, ownedId(owner, site), login, { cookies: login.cookies.length })).pipe(
          Effect.as([site]),
          Effect.orElseSucceed(() => [])
        );
      })
    ),
    Effect.map((saved) => saved.flat()),
    Effect.orElseSucceed((): string[] => [])
  );

/**
 * `owner`'s session ends, and its next one restores the logins `owner` still keeps. Its row goes first: a session ky
 * can't reach to end is never seated again, and Browser Run closes it once its keep-alive runs out.
 */
const end = (desk: Desk, owner: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const current = yield* sessions.current(owner);

    if (current === undefined) return;
    yield* sessions.drop(current);
    const opened = yield* Effect.option(connected(desk, current));

    if (Option.isSome(opened)) yield* Effect.ignore(timed("ending ky's browser", () => opened.value.end()));
  });

export const forget = (desk: Desk, owner: string) => Semaphore.withPermit(desk.lock, end(desk, owner));

/**
 * A login moves to another owner: the session that held it ends, and so does the new owner's, whose next one restores
 * it. Never over a login the new owner keeps for the site already: the user removes that one first.
 */
export const move = (desk: Desk, from: string, site: string, to: string) =>
  Semaphore.withPermit(
    desk.lock,
    Effect.gen(function* () {
      const theirs = yield* Effect.tryPromise({ try: () => desk.vault().browserLogins(to), catch: (cause) => new Failed({ said: said(cause) }) });

      if (theirs.some((login) => login.site === site)) return yield* new LoginTaken({ owner: to, site });
      const moved = yield* Effect.tryPromise({ try: () => desk.vault().move(LOGIN_KIND, ownedId(from, site), ownedId(to, site)), catch: (cause) => new Failed({ said: said(cause) }) });

      if (!moved) return yield* new NoLogin({ owner: from, site });
      yield* end(desk, from);
      yield* end(desk, to);
    })
  );
