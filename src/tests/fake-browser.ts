import type { BrowserWorker } from "@cloudflare/playwright";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { parsed } from "./frames";

/**
 * A stand-in for the Browser Rendering binding, at the boundary: Playwright's
 * `launch()` gets a DevTools socket from it and speaks CDP over that socket.
 * The browser answers just enough CDP to connect and, like Kitesurf, takes
 * `Browser.close` but leaves its socket open. It refuses to open pages unless
 * `opensPages` is set; then it opens a blank page that navigates anywhere at
 * once and has nothing on it.
 */
export class FakeBrowser {
  /** How long a launch takes. */
  launchDelayMs = 0;
  /** Open pages instead of refusing them. */
  opensPages = false;
  /** Browsers asked for, and launched (their socket handed back). */
  requested = 0;
  launched = 0;
  /** `Browser.close` messages each launched browser got, in launch order. */
  readonly closes: number[] = [];

  readonly binding: BrowserWorker = {
    fetch: async (): Promise<Response> => {
      this.requested++;
      await new Promise((resolve) => setTimeout(resolve, this.launchDelayMs));
      const index = this.launched++;
      this.closes[index] = 0;
      const { 0: client, 1: server } = new WebSocketPair();
      const send = (message: CdpOut) => server.send(JSON.stringify(message));
      server.accept();

      server.addEventListener("message", (event) => {
        const message = cdpIn(String(event.data));

        if (message === undefined) return;

        if (message.method === "Browser.close") this.closes[index] = (this.closes[index] ?? 0) + 1;

        for (const out of this.opensPages ? pages(message) : refusing(message)) send(out);
      });

      return new Response(null, { status: 101, webSocket: client });
    }
  };
}

/** A CDP command from Playwright, by the fields this fake reads. */
const CdpIn = Type.Object({
  id: Type.Number(),
  method: Type.String(),
  sessionId: Type.Optional(Type.String()),
  params: Type.Optional(Type.Object({ url: Type.Optional(Type.String()), browserContextId: Type.Optional(Type.String()) }))
});

type CdpIn = Static<typeof CdpIn>;

type Payload = { [key: string]: JsonValue };

type CdpOut =
  | { id: number; sessionId?: string; result: Payload }
  | { id: number; error: { code: number; message: string } }
  | { method: string; sessionId?: string; params: Payload };

function cdpIn(data: string): CdpIn | undefined {
  const value = parsed(data);

  return Value.Check(CdpIn, value) ? value : undefined;
}

const VERSION = {
  protocolVersion: "1.3",
  product: "HeadlessChrome/140.0.0.0",
  revision: "0",
  userAgent: "Mozilla/5.0 HeadlessChrome/140.0.0.0",
  jsVersion: "14.0"
};

function reply(message: CdpIn, result: Payload): CdpOut {
  return message.sessionId ? { id: message.id, sessionId: message.sessionId, result } : { id: message.id, result };
}

function refusing(message: CdpIn): CdpOut[] {
  if (message.method === "Browser.getVersion") return [reply(message, VERSION)];

  if (message.method === "Target.createBrowserContext" || message.method === "Target.createTarget") {
    return [{ id: message.id, error: { code: -32000, message: "the fake browser opens no pages" } }];
  }

  return [reply(message, {})];
}

const PAGE = "page-1";

const SESSION = "session-1";

function frame(url: string, loaderId: string) {
  return {
    id: PAGE,
    loaderId,
    url,
    domainAndRegistry: "",
    securityOrigin: url === "about:blank" ? "://" : new URL(url).origin,
    mimeType: "text/html",
    secureContextType: "Secure",
    crossOriginIsolatedContextType: "NotIsolated",
    gatedAPIFeatures: []
  };
}

const event = (method: string, params: Payload): CdpOut => ({ method, sessionId: SESSION, params });

/** Chrome attaches to the new page before it answers, and Playwright looks the page up on the answer. */
function createTarget(message: CdpIn): CdpOut[] {
  return [
    {
      method: "Target.attachedToTarget",
      params: {
        sessionId: SESSION,
        targetInfo: {
          targetId: PAGE,
          type: "page",
          title: "",
          url: "about:blank",
          attached: true,
          canAccessOpener: false,
          browserContextId: message.params?.browserContextId ?? "context-1"
        },
        waitingForDebugger: true
      }
    },
    reply(message, { targetId: PAGE })
  ];
}

/** The page loads any URL at once, with nothing on it. */
function navigate(message: CdpIn): CdpOut[] {
  const url = message.params?.url ?? "about:blank";
  const at = Date.now() / 1000;

  return [
    reply(message, { frameId: PAGE, loaderId: "loader-1" }),
    event("Page.frameNavigated", { frame: frame(url, "loader-1"), type: "Navigation" }),
    ...["DOMContentLoaded", "load", "networkIdle"].map((name) =>
      event("Page.lifecycleEvent", { frameId: PAGE, loaderId: "loader-1", name, timestamp: at })
    )
  ];
}

/** What one blank page answers, by method; anything else gets an empty result. */
const PAGES = new Map<string, (message: CdpIn) => CdpOut[]>([
  ["Browser.getVersion", (message) => [reply(message, VERSION)]],
  ["Target.createBrowserContext", (message) => [reply(message, { browserContextId: "context-1" })]],
  ["Target.createTarget", createTarget],
  ["Page.getFrameTree", (message) => [reply(message, { frameTree: { frame: frame("about:blank", "loader-0"), childFrames: [] } })]],
  ["Page.createIsolatedWorld", (message) => [reply(message, { executionContextId: 2 })]],
  ["Page.addScriptToEvaluateOnNewDocument", (message) => [reply(message, { identifier: "1" })]],
  ["Page.navigate", navigate]
]);

function pages(message: CdpIn): CdpOut[] {
  return PAGES.get(message.method)?.(message) ?? [reply(message, {})];
}
