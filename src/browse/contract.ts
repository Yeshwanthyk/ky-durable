import type { JsonValue } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

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
  browserLogins(): Promise<ReadonlyArray<{ readonly site: string; readonly state: string }>>;
}

export const BROWSE_TABLES ={ session: "ky_browser_session" } as const;

export const LOGIN_KIND = "browser-login";

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

export const Handoff = Schema.Struct({ target: Schema.String, site: Schema.String, url: Schema.String, link: Schema.String, instructions: Schema.String });

export type Handoff = typeof Handoff.Type;

const Login = Schema.Struct({ site: Schema.String, cookies: Schema.Number, updatedAt: Schema.Number });

export type Login = typeof Login.Type;

export const Logins = Schema.Struct({ logins: Schema.Array(Login) });

export class NoBrowser extends Schema.TaggedError<NoBrowser>()("NoBrowser", { said: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky's browser session couldn't start: ${this.said}`;
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
