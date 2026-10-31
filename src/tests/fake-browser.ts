import type { Browser, Browsers, BrowserTab, Cookie, Launch, PageRead, Response, Seat, StorageState } from "../browse/contract";

/**
 * Browser Run for the tests: Kitesurf, and Chromium sessions kept by id, as `ky`'s browse reaches them through
 * `Boundary.browsers`. A page is what `pages` says is at its URL; Kitesurf reads `kitesurf` instead where that
 * names the URL (or fails, for "fails"). A session holds its tabs, cookies and hand-offs until `killSessions` ends it.
 */

/** `goesTo`: a click on that selector takes the tab to that URL, as a link does. */
type FakePage = {
  readonly title: string;
  readonly text: string;
  readonly status?: number;
  readonly headings?: PageRead["headings"];
  readonly goesTo?: Readonly<Record<string, string>>;
};

type Handoff = { readonly target: string; readonly instructions: string; done?: boolean };

const BLANK: FakePage = { title: "", text: "" };

function responseOf(url: string, status: number): Response {
  return { headers: () => ({ "content-type": "text/html" }), body: async () => new Uint8Array(), ok: () => status < 400, status: () => status, url: () => url };
}

class FakeTab implements BrowserTab {
  #url = "about:blank";
  closed = false;
  /** Whether a show-me hand-off's recorder runs here, and each frame's log, as the recorder writes it: JSON lines. */
  recording = false;
  logs: string[] = [];
  readonly history: Array<{ url: string; title: string }> = [{ url: "about:blank", title: "" }];

  constructor(
    readonly target: string,
    readonly read: (url: string) => FakePage,
    readonly onClose: () => void,
    readonly acted: string[]
  ) {}

  async goto(url: string) {
    const page = this.read(url);

    if (page === FAILS) throw new Error("Kitesurf couldn't render the page");
    this.#url = url;
    this.history.push({ url, title: page.title });

    return responseOf(url, page.status ?? 200);
  }

  async waitForLoadState() {}

  async evaluate() {
    const { title, text, headings = [] } = this.read(this.#url);

    return { title, text, links: [], headings };
  }

  url() {
    return this.#url;
  }

  locator(selector: string) {
    const act = (what: string) => async () => void this.acted.push(`${what} ${selector} on ${this.#url} in ${this.target}`);

    const click = async () => {
      await act("click")();
      const next = this.read(this.#url).goesTo?.[selector];

      if (next !== undefined) await this.goto(next);
    };

    return { first: () => ({ click, fill: act("fill"), press: act("press") }) };
  }

  context() {
    return { newCDPSession: async () => ({ send: async () => ({ data: btoa("png") }), detach: async () => undefined }) };
  }

  async title() {
    return this.read(this.#url).title;
  }

  async close() {
    this.closed = true;
    this.onClose();
  }
}

const FAILS: FakePage = { title: "fails", text: "" };

class FakeSession {
  alive = true;
  ended = false;
  cookies: Cookie[] = [];
  origins: StorageState["origins"] = [];
  readonly tabs: FakeTab[] = [];
  readonly restored: StorageState[] = [];
  readonly handoffs: Handoff[] = [];
  #tabs = 0;

  constructor(
    readonly id: string,
    readonly read: (url: string) => FakePage,
    readonly acted: string[]
  ) {}

  open(): FakeTab {
    const tab: FakeTab = new FakeTab(`${this.id}-target-${++this.#tabs}`, this.read, () => this.tabs.splice(this.tabs.indexOf(tab), 1), this.acted);
    this.tabs.push(tab);

    return tab;
  }

  /** What a user signing in through the live view leaves in the session. */
  signIn(cookies: Cookie[]): void {
    this.cookies.push(...cookies);
  }

  seat(): Seat {
    const live = () => {
      if (!this.alive) throw new Error("the session ended");
    };

    const handoffOf = (tab: BrowserTab) => this.handoffs.find((each) => each.target === (tab instanceof FakeTab ? tab.target : ""));

    return {
      newTab: async () => (live(), this.open()),
      lastTab: async () => this.tabs.at(-1),
      tab: async (target) => this.tabs.find((tab) => tab.target === target),
      handoff: async (tab, instructions) => {
        const target = tab instanceof FakeTab ? tab.target : "";
        this.handoffs.push({ target, instructions });

        return { target, handoff: `handoff-${target}` };
      },
      liveView: async (tab) => `https://live.browser.test/${tab instanceof FakeTab ? tab.target : ""}?mode=tab`,
      complete: async (tab, success) => {
        const handoff = handoffOf(tab);

        if (handoff) handoff.done = success;
      },
      record: async (tab) => {
        if (tab instanceof FakeTab) tab.recording = true;

        return tab instanceof FakeTab ? tab.history.length - 1 : 0;
      },
      recorded: async (tab) => {
        const history = tab instanceof FakeTab ? tab.history : [];

        return { logs: tab instanceof FakeTab ? tab.logs : [], history: { currentIndex: history.length - 1, entries: [...history] } };
      },
      storageState: async () => ({ cookies: [...this.cookies], origins: [...this.origins] }),
      restore: async (state) => {
        this.restored.push(state);
        this.cookies.push(...state.cookies);
      },
      end: async () => {
        this.alive = false;
        this.ended = true;
      },
      close: async () => undefined
    };
  }
}

export class FakeBrowsers implements Browsers {
  readonly pages = new Map<string, FakePage>();
  readonly kitesurfPages = new Map<string, FakePage | "fails">();
  readonly sessions = new Map<string, FakeSession>();
  /** Each click, fill and press a step made, as "click #pay on https://… in session-1-target-1", in any browser. */
  readonly acted: string[] = [];
  acquired = 0;
  kitesurfs = 0;

  readonly #read = (url: string) => this.pages.get(url) ?? BLANK;

  readonly kitesurf: Launch = async () => {
    this.kitesurfs += 1;

    const session = new FakeSession("kitesurf", (url) => {
      const page = this.kitesurfPages.get(url);

      return page === "fails" ? FAILS : (page ?? this.#read(url));
    }, this.acted);

    const browser: Browser = { newPage: async () => session.open(), close: async () => undefined };

    return browser;
  };

  async acquire(): Promise<string> {
    this.acquired += 1;
    const id = `session-${this.acquired}`;
    this.sessions.set(id, new FakeSession(id, this.#read, this.acted));

    return id;
  }

  async connect(session: string): Promise<Seat> {
    const found = this.sessions.get(session);

    if (!found?.alive) throw new Error(`Unable to connect to browser: code: 404: message: no session ${session}`);

    return found.seat();
  }
}

/** The one live Chromium session. */
export function liveSession(browsers: FakeBrowsers) {
  return [...browsers.sessions.values()].find((session) => session.alive);
}

/** Browser Run ends every session, as keep_alive running out does. */
export function killSessions(browsers: FakeBrowsers): void {
  for (const session of browsers.sessions.values()) session.alive = false;
}

/** The steps that acted in a session holding a login: one restored into it, or signed in there. */
export function actedSignedIn(browsers: FakeBrowsers): string[] {
  return browsers.acted.filter((act) => {
    const session = browsers.sessions.get(/ in (session-\d+)-target-\d+$/.exec(act)?.[1] ?? "");

    return session !== undefined && (session.cookies.length > 0 || session.restored.some((state) => state.cookies.length > 0));
  });
}
