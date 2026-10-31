import type { JsonValue } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";
import { KY } from "../skills/contract";

export const PageRead = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  links: Schema.Array(Schema.Struct({ text: Schema.String, href: Schema.String })),
  headings: Schema.optionalKey(Schema.Array(Schema.Struct({ level: Schema.Number, text: Schema.String })))
});

export type PageRead = typeof PageRead.Type;

export const PdfInfo = Schema.Struct({ Title: Schema.NonEmptyString });

export type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type Reply = { output?: Part[]; isError?: boolean };

export type Step = { do: "click" | "fill" | "press" | "wait"; selector?: string; value?: string };

export type Args = { url: string; steps?: Step[]; screenshot?: boolean };

type Shown = { headers(): Record<string, string>; body(): Promise<Uint8Array> };

export type Response = Shown & { ok(): boolean; status(): number; url(): string };

type Locator = {
  click(options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  press(key: string, options: { timeout: number }): Promise<void>;
};

type CdpSession = {
  send(method: "Page.captureScreenshot", params: { format: "png"; captureBeyondViewport: boolean }): Promise<{ data: string }>;
  detach(): Promise<void>;
};

export interface BrowserPage {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<Response | null>;
  waitForLoadState(state: "networkidle" | "domcontentloaded", options: { timeout: number }): Promise<void>;
  evaluate(read: (maxLinks: number) => PageRead, maxLinks: number): Promise<PageRead>;
  url(): string;
  locator(selector: string): { first(): Locator };
  context(): { newCDPSession(page: Pick<BrowserPage, "url">): Promise<CdpSession> };
}

export type Browser = {
  newPage(options: { viewport: { width: number; height: number } }): Promise<BrowserPage>;
  close(): Promise<void>;
  _connection?: { toImpl?(browser: Browser): { _connection?: { _transport?: { close(): void } } } };
};

export type Launch = () => Promise<Browser>;

export interface BrowserTab extends BrowserPage {
  title(): Promise<string>;
  close(): Promise<void>;
}

/** One connection to ky's persistent Chromium session; `close` disconnects and leaves the session running. */
export interface Seat {
  newTab(): Promise<BrowserTab>;
  lastTab(): Promise<BrowserTab | undefined>;
  tab(target: string): Promise<BrowserTab | undefined>;
  handoff(tab: BrowserTab, instructions: string, ms: number): Promise<{ target: string; handoff: string }>;
  liveView(tab: BrowserTab, ms: number): Promise<string>;
  complete(tab: BrowserTab, success: boolean): Promise<void>;
  /** Starts the demo recorder in the tab's frames and in each document it opens; the navigation index it starts at. */
  record(tab: BrowserTab): Promise<number>;
  /** What the recorder logged in each of the tab's frames, and the tab's navigation history. */
  recorded(tab: BrowserTab): Promise<Recorded>;
  storageState(): Promise<StorageState>;
  restore(state: StorageState): Promise<void>;
  end(): Promise<void>;
  close(): Promise<void>;
}

export interface Browsers {
  readonly kitesurf: Launch;
  acquire(): Promise<string>;
  connect(session: string): Promise<Seat>;
}

type SecretMeta = { readonly [field: string]: string | number | boolean | null | readonly string[] };

export interface LoginVault {
  status(): Promise<ReadonlyArray<{ readonly kind: string; readonly id: string; readonly meta: SecretMeta | null; readonly updatedAt: number }>>;
  put(kind: typeof LOGIN_KIND, id: string, value: JsonValue, meta: { cookies: number }): Promise<void>;
  remove(kind: typeof LOGIN_KIND, id: string): Promise<void>;
  /** Whether there was a secret at `id` to move to `to`, over any there. */
  move(kind: typeof LOGIN_KIND, id: string, to: string): Promise<boolean>;
  browserLogins(owner: string): Promise<ReadonlyArray<{ readonly site: string; readonly state: string }>>;
}

/** Each owner's session; `beforeOwners` held ky's one session before owners, and is emptied into it on start. */
export const BROWSE_TABLES = { session: "ky_browser_sessions", beforeOwners: "ky_browser_session" } as const;

export const LOGIN_KIND = "browser-login";

/** A browser login's Vault id: whose it is ("ky" or a specialist's id), and its site. */
export const loginId = (owner: string, site: string) => `${owner}:${site}`;

const OWNED = /^([a-z0-9]+(?:-[a-z0-9]+)*):(.+)$/;

/** Whose login a Vault id is, and for which site; one from before owners is ky's. */
export function ownedLogin(id: string): { readonly owner: string; readonly site: string } {
  const [, owner, site] = OWNED.exec(id) ?? [];

  return owner === undefined || site === undefined ? { owner: KY, site: id } : { owner, site };
}

/** How a tool's reply names an owner. */
export const ownerName = (owner: string) => (owner === KY ? KY : `@${owner}`);

export type Cookie = typeof Cookie.Type;

const Cookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  expires: Schema.Number,
  httpOnly: Schema.Boolean,
  secure: Schema.Boolean,
  sameSite: Schema.Literals(["Strict", "Lax", "None"])
});

export const StorageState = Schema.Struct({
  cookies: Schema.Array(Cookie),
  origins: Schema.Array(Schema.Struct({ origin: Schema.String, localStorage: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })) }))
});

export type StorageState = typeof StorageState.Type;

export const SavedLogin = Schema.Struct({ site: Schema.String, state: Schema.fromJsonString(StorageState) });

export const Handoff = Schema.Struct({
  target: Schema.String,
  site: Schema.String,
  url: Schema.String,
  link: Schema.String,
  instructions: Schema.String,
  /** Whose browser it is, so whose the login it keeps is; a hand-off from before owners is ky's. */
  owner: Schema.optionalKey(Schema.String),
  teach: Schema.optionalKey(Schema.Struct({ from: Schema.Number }))
});

export type Handoff = typeof Handoff.Type;

/** A browse call whose steps act on a site with a saved login, as its card keeps it until the user decides. */
export const StepsAsked = Schema.Struct({
  url: Schema.String,
  /** Whose session they run in; a card from before owners is ky's. */
  owner: Schema.optionalKey(Schema.String),
  steps: Schema.Array(
    Schema.Struct({ do: Schema.Literals(["click", "fill", "press", "wait"]), selector: Schema.optionalKey(Schema.String), value: Schema.optionalKey(Schema.String) })
  ),
  screenshot: Schema.Boolean
});

export type StepsAsked = typeof StepsAsked.Type;

const Described = Schema.Struct({
  tag: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  href: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String)
});

export const TeachEvent = Schema.Struct({
  t: Schema.Literals(["page", "click", "input", "submit"]),
  url: Schema.String,
  frame: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  el: Schema.optionalKey(Described),
  at: Schema.Number
});

export type TeachEvent = typeof TeachEvent.Type;

/** Each frame's log, as JSON lines the page wrote, and the tab's navigation history. */
export type Recorded = {
  readonly logs: readonly string[];
  readonly history: { readonly currentIndex: number; readonly entries: ReadonlyArray<{ readonly url: string; readonly title: string }> };
};

const Visited = Schema.Struct({ url: Schema.String, title: Schema.String });

export const Recording = Schema.Struct({
  site: Schema.String,
  instructions: Schema.String,
  finishedAt: Schema.Number,
  pages: Schema.Array(Visited),
  events: Schema.Array(TeachEvent)
});

export type Recording = typeof Recording.Type;

export const TEACH_DIR = "/workspace/teach";

const Login = Schema.Struct({ owner: Schema.String, site: Schema.String, cookies: Schema.Number, updatedAt: Schema.Number });

export type Login = typeof Login.Type;

/** Settings' list: each login by owner and site, and every owner a login can move to. */
export const Logins = Schema.Struct({ logins: Schema.Array(Login), owners: Schema.Array(Schema.String) });

export type Logins = typeof Logins.Type;

/** Settings moves a login to another owner. */
export const MoveLogin = Schema.Struct({ to: Schema.String });

export class NoLoginOwner extends Schema.TaggedError<NoLoginOwner>()("NoLoginOwner", { owner: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No specialist @${this.owner}.`;
  }
}

export class LoginTaken extends Schema.TaggedError<LoginTaken>()("LoginTaken", { owner: Schema.String, site: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${ownerName(this.owner)} already keeps a login for ${this.site}: remove that one first.`;
  }
}

export class NoLogin extends Schema.TaggedError<NoLogin>()("NoLogin", { owner: Schema.String, site: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${ownerName(this.owner)} keeps no login for ${this.site}.`;
  }
}

export class NoBrowser extends Schema.TaggedError<NoBrowser>()("NoBrowser", { said: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky's browser session couldn't start: ${this.said}`;
  }
}

export class LoginsUnknown extends Schema.TaggedError<LoginsUnknown>()("LoginsUnknown", {}) implements Refusable {
  get refusal(): string {
    return "ky couldn't check which sites its browser is signed in to, so no step ran. Try again in a moment.";
  }
}

export class NoPage extends Schema.TaggedError<NoPage>()("NoPage", {}) implements Refusable {
  get refusal(): string {
    return "Nothing is open in ky's browser: give the url of the page to hand over.";
  }
}

export class OnlyInChat extends Schema.TaggedError<OnlyInChat>()("OnlyInChat", {}) implements Refusable {
  get refusal(): string {
    return "Only a chat with the user can hand the browser over. Say in your report what the user must do there, for the main agent to ask.";
  }
}

export class TookTooLong extends Schema.TaggedError<TookTooLong>()("TookTooLong", { what: Schema.String, ms: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.what} took longer than ${this.ms / 1000}s`;
  }
}

export class Stopped extends Schema.TaggedError<Stopped>()("Stopped", { reason: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.reason;
  }
}

export class Failed extends Schema.TaggedError<Failed>()("Failed", { said: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.said;
  }
}

export class PdfAnswered extends Schema.TaggedError<PdfAnswered>()("PdfAnswered", { status: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `fetching the PDF answered HTTP ${this.status}`;
  }
}

export class NothingToRead extends Schema.TaggedError<NothingToRead>()("NothingToRead", { url: Schema.String, status: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.url} answered HTTP ${this.status} with nothing to read.`;
  }
}

export class NotAPdf extends Schema.TaggedError<NotAPdf>()("NotAPdf", { url: Schema.String, aborted: Schema.Boolean }) implements Refusable {
  get refusal(): string {
    return this.aborted
      ? `${this.url} aborted its navigation in the browser, so browse can't read it.`
      : `${this.url} downloads a file that is neither a page nor a PDF, so browse can't read it.`;
  }
}

export class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", { url: Schema.String, mb: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.url} is a PDF over ${this.mb} MB, too large to read.`;
  }
}
