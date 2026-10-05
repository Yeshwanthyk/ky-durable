import type { BrowserWorker } from "@cloudflare/playwright";

/**
 * A stand-in for the Browser Rendering binding, at the boundary: Playwright's
 * `launch()` gets a DevTools socket from it and speaks CDP over that socket.
 * The browser answers just enough CDP to connect, refuses to open pages, and,
 * like Kitesurf, takes `Browser.close` but leaves its socket open.
 */
export class FakeBrowser {
  /** How long a launch takes. */
  launchDelayMs = 0;
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
      server.accept();
      server.addEventListener("message", (event) => {
        const { id, method }: { id: number; method: string } = JSON.parse(String(event.data));

        if (method === "Browser.close") this.closes[index] = (this.closes[index] ?? 0) + 1;
        server.send(JSON.stringify(answer(id, method)));
      });

      return new Response(null, { status: 101, webSocket: client });
    }
  };
}

function answer(id: number, method: string) {
  if (method === "Browser.getVersion") {
    return {
      id,
      result: {
        protocolVersion: "1.3",
        product: "HeadlessChrome/140.0.0.0",
        revision: "0",
        userAgent: "Mozilla/5.0 HeadlessChrome/140.0.0.0",
        jsVersion: "14.0"
      }
    };
  }

  if (method === "Target.createBrowserContext" || method === "Target.createTarget") {
    return { id, error: { code: -32000, message: "the fake browser opens no pages" } };
  }

  return { id, result: {} };
}
