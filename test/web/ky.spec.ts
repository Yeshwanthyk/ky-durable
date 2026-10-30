import { expect, type Locator, type Page, test, type WebSocketRoute } from "@playwright/test";
import type { JsonValue } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { decodeServerFrame, parsed } from "../../src/tests/frames.ts";
import { ANTHROPIC_KEY } from "../fakes/vendors.ts";
import { machine as pairable } from "../harness/runner.ts";
import { accessCookie } from "../../src/tests/fake-access.ts";
import { REPO } from "../harness/stack.ts";
import { FIRST_FRAME_MS, GRACE_MS, PROBE_AFTER_SEND_MS, QUIET_MS, REPLY_MS, UNREACHABLE_AFTER_MS } from "../../src/connection.ts";

/**
 * One check per local web feature in FEATURES.md, through the real app in
 * Chromium. The stack's models are Workers AI's behind a fake AI binding
 * (src/tests/stack.ts): they echo, and `spawn`, `machine@webmac`, `gate` and `tool` prompts call
 * tools. The machine `webmac` is a real runner with the fake claude.
 */

/** A 1x1 PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Sign the browser in to the stack's fake Access, as Access's login leaves it: with its cookie. */
async function signIn(page: Page): Promise<void> {
  await page.context().addCookies([await accessCookie(process.env.KY_STACK_URL!)]);
}

/** What the Worker answers a request Access didn't sign in. */
const REFUSED = "Sign in to ky through Cloudflare Access.";

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });

const panel = (page: Page) => page.getByRole("complementary", { name: "Activity and settings" });

/** Opens the Skills page from the sidebar: the list on the left, the picked skill read on the right. */
const skillsPage = async (page: Page) => {
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Skills" }).click();

  return page.getByRole("region", { name: "Skills" });
};

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });

/** Where to save screenshots for a PR, when set. */
const SHOTS = process.env.KY_SHOTS;

async function open(page: Page, path = "/"): Promise<void> {
  await signIn(page);
  await page.goto(path);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** The stack's fake Executor (src/tests/stack.ts): its address, and the token it takes. */
const EXECUTOR = { url: "https://executor.test/mcp", token: "ky-stack-executor" };

/** Open Settings at its first page, then the rows that lead to a page, in order: `settings(page, "Models", "Worker")`. */
async function settings(page: Page, ...rows: string[]): Promise<void> {
  await panel(page).getByRole("tab", { name: "Settings" }).click();
  const back = panel(page).locator(".page-back");

  while (await back.isVisible()) await back.click();

  for (const row of rows) {
    const link = panel(page).getByRole("button", { name: new RegExp(`^${row}`) }).first();
    // Peers, Mail and Self-edits sit behind More on the first page.
    const more = panel(page).getByRole("button", { name: /^More/, expanded: false });

    if (!(await link.isVisible()) && (await more.isVisible())) await more.click();
    await link.click();
  }
}

/** Connect Executor in Settings › Tools, unless it is connected already. */
async function connectExecutor(page: Page): Promise<void> {
  await settings(page, "Tools");
  const form = panel(page).getByRole("form", { name: "Connect Executor" });
  const connected = panel(page).getByText(EXECUTOR.url, { exact: true });
  await expect(form.or(connected)).toBeVisible();

  if (await form.isVisible()) {
    await form.getByLabel("Executor URL").fill(EXECUTOR.url);
    await form.getByLabel("Executor token").fill(EXECUTOR.token);
    await form.getByRole("button", { name: "Test and connect" }).click();
  }

  await expect(connected).toBeVisible();
}

/** Open every gate tool started so far (src/tests/stack.ts). */
async function release(page: Page): Promise<void> {
  const response = await page.request.post("/test/release");
  expect(response.status()).toBe(204);
}

/** Bring the stack's Mac (its fake VibeProxy) online ("1"), take it away ("0"), or let it leave unnoticed ("leaves"). */
async function mac(page: Page, up: "1" | "0" | "leaves"): Promise<void> {
  await signIn(page);
  const response = await page.request.post(`/test/mac?up=${up}`);
  expect(response.status()).toBe(204);
}

/** Pick a purpose's model in Settings, by the purpose's label and the model's radio. */
async function pick(page: Page, purpose: string, model: RegExp): Promise<void> {
  await settings(page, "Models", purpose);
  const radio = panel(page).getByRole("radiogroup", { name: `${purpose} model` }).getByRole("radio", { name: model });
  await radio.click();
  await expect(radio).toHaveAttribute("aria-checked", "true");
  await settings(page);
}

/** A submit as the page sends it: the message, and how long it waited on the device, if it says. */
const Submit = Type.Object({ type: Type.Literal("submit"), id: Type.String(), operationId: Type.String(), input: Type.Unknown(), waited: Type.Optional(Type.Number()) });

type SubmitFrame = Static<typeof Submit>;

const Watching = Type.Object({ type: Type.Literal("watching"), watching: Type.Boolean() });

/** One socket the page opened: the session it asked for, the submits it sent, whether it said the user is looking, and the answers it got. */
type Connection = {
  session: string | null;
  submits: string[];
  /** The submits themselves, as sent. */
  frames: SubmitFrame[];
  watching: boolean[];
  results: Array<{ id: string; result: JsonValue }>;
  errors: string[];
  /** The liveness pings the page sent on it (src/connection.ts). */
  pings: number;
  /** When the page opened it. */
  at: number;
  /** Half-open: nothing gets through either way, and nothing closes. */
  frozen: boolean;
  route: WebSocketRoute;
};

/**
 * What the network does to the page's sockets:
 * - `loseSubmits`: lose the page's submits on the way in.
 * - `dropOnAnswer`: drop the socket just as a submit's answer comes back.
 * - `connect`: what a new socket meets. `refuse` closes it at once. `black-hole` accepts it, so the page
 *   sees it open, and never connects it to ky.
 * - `flapMs`: each socket that connects is closed this long after.
 * - `slowMs`: each frame, either way, arrives this much later, in order.
 * - `dropDown`: every other events frame on the way down is lost.
 */
type Faults = {
  loseSubmits: boolean;
  dropOnAnswer: boolean;
  connect: "refuse" | "black-hole" | null;
  flapMs: number;
  slowMs: number;
  dropDown: boolean;
};

/** Send in order, `slowMs` late: each frame keeps its place behind the one before it. */
function delayed(faults: Faults) {
  let last = 0;

  return (send: () => void) => {
    if (faults.slowMs === 0) return send();
    const at = Math.max(Date.now() + faults.slowMs, last);
    last = at;
    setTimeout(send, at - Date.now());
  };
}

/**
 * The network between the page and ky, seen frame by frame, with the faults
 * a bad network brings (Faults). `freeze(connection)` makes one half-open.
 */
async function network(page: Page) {
  const connections: Connection[] = [];
  const faults: Faults = { loseSubmits: false, dropOnAnswer: false, connect: null, flapMs: 0, slowMs: 0, dropDown: false };

  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (route) => {
    const connection: Connection = {
      session: new URL(route.url()).searchParams.get("session"),
      submits: [],
      frames: [],
      watching: [],
      results: [],
      errors: [],
      pings: 0,
      at: Date.now(),
      frozen: false,
      route
    };

    connections.push(connection);

    const note = (message: string | Buffer) => {
      const value = parsed(String(message));
      const submit = Value.Check(Submit, value) ? value : undefined;

      if (submit) connection.submits.push(submit.operationId);

      if (submit) connection.frames.push(submit);

      if (Value.Check(Watching, value)) connection.watching.push(value.watching);

      if (String(message) === "ping") connection.pings++;

      return submit;
    };

    if (faults.connect === "refuse") {
      void route.close();

      return;
    }

    if (faults.connect === "black-hole") {
      route.onMessage(note);

      return;
    }

    const server = route.connectToServer();
    const up = delayed(faults);
    const down = delayed(faults);
    let events = 0;

    if (faults.flapMs > 0) setTimeout(() => void route.close().catch(() => {}), faults.flapMs);

    route.onMessage((message) => {
      const submit = note(message);

      if ((submit && faults.loseSubmits) || connection.frozen) return;

      up(() => !connection.frozen && server.send(message));
    });

    server.onMessage((message) => {
      if (connection.frozen) return;
      const answered = record(connection, String(message));

      if (answered !== undefined && faults.dropOnAnswer && connection.submits.includes(answered)) {
        faults.dropOnAnswer = false;
        void route.close();

        return;
      }

      if (faults.dropDown && decodeServerFrame(String(message))?.type === "events" && events++ % 2 === 1) return;

      down(() => !connection.frozen && route.send(message));
    });
  });

  /** Take ky out of reach: the open sockets close, and new ones are refused until `online`. */
  const offline = async () => {
    faults.connect = "refuse";

    for (const connection of connections) await connection.route.close().catch(() => {});
    await expect(page.getByRole("button", { name: /^ky: Connected/ })).toHaveCount(0);
  };

  const online = async () => {
    faults.connect = null;
    await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible({ timeout: 30_000 });
  };

  /** Every submit the page sent, on every socket, by operation id. */
  const submitted = () => connections.flatMap((connection) => connection.frames);

  return { connections, faults, offline, online, submitted, freeze: (connection: Connection) => (connection.frozen = true) };
}

/** The pill, saying how ky is connected: "Connected", "Offline", "Can't reach ky"… */
const pill = (page: Page, label: string) => page.getByRole("button", { name: new RegExp(`^ky: ${label}`) });

/** A submit's answer when pi took the message, rather than dropping a copy it already had. */
const Accepted = Type.Object({ operationId: Type.String(), accepted: Type.Literal(true) });

/** The operation ids ky accepted across every socket: each message the user sent should be here once. */
function accepted(connections: readonly Connection[]): string[] {
  return connections.flatMap((connection) =>
    connection.results.flatMap(({ result }) => (Value.Check(Accepted, result) ? [result.operationId] : []))
  );
}

/** Send `text` and expect ky to take it once and the thread to show it, and its echo, once each. */
async function deliveredOnce(page: Page, connections: readonly Connection[], text: string): Promise<void> {
  await expect(page.getByText(`echo: ${text}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`echo: ${text}`)).toHaveCount(1);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  const ids = new Set(connections.flatMap((connection) => connection.submits));
  const taken = accepted(connections).filter((id) => ids.has(id));
  expect(taken.length, `ky accepted ${taken.join(", ")}`).toBe(new Set(taken).size);
}

/** Note a result or a refusal from ky on its connection; the id of the command a result answers. */
function record(connection: Connection, message: string): string | undefined {
  const frame = decodeServerFrame(message);

  if (frame?.type === "error" && frame.id !== undefined) connection.errors.push(frame.id);

  if (frame?.type !== "result") return undefined;
  connection.results.push({ id: frame.id, result: frame.result });

  return frame.id;
}

test("shows nothing of ky without Access's sign-in, even with a forged email header, but loads the manifest and icons", async ({ page }) => {
  const forged: Array<Record<string, string>> = [{}, { "Cf-Access-Authenticated-User-Email": "owner@ky.test" }];

  for (const headers of forged) {
    const response = await page.request.get("/", { headers, maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(await response.text()).toBe(REFUSED);
  }

  await page.goto("/");
  await expect(page.getByText(REFUSED)).toBeVisible();
  await expect(composer(page)).toHaveCount(0);

  expect((await page.request.get("/manifest.webmanifest")).status()).toBe(200);
  expect((await page.request.get("/icons/icon-192.png")).headers()["content-type"]).toBe("image/png");
});

test("says Signed out when the socket drops after the sign-in lapses, keeps the draft, and Sign in goes to Access's sign-in", async ({ page }) => {
  const closers: Array<() => Promise<void>> = [];

  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (socket) => {
    const server = socket.connectToServer();
    closers.push(() => socket.close());
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
  });

  await open(page);
  await composer(page).fill("a draft the sign-in mustn't eat");
  await page.context().clearCookies();
  await closers.at(-1)!();

  // Nothing reloads under the user: the pill says why, and the draft stays.
  await expect(page.getByRole("button", { name: /^ky: Signed out/ })).toBeVisible();
  await expect(composer(page)).toHaveValue("a draft the sign-in mustn't eat");

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(REFUSED)).toBeVisible();
});

// First, while the main chat is still empty.
test("walks a new ky through setup from the main chat's first-run cards", async ({ page }) => {
  await open(page);
  const cards = chat(page).getByRole("list", { name: "Set up ky" });
  await expect(cards).toBeVisible();
  await expect(chat(page).getByRole("button", { name: "What's connected" })).toHaveCount(0);

  await cards.getByRole("button", { name: /Add a machine/ }).click();
  await expect(panel(page).getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).locator("#settings-machines")).toBeInViewport();

  await cards.getByRole("button", { name: /Add Claude for machines/ }).click();
  await expect(panel(page).locator("#settings-subscriptions")).toBeInViewport();

  await cards.getByRole("button", { name: /Connect Executor/ }).click();
  const form = panel(page).getByRole("form", { name: "Connect Executor" });
  await expect(form).toBeInViewport();
  await form.getByLabel("Executor URL").fill(EXECUTOR.url);
  await form.getByLabel("Executor token").fill("not-the-token");
  await form.getByRole("button", { name: "Test and connect" }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Executor refused that token.");
  await connectExecutor(page);
  await expect(cards.getByRole("button", { name: /Connect Executor/ })).toHaveAttribute("data-done", "true");

  // Edit changes the URL and keeps the token when it is left blank; Edit again puts it back.
  for (const url of [`${EXECUTOR.url}?elicitation_mode=browser`, EXECUTOR.url]) {
    await panel(page).locator("#settings-executor").getByRole("button", { name: "Edit" }).click();
    const edit = panel(page).getByRole("form", { name: "Edit Executor" });
    await expect(edit.getByLabel("Executor token")).toHaveValue("");
    await edit.getByLabel("Executor URL").fill(url);
    await edit.getByRole("button", { name: "Test and connect" }).click();
    await expect(panel(page).getByText(url, { exact: true })).toBeVisible();
  }

  await expect(chat(page).getByRole("button", { name: "What's connected" })).toBeVisible();

  await cards.getByRole("button", { name: /Tell ky who you are/ }).click();
  await expect(chat(page).getByText(/^Interview me so you know who I am/).first()).toBeVisible();
});

test("streams the answer to a message", async ({ page }) => {
  await open(page);
  await send(page, "hello from the browser");
  await expect(page.getByText("echo: hello from the browser")).toBeVisible();
});

test("draws a mermaid fence in ky's answer as a diagram, and one pele can't read as its code", async ({ page }) => {
  await open(page);
  await send(page, "reply: The plan:\n\n```mermaid\nflowchart LR\n  Ask --> Draft --> Ship\n```");

  const diagram = chat(page).getByRole("img", { name: "Diagram" });
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram.getByText("Draft")).toBeVisible();
  await expect(chat(page).locator("pre").filter({ hasText: "flowchart LR" })).toHaveCount(0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/diagram.png` });

  await send(page, "reply: Broken:\n\n```mermaid\nflowchart LR\n  A -->\n```");
  await expect(chat(page).getByText("Broken:")).toBeVisible();
  await expect(chat(page).locator("pre").filter({ hasText: "A -->" })).toBeVisible();
});

test("previews bloubs in the chat, saves one as ky's avatar, and it answers a poke", async ({ page }) => {
  await open(page);
  const pip = { name: "Pip", body: { w: 108, h: 108, corner: 54, color: "#3d8bff" }, eyes: { count: 2, size: 15 }, top: { kind: "leaf", color: "#3cc46a" }, cheeks: true, feet: true };
  const tok = { name: "Tok", body: { w: 104, h: 112, corner: 18, color: "#a78bfa" }, eyes: { count: 1, size: 22 }, top: { kind: "antenna", color: "#ffd166" }, cheeks: false, feet: true };
  await send(page, `tool avatar ${JSON.stringify({ action: "preview", specs: [pip, tok] })}`);
  await expect(page.getByRole("img", { name: "Pip" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Tok" })).toBeVisible();
  await page.screenshot({ path: "test-results/web/bloubs-preview.png" });

  await send(page, `tool avatar ${JSON.stringify({ action: "set", for: "ky", spec: pip })}`);
  await expect(page.getByText("Saved as ky's avatar.")).toBeVisible();
  // ky's avatar in the panel, not the preview of it up the chat.
  const avatar = panel(page).getByRole("img", { name: "ky", exact: true });
  await avatar.hover();
  await avatar.click();
  await expect(avatar.locator(`path[fill="#ff5d8f"]`)).not.toHaveCount(0);
  await page.screenshot({ path: "test-results/web/bloubs-saved.png" });

  // Shared stack: put ky back as it was.
  await send(page, `tool avatar ${JSON.stringify({ action: "clear", for: "ky" })}`);
  await expect(page.getByText("ky looks as before again.")).toBeVisible();
});

test("steers a running turn with a message sent while it works", async ({ page }) => {
  await open(page);
  await send(page, "gate");
  await expect(composer(page)).toHaveAttribute("placeholder", "Steer the running turn");

  await send(page, "steer in the browser");
  await release(page);
  await expect(page.getByText("echo: steer in the browser")).toBeVisible();
});

test("stops a running turn", async ({ page }) => {
  await open(page);
  await send(page, "gate");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(composer(page)).toHaveAttribute("placeholder", "Message ky");
  await release(page);
});

test("brings back what was sent with ↑ in an empty composer, and ↓ returns to empty", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page.getByRole("heading", { name: "A side chat" })).toBeVisible();
  await send(page, "first thing I said");
  await expect(page.getByText("echo: first thing I said")).toBeVisible();
  await send(page, "second thing I said");
  await expect(page.getByText("echo: second thing I said")).toBeVisible();

  await composer(page).press("ArrowUp");
  await expect(composer(page)).toHaveValue("second thing I said");
  await composer(page).press("ArrowUp");
  await expect(composer(page)).toHaveValue("first thing I said");
  await composer(page).press("ArrowDown");
  await expect(composer(page)).toHaveValue("second thing I said");
  await composer(page).press("ArrowDown");
  await expect(composer(page)).toHaveValue("");

  // A draft keeps ↑ for moving the caret.
  await composer(page).fill("a draft");
  await composer(page).press("ArrowUp");
  await expect(composer(page)).toHaveValue("a draft");
});

test("offers a way back to the latest message once the user scrolls up, and glides there", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page.getByRole("heading", { name: "A side chat" })).toBeVisible();
  await send(page, `reply: ${Array.from({ length: 40 }, (_, line) => `Line ${line + 1}`).join("\n\n")}`);
  await expect(page.getByText("Line 40", { exact: true })).toBeVisible();

  const latest = page.getByRole("button", { name: "Jump to latest" });
  await expect(latest).toBeHidden();

  await page.locator(".thread").evaluate((thread) => thread.scrollTo({ top: 0 }));
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(page.getByText("Line 40", { exact: true })).toBeInViewport();
  await expect(latest).toBeHidden();
});

test("starts a side chat, names it from its first message, and goes back to the main chat", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await expect(page.getByRole("heading", { name: "A side chat" })).toBeVisible();

  await send(page, "Plan a trip to Lisbon");
  await expect(page.getByText("echo: Plan a trip to Lisbon")).toBeVisible();
  await expect(chats.getByRole("button", { name: /^Named: Plan a trip to Lisbon/ })).toBeVisible();

  await chats.getByRole("button", { name: "Main chat" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("echo: Plan a trip to Lisbon")).toBeHidden();

  await chats.getByRole("button", { name: /^Named: Plan a trip to Lisbon/ }).click();
  await expect(page.getByText("echo: Plan a trip to Lisbon")).toBeVisible();
});

test("the main chat opens a side chat, steers it, and the side chat shows the main chat's messages as from it, not the user", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await send(page, `tool chats ${JSON.stringify({ action: "create", title: "Lisbon trains", message: "reply: Trains to Lisbon leave at 9." })}`);
  const said = chat(page).getByText(/^tool said: Opened chat (\d+); its agent answers there/);
  await expect(said).toBeVisible();
  const side = /Opened chat (\d+);/.exec((await said.textContent()) ?? "")![1]!;

  await send(page, `tool chats ${JSON.stringify({ action: "steer", chat: side, message: "reply: And back at 6." })}`);
  await expect(chat(page).getByText('tool said: Steered "Lisbon trains"; its agent answers there.')).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chats-run-main.png` });

  await chats.getByRole("button", { name: /^Lisbon trains/ }).click();
  await expect(page).toHaveURL(new RegExp(`session=${side}`));
  await expect(chat(page).getByText("Trains to Lisbon leave at 9.", { exact: true })).toBeVisible();
  await expect(chat(page).getByText("And back at 6.", { exact: true })).toBeVisible();
  // Each message from the main chat reads as one quiet line from it, never as the user's bubble with its header.
  await expect(chat(page).getByRole("button", { name: /From\s*main chat/ })).toHaveCount(2);
  await expect(chat(page).getByText(/\[chat "main chat"/)).toHaveCount(0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chats-run-side.png` });

  // The side chat the main chat opened runs no chats of its own.
  await send(page, `tool chats ${JSON.stringify({ action: "inspect" })}`);
  await expect(chat(page).getByText("tool said: Another chat opened this one, so this one runs none: answer here.")).toBeVisible();
});

test("renames a side chat in the sidebar, and Escape keeps the old name", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  const name = `Errands ${crypto.randomUUID().slice(0, 8)}`;
  await send(page, name);
  await expect(page.getByText(`echo: ${name}`)).toBeVisible();

  await chats.getByRole("button", { name: new RegExp(`^Rename Named: ${name}`) }).click();
  await chats.getByRole("textbox", { name: "Chat name" }).fill(`${name} renamed`);
  await page.keyboard.press("Enter");
  await expect(chats.getByRole("button", { name: new RegExp(`^${name} renamed`) }).first()).toBeVisible();

  await chats.getByRole("button", { name: `Rename ${name} renamed` }).click();
  await chats.getByRole("textbox", { name: "Chat name" }).fill("not this");
  await page.keyboard.press("Escape");
  await expect(chats.getByRole("textbox", { name: "Chat name" })).toBeHidden();

  await page.reload();
  await expect(chats.getByRole("button", { name: new RegExp(`^${name} renamed`) }).first()).toBeVisible();
});

test("shows queued messages' words, and takes one back to edit or deletes it", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await send(page, "gate");
  await expect(composer(page)).toHaveAttribute("placeholder", "Steer the running turn");

  await send(page, "first queued thing");
  await send(page, "second queued thing");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("first queued thing")).toBeVisible();
  await expect(queue.getByText("second queued thing")).toBeVisible();

  await queue.getByRole("button", { name: "Delete queued message: first queued thing" }).click();
  await expect(queue.getByText("first queued thing")).toBeHidden();
  await queue.getByRole("button", { name: "Edit queued message: second queued thing" }).click();
  await expect(queue).toBeHidden();
  await expect(composer(page)).toHaveValue("second queued thing");

  await release(page);
  await expect(page.getByText("tool said: released")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat" }).getByText("first queued thing")).toBeHidden();
});

test("ky's card takes taps: the chosen options go as the user's next message, and the card keeps them", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  const ui = {
    title: "Subscriptions",
    icon: "gmail",
    wait: true,
    blocks: [
      { type: "text", text: "I found four senders you never open." },
      {
        type: "choice",
        label: "Which should I unsubscribe you from?",
        multiple: true,
        options: [{ label: "Lyft" }, { label: "Audible Canada", detail: "12 this month" }, { label: "Pinterest" }, { label: "Affirm" }]
      }
    ]
  };

  await send(page, `tool ui ${JSON.stringify(ui)}`);

  const card = chat(page).getByRole("region", { name: "Subscriptions" });
  await expect(card.getByText("Choose all that apply")).toBeVisible();
  const submit = card.getByRole("button", { name: "Send" });
  await expect(submit).toBeDisabled();
  await card.getByRole("button", { name: /Audible Canada/ }).click();
  await card.getByRole("button", { name: /Affirm/ }).click();
  await expect(card.getByRole("button", { name: /Affirm/ })).toHaveAttribute("aria-pressed", "true");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-choice.png` });
  await submit.click();

  await expect(chat(page).getByText("echo: Audible Canada, Affirm")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send" })).toBeHidden();
  await expect(card.getByRole("button", { name: /Audible Canada/ })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("button", { name: /Lyft/ })).toBeDisabled();
});

test("ky's card keeps what was chosen through a reload, labels with commas and all", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  const ui = {
    title: "Pick times",
    wait: true,
    blocks: [
      { type: "choice", label: "Which work?", multiple: true, options: [{ label: "Tue, 10am" }, { label: "Wed, 2pm" }, { label: "Thu, 9am" }] },
      { type: "input", label: "Anything else?", multiline: true }
    ]
  };

  await send(page, `tool ui ${JSON.stringify(ui)}`);

  const card = chat(page).getByRole("region", { name: "Pick times" });

  await card.getByRole("button", { name: /Tue, 10am/ }).click();
  await card.getByRole("button", { name: /Thu, 9am/ }).click();
  await card.getByRole("textbox").fill("Not before 9");
  await card.getByRole("button", { name: "Send" }).click();
  await expect(chat(page).getByText(/echo: Which work\?: Tue, 10am, Thu, 9am/)).toBeVisible();

  await page.reload();

  const again = chat(page).getByRole("region", { name: "Pick times" });

  await expect(again.getByRole("button", { name: /Tue, 10am/ })).toHaveAttribute("aria-pressed", "true");
  await expect(again.getByRole("button", { name: /Thu, 9am/ })).toHaveAttribute("aria-pressed", "true");
  await expect(again.getByRole("button", { name: /Wed, 2pm/ })).toHaveAttribute("aria-pressed", "false");
  await expect(again.getByText("Not before 9")).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-answer-kept.png` });
});

test("ky's card with an id updates where it first showed, and the later turn notes the update", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  const plan = (status: string, done: number) => ({
    id: "trip",
    title: "Lisbon trip",
    blocks: [
      { type: "status", text: status, tone: done === 3 ? "success" : "info" },
      { type: "stats", items: [{ value: `${done}/3`, label: "booked" }] }
    ]
  });

  await send(page, `tool ui ${JSON.stringify(plan("Booking flights", 1))}`);
  await expect(chat(page).getByRole("region", { name: "Lisbon trip" })).toContainText("Booking flights");
  await send(page, `tool ui ${JSON.stringify(plan("All booked", 3))}`);

  const event = chat(page).locator(".turn-event", { hasText: "Lisbon trip" });

  await expect(event).toContainText("Updated");
  const card = chat(page).getByRole("region", { name: "Lisbon trip" });

  await expect(card).toHaveCount(1);
  await expect(card).toContainText("All booked");
  await expect(card).not.toContainText("Booking flights");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-living-card.png` });
});

test("ky's card draws as its call streams, and takes taps once it is done", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  const ui = {
    title: "Lisbon trip",
    blocks: [
      { type: "status", text: "Flights and the hotel are held until Friday noon", tone: "info" },
      { type: "list", items: [{ title: "TAP 1234 · SFO → LIS", meta: "Thu 6:40 PM" }, { title: "Memmo Alfama", meta: "3 nights" }, { title: "TAP 1235 · LIS → SFO", meta: "Mon 11:15 AM" }] },
      { type: "choice", label: "Book them?", options: [{ label: "Book all" }, { label: "Not yet" }] }
    ]
  };

  await send(page, `slowly tool ui ${JSON.stringify(ui)}`);
  const card = chat(page).getByRole("region", { name: "Lisbon trip" });

  // The card shows while its arguments are still arriving: what has come so far, with nothing to tap yet.
  await expect(card).toHaveAttribute("aria-busy", "true");
  await expect(card).toContainText("Memmo Alfama");
  await expect(card.locator("button:enabled")).toHaveCount(0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-drafting.png` });

  await expect(card).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(card.getByRole("button", { name: "Book all" })).toBeEnabled();
  await expect(chat(page).getByRole("region", { name: "Lisbon trip" })).toHaveCount(1);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-drafted.png` });
});

test("ky's card shows an image, and a tap opens it full size", async ({ page }) => {
  // A 1×1 PNG, served for the https address the card names, so the test never leaves the stack.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await page.route("https://images.example/chart.png", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await open(page);
  const ui = { title: "This week", blocks: [{ type: "image", src: "https://images.example/chart.png", caption: "Steps per day" }] };
  await send(page, `tool ui ${JSON.stringify(ui)}`);

  const card = chat(page).getByRole("region", { name: "This week" });
  const image = card.getByRole("img", { name: "Steps per day" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  await expect(card.getByText("Steps per day", { exact: true })).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-image.png` });

  await card.getByRole("button", { name: "Open Steps per day" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("ky's card draws data from its numbers: headline stats, a stacked bar chart, and tabs beside it", async ({ page }) => {
  await open(page);

  const ky = { type: "table", columns: ["PR", "Title", "Merged"], rows: [["#107", "Token page asks for mail permissions", "Oct 17"], ["#145", "Mermaid fences draw as diagrams", "Oct 19"]] };

  const ui = {
    title: "Your PRs, last 3 days",
    subtitle: "Oct 17–19 · GitHub",
    icon: "github",
    blocks: [
      { type: "stats", items: [{ value: 53, label: "PRs" }, { value: 41, label: "ky-durable", series: 1 }, { value: 12, label: "scotty", series: 2 }, { value: "52", label: "merged · 1 draft", tone: "success" }] },
      {
        type: "columns",
        columns: [
          [{ type: "chart", kind: "bar", stacked: true, label: "By day", x: ["Fri 17", "Sat 18", "Sun 19"], series: [{ name: "ky", values: [17, 21, 3] }, { name: "scotty", values: [4, 4, 4] }] }],
          [{ type: "tabs", tabs: [{ label: "ky · 41", blocks: [ky] }, { label: "scotty · 12", blocks: [{ type: "list", items: [{ title: "Sidebar keeps its width", meta: "#88" }] }] }] }]
        ]
      },
      { type: "chart", kind: "line", label: "Merged per day, two weeks", x: Array.from({ length: 14 }, (_, day) => `Oct ${day + 6}`), series: [{ name: "merged", values: [3, 5, 2, 8, 6, 9, 4, 7, 11, 6, 9, 21, 25, 7] }] }
    ]
  };

  await send(page, `tool ui ${JSON.stringify(ui)}`);

  const card = chat(page).getByRole("region", { name: "Your PRs, last 3 days" });
  await expect(card.getByText("Oct 17–19 · GitHub")).toBeVisible();
  await expect(card.locator(".ui-stats dd").first()).toHaveText("53");
  await expect(card.getByRole("row", { name: /Sat 18/ })).toContainText("25");
  await expect(card.getByRole("tab", { name: "ky · 41" })).toHaveAttribute("aria-selected", "true");
  await expect(card.getByRole("cell", { name: "Mermaid fences draw as diagrams" })).toBeVisible();
  await expect(card.getByRole("img", { name: "Merged per day, two weeks" })).toBeVisible();

  if (SHOTS) await card.screenshot({ path: `${SHOTS}/ui-data.png` });

  await card.getByRole("tab", { name: "scotty · 12" }).click();
  await expect(card.getByText("Sidebar keeps its width")).toBeVisible();
  await expect(card.getByRole("cell", { name: "Mermaid fences draw as diagrams" })).toBeHidden();
});

test("ky's card shows a page it published, sized to the page, with a link to open it full size", async ({ page }) => {
  await open(page);
  const html = '<!doctype html><html><body style="margin:0"><div style="height:640px;background:#e8eef7">Tall report</div></body></html>';
  await send(page, `tool site ${JSON.stringify({ action: "publish", title: "Report", html })}`);
  const said = chat(page).locator("p", { hasText: /\(id [0-9a-f]{32},/ });
  await expect(said).toBeVisible();
  const id = /id ([0-9a-f]{32})/.exec(await said.innerText())?.[1] ?? "";

  await send(page, `tool ui ${JSON.stringify({ title: "Weekly report", blocks: [{ type: "page", site: id, title: "Report" }] })}`);
  const card = chat(page).getByRole("region", { name: "Weekly report" });
  const frame = card.locator('iframe[title="Report"]');
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  await expect(card.frameLocator("iframe").getByText("Tall report")).toBeVisible();
  await expect.poll(() => frame.evaluate((element) => element.getBoundingClientRect().height)).toBe(640);
  await expect(card.getByRole("link", { name: "Open Report" })).toHaveAttribute("href", `/s/${id}/`);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-page.png` });
});

test("a page in ky's card wears the chat's theme and follows it to dark", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  const html = '<!doctype html><p id="ink" style="color:var(--foreground)">Themed</p>';
  await send(page, `tool site ${JSON.stringify({ action: "publish", title: "Themed", html })}`);
  const said = chat(page).locator("p", { hasText: /\(id [0-9a-f]{32},/ });
  await expect(said).toBeVisible();
  const id = /id ([0-9a-f]{32})/.exec(await said.innerText())?.[1] ?? "";

  await send(page, `tool ui ${JSON.stringify({ title: "Themed page", blocks: [{ type: "page", site: id, title: "Themed" }] })}`);
  const ink = chat(page).getByRole("region", { name: "Themed page" }).frameLocator("iframe").locator("#ink");
  await expect(ink).toHaveCSS("color", "rgb(20, 20, 20)");

  await page.evaluate(() => {
    document.documentElement.dataset.mode = "dark";
  });
  await expect(ink).toHaveCSS("color", "rgb(237, 237, 237)");
});

test("ky's card asks for a word: typed and ticked, it goes as the user's next message", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  const ui = { wait: true, blocks: [{ type: "input", label: "What would you like to call me?", placeholder: "A name" }] };
  await send(page, `tool ui ${JSON.stringify(ui)}`);

  const card = chat(page).getByRole("region", { name: "What would you like to call me?" });
  await card.getByRole("textbox", { name: "What would you like to call me?" }).fill("Lumi");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-input.png` });
  await card.getByRole("button", { name: "Send answer" }).click();

  await expect(chat(page).getByText("echo: Lumi")).toBeVisible();
  await expect(card.getByRole("textbox")).toBeHidden();
});

test("a routine ky made shows as one quiet line under its answer, and a card's small print under the card", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  const title = `Nightly roundup ${crypto.randomUUID().slice(0, 8)}`;
  await send(page, `tool automation ${JSON.stringify({ action: "create", title, prompt: "gather the day's likes", cron: "0 1 * * *", createdBy: "user" })}`);

  const event = chat(page).locator(".turn-event", { hasText: title });
  await expect(event).toContainText("Created routine");

  const ui = { title: "Connect X", icon: "x", note: "ky asks before it changes anything.", blocks: [{ type: "buttons", buttons: [{ label: "Authorize", url: "https://example.com/auth" }] }] };
  await send(page, `tool ui ${JSON.stringify(ui)}`);
  await expect(chat(page).getByRole("link", { name: "Authorize" })).toHaveAttribute("href", "https://example.com/auth");
  await expect(chat(page).locator(".ui-note")).toHaveText("ky asks before it changes anything.");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/event-note.png` });
});

test("a routine's posted card can ask: a tap answers it in the chat, as the user's next message", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  const title = `Morning forecast ${crypto.randomUUID().slice(0, 8)}`;

  const ui = {
    title: "Rain at 4pm",
    blocks: [
      { type: "stats", items: [{ value: "80%", label: "chance" }] },
      { type: "choice", label: "Pack an umbrella?", options: [{ label: "Yes, remind me" }, { label: "No" }] }
    ]
  };

  await send(page, `tool automation ${JSON.stringify({ action: "create", title, prompt: `tool ui ${JSON.stringify(ui)}`, cron: "0 7 * * *", post: true, createdBy: "user" })}`);

  const id = /Created automation (\w+),/.exec((await chat(page).getByText(/tool said: Created automation/).textContent()) ?? "")?.[1] ?? "";

  await send(page, `tool automation ${JSON.stringify({ action: "run", id })}`);

  const card = chat(page).getByRole("region", { name: "Rain at 4pm" });

  await expect(card.getByRole("button", { name: /Yes, remind me/ })).toBeEnabled({ timeout: 30_000 });

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/post-asks.png` });

  await card.getByRole("button", { name: /Yes, remind me/ }).click();

  await expect(chat(page).getByText("echo: Yes, remind me")).toBeVisible();
  await expect(card.getByRole("button", { name: /Yes, remind me/ })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("button", { name: "No", exact: true })).toBeDisabled();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/post-asks-answered.png` });
});

test("ky's card shows a routine as it is now: pausing it from the card changes the card", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  const title = `Weekly review ${crypto.randomUUID().slice(0, 8)}`;

  await send(page, `tool automation ${JSON.stringify({ action: "create", title, prompt: "review the week", cron: "0 16 * * 5", createdBy: "user" })}`);

  const id = /Created automation (\w+),/.exec((await chat(page).getByText(/tool said: Created automation/).textContent()) ?? "")?.[1] ?? "";

  await send(page, `tool ui ${JSON.stringify({ title: "Your new routine", blocks: [{ type: "routine", routine: id }, { type: "routine", routine: "gone123" }] })}`);

  const card = chat(page).getByRole("region", { name: "Your new routine" });
  const row = card.getByLabel(title);

  await expect(row).toContainText("Weekly");
  await expect(card.getByText("That routine is gone.")).toBeVisible();
  await expect(composer(page)).toHaveAttribute("placeholder", "Message ky");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-routine.png` });

  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row).toContainText("Paused");
  await panel(page).getByRole("tab", { name: "Activity" }).click();
  await panel(page).getByRole("button", { name: /routines?$/i }).click();
  await expect(panel(page).getByRole("listitem", { name: title })).toContainText("Paused");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-routine-paused.png` });
});

test("steers the queue in now: the step ky waits on stops and the queued message goes in", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await send(page, "gate");
  await expect(composer(page)).toHaveAttribute("placeholder", "Steer the running turn");

  await send(page, "steer this in now");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("steer this in now")).toBeVisible();
  await queue.getByRole("button", { name: "Steer now" }).click();

  await expect(page.getByText("echo: steer this in now")).toBeVisible();
  await expect(queue).toBeHidden();
  await expect(page.getByText("tool said: released")).toBeHidden();
  await release(page);
});

test("gives queued messages back to the composer when the turn is stopped", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await send(page, "gate");
  await expect(composer(page)).toHaveAttribute("placeholder", "Steer the running turn");

  await send(page, "first kept thing");
  await send(page, "second kept thing");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("second kept thing")).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  await expect(queue).toBeHidden();
  await expect(composer(page)).toHaveValue("first kept thing\n\nsecond kept thing");
  await release(page);
});

test("marks a side chat that ky answered while the user was in another chat, until it is opened", async ({ page }) => {
  await open(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await send(page, "gate");
  await expect(composer(page)).toHaveAttribute("placeholder", "Steer the running turn");
  const side = chats.locator("li", { has: page.getByRole("button", { name: /gate/ }) });
  await expect(side.getByRole("img", { name: "New" })).toBeHidden();

  // The answer lands while the user reads the main chat.
  await chats.getByRole("button", { name: "Main chat" }).click();
  await release(page);
  await expect(side.getByRole("img", { name: "New" })).toBeVisible();

  await side.getByRole("button", { name: /gate/ }).first().click();
  await expect(side.getByRole("img", { name: "New" })).toBeHidden();
  // In the chat, New marks where the answer that landed while away starts.
  const divider = chat(page).getByRole("separator", { name: "New since you last looked" });
  await expect(divider).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-divider.png` });
  await chats.getByRole("button", { name: "Main chat" }).click();
  await expect(side.getByRole("img", { name: "New" })).toBeHidden();

  // Seen, it is not news the next time.
  await side.getByRole("button", { name: /gate/ }).first().click();
  await expect(chat(page).getByText("tool said:").first()).toBeVisible();
  await expect(divider).toBeHidden();
});

test("picks a purpose's model in settings and keeps it after a reload, with VibeProxy off", async ({ page }) => {
  await open(page);
  await settings(page, "Models");
  await expect(panel(page).getByRole("button", { name: /^Main agent/ })).toContainText("Glm 5.3 Flash · Workers AI");
  await panel(page).getByRole("button", { name: /^Background/ }).click();
  await panel(page).getByRole("radiogroup", { name: "Background model" }).getByRole("radio", { name: /^GPT OSS 120B/ }).click();
  await settings(page, "Models");
  await expect(panel(page).getByRole("button", { name: /^Background/ })).toContainText("GPT OSS 120B");
  await settings(page, "Providers");
  await expect(panel(page).getByRole("listitem").filter({ hasText: "VibeProxy" })).toContainText("Off");

  await page.reload();
  await settings(page, "Models");
  await expect(panel(page).getByRole("button", { name: /^Background/ })).toContainText("GPT OSS 120B");

  // Put it back for the other tests.
  await panel(page).getByRole("button", { name: /^Background/ }).click();
  await panel(page).getByRole("radiogroup", { name: "Background model" }).getByRole("radio", { name: /^Glm 5.3 Flash/ }).click();
  await settings(page, "Models");
  await expect(panel(page).getByRole("button", { name: /^Background/ })).not.toContainText("GPT OSS 120B");
});

test("lists VibeProxy's featured Claude models, and the rest of the catalog behind Show all", async ({ page }) => {
  await mac(page, "1");
  await open(page);
  await settings(page, "Models", "Main agent");
  const models = panel(page).getByRole("radiogroup", { name: "Main agent model" });
  await expect(models.getByRole("radio", { name: /^Claude Opus 5\.5/ })).toBeVisible();
  await expect(models.getByRole("radio", { name: /^Claude Sonnet 4\.6/ })).toBeHidden();

  await models.getByRole("button", { name: /^Show all models/ }).click();
  await models.getByRole("radio", { name: /^Claude Sonnet 4\.6/ }).click();
  await expect(models.getByRole("radio", { name: /^Claude Sonnet 4\.6/ })).toHaveAttribute("aria-checked", "true");

  // After a reload the chosen model shows with the list folded.
  await page.reload();
  await settings(page, "Models", "Main agent");
  await expect(models.getByRole("button", { name: /^Show all models/ })).toBeVisible();
  await expect(models.getByRole("radio", { name: /^Claude Sonnet 4\.6/ })).toHaveAttribute("aria-checked", "true");

  // Put it back for the other tests.
  await settings(page);
  await pick(page, "Main agent", /^Glm 5.3 Flash/);
  await mac(page, "0");
});

test("sets ky's repo for self-edits in Settings and keeps it after a reload", async ({ page }) => {
  await open(page);
  await settings(page, "Self-edits");

  try {
    await panel(page).getByRole("button", { name: "Not set" }).click();
    await panel(page).getByRole("textbox", { name: "ky's GitHub repo" }).fill("test-owner/test-repo");
    await panel(page).getByRole("textbox", { name: "ky's GitHub repo" }).press("Enter");
    await expect(panel(page).getByRole("button", { name: "test-owner/test-repo" })).toBeVisible();

    await page.reload();
    await settings(page, "Self-edits");
    await expect(panel(page).getByRole("button", { name: "test-owner/test-repo" })).toBeVisible();
  } finally {
    // Clear it for the other tests.
    await panel(page).getByRole("button", { name: "test-owner/test-repo" }).click();
    await panel(page).getByRole("textbox", { name: "ky's GitHub repo" }).fill("");
    await panel(page).getByRole("textbox", { name: "ky's GitHub repo" }).press("Enter");
    await expect(panel(page).getByRole("button", { name: "Not set" })).toBeVisible();
  }
});

test("shows why Settings refused ky's repo in its row, and keeps the repo unset", async ({ page }) => {
  await open(page);
  await settings(page, "Self-edits");

  await panel(page).getByRole("button", { name: "Not set" }).click();
  await panel(page).getByRole("textbox", { name: "ky's GitHub repo" }).fill("not a repo");
  await panel(page).getByRole("textbox", { name: "ky's GitHub repo" }).press("Enter");

  const selfEdits = panel(page).locator(".group").filter({ hasText: "Self-edits" });
  await expect(selfEdits.getByRole("alert")).toHaveText('"not a repo" is not a GitHub repo; write it as owner/name.');
  await expect(selfEdits.getByRole("button", { name: "Not set" })).toBeVisible();
  await expect(page.locator(".composer-note[data-tone='error']")).toHaveCount(0);
});

test("adds an Anthropic key in Settings once its test call passes, runs on Claude, and falls back when it is removed", async ({ page }) => {
  await open(page);
  await settings(page, "Providers");
  const providers = panel(page).locator(".group").filter({ hasText: "Providers" });
  const main = panel(page).getByRole("button", { name: /^Main agent/ });
  // Exact, as the form's own name, "Add an API key", contains it.
  const key = providers.getByRole("textbox", { name: "API key", exact: true });

  await providers.getByRole("combobox", { name: "Vendor" }).selectOption({ label: "Anthropic" });
  await key.fill("sk-ant-api03-wrong");
  await providers.getByRole("button", { name: "Test and save" }).click();
  await expect(providers.getByRole("alert")).toContainText("Anthropic refused the key");
  await expect(providers.getByRole("button", { name: "Remove the Anthropic key" })).toBeHidden();

  try {
    await key.fill(ANTHROPIC_KEY);
    await providers.getByRole("button", { name: "Test and save" }).click();
    await expect(providers.getByRole("listitem").filter({ hasText: "Anthropic" })).toContainText(/\d+ models/);
    await expect(key).toHaveValue("");
    await expect(providers.getByRole("alert")).toBeHidden();
    // Earlier tests leave the main agent picked, not on the default, so pick a Claude model here.
    await settings(page, "Models", "Main agent");
    const claude = panel(page).getByRole("radiogroup", { name: "Main agent model" }).getByRole("radio", { name: /Anthropic/ }).first();
    await claude.click();
    await expect(claude).toHaveAttribute("aria-checked", "true");
    await settings(page, "Models");
    await expect(main).toContainText("· Anthropic");
  } finally {
    await settings(page, "Providers");
    await providers.getByRole("button", { name: "Remove the Anthropic key" }).click();
    await expect(providers.getByRole("listitem").filter({ hasText: "Anthropic" })).toHaveCount(0);
    await settings(page, "Models");
    await expect(main).toContainText("Glm 5.3 Flash · Workers AI");
    await pick(page, "Main agent", /^Glm 5.3 Flash/);
  }
});

test("refuses a Claude subscription token as an Anthropic key, and links to Subscriptions where it goes", async ({ page }) => {
  await open(page);
  await settings(page, "Providers");
  const providers = panel(page).locator(".group").filter({ hasText: "Providers" });

  await providers.getByRole("combobox", { name: "Vendor" }).selectOption({ label: "Anthropic" });
  await providers.getByRole("textbox", { name: "API key", exact: true }).fill("sk-ant-oat01-a-subscription-token");
  await providers.getByRole("button", { name: "Test and save" }).click();
  await expect(providers.getByRole("alert")).toContainText("It goes in Settings › Subscriptions");
  await expect(providers.getByRole("button", { name: "Remove the Anthropic key" })).toBeHidden();

  await providers.getByRole("alert").getByRole("button", { name: "Settings › Subscriptions" }).click();
  await expect(panel(page).getByRole("heading", { name: "Subscriptions" }).first()).toBeInViewport();
});

test("turns Subscriptions off until a machine is paired, and links to Machines", async ({ page }) => {
  // A ky with no paired machine: the server's machine list arrives empty.
  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const frame = decodeServerFrame(String(message));

      socket.send(frame?.type === "tasks" ? JSON.stringify({ ...frame, machines: [] }) : message);
    });
  });
  await open(page);
  await settings(page, "Subscriptions");
  const subscriptions = panel(page).locator("#settings-subscriptions");

  await expect(subscriptions.getByText("Pair a machine first")).toBeVisible();
  await expect(subscriptions.getByRole("textbox", { name: "Claude subscription token" })).toBeDisabled();
  await expect(subscriptions.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await subscriptions.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/6-subscriptions-unpaired.png` : undefined });

  await subscriptions.getByRole("button", { name: "Go to Machines" }).click();
  await expect(panel(page).locator("#settings-machines")).toBeInViewport();
});

test("keeps Subscriptions on while a machine is paired", async ({ page }) => {
  await open(page);
  await settings(page, "Subscriptions");
  const subscriptions = panel(page).locator("#settings-subscriptions");

  await expect(subscriptions.getByRole("textbox", { name: "Claude subscription token" })).toBeEnabled();
  await expect(subscriptions.getByRole("button", { name: "Sign in" })).toBeEnabled();
  await expect(subscriptions.getByText("Pair a machine first")).toHaveCount(0);
  await subscriptions.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/7-subscriptions-paired.png` : undefined });
});

for (const [width, name] of [
  [1280, "panel"],
  [390, "phone"]
] as const) {
  test(`gives the Claude row's note and form room to read at ${name} width`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    const show = page.getByRole("button", { name: /Show activity$/ });

    if (await show.isVisible()) await show.click();
    await settings(page, "Subscriptions");
    const subscriptions = panel(page).locator("#settings-subscriptions");
    await subscriptions.scrollIntoViewIfNeeded();
    await subscriptions.screenshot({ path: SHOTS ? `${SHOTS}/claude-row-${name}.png` : undefined });

    const note = await subscriptions.getByText("Paste what claude setup-token prints").boundingBox();
    const input = await subscriptions.getByRole("textbox", { name: "Claude subscription token" }).boundingBox();

    // The note stays on one line, and the input gets a line of its own.
    expect(note?.height).toBeLessThan(20);
    expect(input!.y).toBeGreaterThanOrEqual(note!.y + note!.height);
    expect(input?.width).toBeGreaterThan(160);
    await expect(subscriptions.getByText("Sign in with a code")).toBeVisible();
  });
}

test("switches the theme and keeps it after a reload", async ({ page }) => {
  await open(page);
  await settings(page, "Appearance");
  await panel(page).getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await settings(page, "Appearance");
  await panel(page).getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
});

test("picks an accent in Settings › Appearance and keeps it after a reload, Ink taking it off", async ({ page }) => {
  await open(page);
  await settings(page, "Appearance");
  const accents = panel(page).getByRole("radiogroup", { name: "Accent" });
  await expect(accents.getByRole("radio", { name: "Ink", exact: true })).toHaveAttribute("aria-checked", "true");
  await accents.getByRole("radio", { name: "Violet" }).click();
  await expect(accents.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "violet");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "violet");
  await settings(page, "Appearance");
  await panel(page).getByRole("radiogroup", { name: "Accent" }).getByRole("radio", { name: "Ink", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.*/);
});

test("opens Settings' pages from its first page and comes back with the button or Escape", async ({ page }) => {
  await open(page);
  await settings(page);
  const status = panel(page).getByRole("list", { name: "Status" });
  await expect(status.getByRole("button", { name: /^Main agent/ })).toContainText("Glm 5.3 Flash");
  await expect(status.getByRole("button", { name: /^VibeProxy/ })).toBeVisible();

  await status.getByRole("button", { name: /^Main agent/ }).click();
  await expect(panel(page).getByRole("heading", { name: "Main agent" })).toBeFocused();
  await expect(panel(page).getByRole("radiogroup", { name: "Main agent model" })).toBeVisible();

  // Back from a model goes to Models, and focus lands on the row that opened it.
  await page.keyboard.press("Escape");
  await expect(panel(page).getByRole("heading", { name: "Models" }).first()).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /^Main agent/ })).toBeFocused();

  await panel(page).getByRole("button", { name: "Settings", exact: true }).click();
  await expect(status).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /^Models/ })).toBeFocused();
});

test("makes a peer invite in Settings › Peers, and refuses pairing with ky's own address", async ({ page }) => {
  await open(page);
  await settings(page, "Peers");
  await expect(panel(page).getByText("No peers yet.")).toBeVisible();

  // One way of adding a peer at a time.
  await expect(panel(page).getByRole("form", { name: "Invite a peer" })).toBeHidden();
  await panel(page).getByRole("button", { name: "Invite someone" }).click();
  const invite = panel(page).getByRole("form", { name: "Invite a peer" });
  await invite.getByLabel("Name for their ky").fill("Not A Name");
  await invite.getByRole("button", { name: "Make invite" }).click();
  await expect(invite.getByRole("alert")).toContainText("needs a name");

  await invite.getByLabel("Name for their ky").fill("benky");
  await invite.getByRole("button", { name: "Make invite" }).click();
  const origin = new URL(page.url()).origin;
  const line = invite.getByLabel("Invite", { exact: true });
  await expect(line).toHaveText(new RegExp(`^${origin} [0-9a-f]{64}$`));
  await expect(invite.getByText(/It works once, until /)).toBeVisible();
  await expect(invite.getByRole("button", { name: "New invite" })).toBeVisible();
  const sent = (await line.textContent())!;

  await panel(page).getByRole("button", { name: "I have an invite" }).click();
  await expect(invite).toBeHidden();
  const pair = panel(page).getByRole("form", { name: "Pair with a peer" });
  await expect(pair.getByRole("button", { name: "Pair" })).toBeDisabled();
  // Pasting the invite names the ky after its address.
  await pair.getByLabel("Their invite").fill(sent);
  await expect(pair.getByLabel("Name for their ky")).toHaveValue(new URL(origin).hostname.split(".")[0]!);
  await page.screenshot({ path: SHOTS ? `${SHOTS}/peers-invite.png` : undefined });
  await pair.getByRole("button", { name: "Pair" }).click();
  await expect(pair.getByRole("alert")).toHaveText("That is this ky's own address.");
});

test("tells the chat what a mail to ky says, and sends ky's mail to someone new once the user does in Settings › Mail", async ({ page, request }) => {
  await open(page);
  // The Worker's email handler, as Email Routing calls it.
  const mail = ["From: Ana <ana@friend.test>", "To: ky@mail.test", "Subject: Dinner Friday?", `Message-ID: <${crypto.randomUUID()}@friend.test>`, "", "Are you free?"];
  const delivered = await request.post("/cdn-cgi/handler/email?from=ana@friend.test&to=ky@mail.test", { data: mail.join("\r\n") });
  expect(delivered.ok()).toBe(true);
  // The report comes into the main chat, which answers it (the stack's model echoes).
  await expect(chat(page).getByText('from ana@friend.test, "Dinner Friday?": a summary of a stranger\'s words').first()).toBeVisible();
  await expect(composer(page)).toHaveAttribute("placeholder", "Message ky");

  const to = `desk-${crypto.randomUUID().slice(0, 6)}@cafe.test`;
  await send(page, `tool mail ${JSON.stringify({ action: "send", to, subject: "Table for two", text: "Friday at 7?" })}`);
  await expect(chat(page).getByText(`ky hasn't written to ${to} before`).first()).toBeVisible();

  await settings(page, "Mail");
  await expect(panel(page).getByText("ky@mail.test")).toBeVisible();
  await expect(panel(page).getByText("Friday at 7?")).toBeVisible();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/mail-held.png` : undefined });
  await panel(page).getByRole("button", { name: "Send", exact: true }).click();

  await expect(panel(page).getByText(`To ${to} · Sent`)).toBeVisible();
  await expect(chat(page).getByText(`the user sent your mail to ${to}`).first()).toBeVisible();
  // Sending allowed the address; removing it puts the shared stack back.
  await panel(page).getByRole("button", { name: `Stop allowing ${to}` }).click();
  await expect(panel(page).getByRole("button", { name: `Stop allowing ${to}` })).toBeHidden();
});

test("turns Proactivity off and back on in Settings, the arrow keys moving the choice", async ({ page }) => {
  await open(page);
  await settings(page, "Proactivity");
  const levels = panel(page).getByRole("radiogroup", { name: "Proactivity" });
  const on = levels.getByRole("radio", { name: /^On/ });
  await expect(on).toHaveAttribute("aria-checked", "true");
  // Arrow keys move the choice, as in any radio group.
  await on.focus();
  await page.keyboard.press("ArrowDown");
  await expect(levels.getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");
  // The choice is kept: a reload still shows it.
  await page.reload();
  await settings(page, "Proactivity");
  await expect(levels.getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");
  await levels.getByRole("radio", { name: /^Off/ }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(on).toHaveAttribute("aria-checked", "true");
  await expect(on).toBeFocused();
});

test("sets when ky looks over the day in Settings › Proactivity, and hides the times while it is off", async ({ page }) => {
  await open(page);
  await settings(page, "Proactivity");
  const looks = panel(page).locator("#settings-proactivity");
  await expect(looks.getByText("08:00")).toBeVisible();

  await looks.getByRole("button", { name: "Add a time" }).click();
  await looks.getByLabel("Look time").fill("21:15");
  await looks.getByRole("button", { name: "Add", exact: true }).click();
  await looks.getByRole("button", { name: "Remove 08:00" }).click();
  await expect(looks.getByRole("button", { name: "Remove 21:15" })).toBeVisible();
  // Four at most: with four set, there is no time to add.
  await looks.getByRole("button", { name: "Add a time" }).click();
  await looks.getByLabel("Look time").fill("06:45");
  await looks.getByRole("button", { name: "Add", exact: true }).click();
  await expect(looks.getByLabel("Look time")).toBeHidden();
  await expect(looks.getByRole("button", { name: "Add a time" })).toBeHidden();

  // Kept, earliest first: a reload still shows them.
  await page.reload();
  await settings(page, "Proactivity");
  await expect(looks.getByRole("button", { name: /^Remove/ })).toHaveCount(4);
  await expect(looks.getByText(/^\d\d:\d\d$/)).toHaveText(["06:45", "13:00", "18:00", "21:15"]);

  await panel(page).getByRole("radio", { name: /^Off/ }).click();
  await expect(looks.getByText("21:15")).toBeHidden();
  await panel(page).getByRole("radio", { name: /^On/ }).click();

  // Back to the defaults for the tests after.
  for (const time of ["06:45", "21:15"]) await looks.getByRole("button", { name: `Remove ${time}` }).click();
  await looks.getByRole("button", { name: "Add a time" }).click();
  await looks.getByLabel("Look time").fill("08:00");
  await looks.getByRole("button", { name: "Add", exact: true }).click();
  await expect(looks.getByText(/^\d\d:\d\d$/)).toHaveText(["08:00", "13:00", "18:00"]);
});

test("sets how many posts a day notify right away in Settings › Proactivity, next to this device's notifications switch", async ({ page }) => {
  await open(page);
  await settings(page, "Proactivity");
  const section = panel(page).locator("#settings-proactivity");
  // This device's switch: the stack's page runs no service worker, so it can't subscribe here.
  await expect(section.getByRole("switch", { name: /Notifications on this device/ })).toBeVisible();
  const rightAway = section.getByLabel(/Per day, at most/);
  await expect(rightAway).toHaveValue("6");

  await rightAway.fill("3");
  await page.reload();
  await settings(page, "Proactivity");
  await expect(rightAway).toHaveValue("3");

  // Back to the default for the tests after.
  await rightAway.fill("6");
  await page.reload();
  await settings(page, "Proactivity");
  await expect(rightAway).toHaveValue("6");
});

test("switches to a tapped notification's chat without reloading the page", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  const side = new URL(page.url()).search;

  // What public/sw.js posts an open ky when a notification is tapped.
  const tap = (search: string) =>
    page.evaluate((query) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "open-chat", search: query } })), search);

  // A reload would lose this mark.
  await page.evaluate(() => Object.assign(window, { notReloaded: true }));
  await tap("?session=1");
  await expect(page).toHaveURL(/\/$/);
  await tap(side);
  await expect(page).toHaveURL(new RegExp(`\\${side}$`));
  await expect(page.getByRole("heading", { name: "A side chat" })).toBeVisible();
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
});

test("lists last night's dream in Activity with its reasons, undoes a change, says why another can't be, and pins a skill", async ({ page }) => {
  await signIn(page);
  const tag = crypto.randomUUID().slice(0, 6);
  const [groceries, run] = [`weekly-groceries-${tag}`, `grocery-run-${tag}`];
  const seeded = await page.request.post(`/test/dream-night?tag=${tag}`);
  expect(seeded.ok()).toBe(true);

  await open(page);
  await panel(page).getByRole("tab", { name: "Activity" }).click();
  const night = panel(page).getByRole("region", { name: "Last night" });
  const merge = night.getByRole("listitem", { name: `Merged ${run} into ${groceries}` });
  await expect(merge.getByText(`Same steps as ${groceries}`)).toBeVisible();
  await expect(night.getByRole("listitem", { name: `Edited ${groceries}` }).getByText("You order tea every Friday")).toBeVisible();
  await expect(night.getByRole("listitem", { name: `Made tea-order-${tag}` })).toBeVisible();
  await expect(night.getByText(`“the user drinks green tea, then oolong (${tag})”`)).toBeVisible();
  await night.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/last-night.png` : undefined });

  await merge.getByRole("button", { name: `Undo: Merged ${run} into ${groceries}` }).click();
  await expect(merge.getByText("Undone")).toBeVisible();
  await expect(merge.getByRole("button", { name: /^Undo/ })).toHaveCount(0);

  // The skill changed since the dream edited it, so undoing that edit would lose the newer word: refused, with why.
  await send(page, `tool skill_manage ${JSON.stringify({ action: "patch", name: groceries, old: "Open the list", new: "Open the shared list" })}`);
  await expect(page.getByText(`tool said: Saved patch of ${groceries}`)).toBeVisible();
  const edit = night.getByRole("listitem", { name: `Edited ${groceries}` });
  await edit.getByRole("button", { name: `Undo: Edited ${groceries}` }).click();
  await expect(edit.getByRole("status")).toContainText(`${groceries} changed after this patch`);
  await expect(edit.getByRole("button", { name: `Undo: Edited ${groceries}` })).toBeVisible();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/last-night-undone.png` : undefined });

  // The merged skill is back, as ky wrote it; pinning one keeps after a reload.
  const skills = await skillsPage(page);
  const list = skills.getByRole("navigation", { name: "Skills list" });
  const skillRow = (name: string) => list.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(skillRow(run)).toBeVisible();
  await skillRow(groceries).click();
  const skill = skills.getByRole("article", { name: groceries });
  await expect(skill.getByText("Skill · Written by ky")).toBeVisible();
  await skill.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(skillRow(groceries).getByRole("img", { name: "Pinned" })).toBeVisible();
  await expect(skill.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true");
  await expect(skill.getByText("Used 0 times")).toContainText("pinned, so ky's dreams and reviews leave it as it is");
  // The reader settles in with a short transition: shoot it settled.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  await page.screenshot({ path: SHOTS ? `${SHOTS}/skill-pinned.png` : undefined });

  // The page is in the URL, so a reload lands back on it.
  await page.reload();
  await expect(skillRow(groceries).getByRole("img", { name: "Pinned" })).toBeVisible();
});

test("shows a look's post as its own ky message, leaving ky's last answer as it was", async ({ page }) => {
  await open(page);
  const tag = `zq${crypto.randomUUID().slice(0, 6)}`;
  await send(page, `tool memory_note {"text":"${tag}: Kai needs a warm jacket under 10C"}`);
  const saved = chat(page).getByRole("article").filter({ hasText: `${tag}: Kai needs` }).getByText(/^tool said: .*Saved as #\d+/);
  await expect(saved).toBeVisible();
  const id = /#(\d+)/.exec((await saved.textContent()) ?? "")?.[1];
  const said = `Cold this morning (6C): ${tag} Kai needs his warm jacket.`;
  const row = { ref: `memory:${id}`, needed: "Kai's jacket when cold", current: "6C at 08:00", action: "tell", message: said };
  await send(page, `look> ${JSON.stringify(row)}`);
  const answer = chat(page).getByText(/^echo: look> /);
  await expect(answer).toBeVisible();
  await expect(chat(page).getByText("Working")).toHaveCount(0);

  expect((await page.request.post("/test/look?time=08:00")).status()).toBe(204);

  // Its own message, last, as written: the turn before keeps its answer, and no notice wording shows. The thread
  // shows only its latest turns, so the post is counted as the article after the one holding that answer.
  const articles = chat(page).getByRole("article");
  await expect(articles.last()).toHaveText(said);
  await expect(articles.nth(-2).getByText(/^echo: look> /)).toBeVisible();
  await expect(answer).toBeVisible();
  await expect(chat(page).getByText("[ky posted to the user")).toHaveCount(0);
  await page.screenshot({ path: SHOTS ? `${SHOTS}/look-post.png` : undefined, animations: "disabled" });
});

test("shows what ky recalled for a message under it, and the recalled lines on a tap", async ({ page }) => {
  await open(page);
  const tag = `zq${crypto.randomUUID().slice(0, 6)}`;
  await send(page, `tool memory_note {"text":"the user keeps ${tag} tea in the blue tin"}`);
  // Its own turn's answer: older turns fold away as the chat grows, so a count of answers would not hold.
  await expect(chat(page).getByRole("article").filter({ hasText: `${tag} tea in the blue tin` }).getByText(/^tool said: /)).toBeVisible();

  await send(page, `where is my ${tag} tea`);
  await expect(page.getByText(`echo: where is my ${tag} tea`)).toBeVisible();

  // The chip sits under the user's message; the answer and the transcript never hold the block.
  const chip = chat(page).getByRole("button", { name: /^Recalled \d+/ }).last();
  await expect(chip).toBeVisible();
  await expect(chat(page).getByText("<recalled>")).toHaveCount(0);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(chat(page).getByRole("list", { name: "Recalled context" }).last().getByText(new RegExp(`^memory #\\d+ .*${tag} tea in the blue tin`))).toBeVisible();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/recalled.png` : undefined, animations: "disabled" });
});

test("opens the command palette with the keyboard and runs a command", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await expect(palette).toBeVisible();

  await palette.getByRole("combobox", { name: "Search chats and commands" }).fill("sett");
  await palette.getByRole("option", { name: /Settings/ }).click();
  await expect(palette).toBeHidden();
  await expect(panel(page).getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
});

test("shows ky's skills, edits one, reverts it and archives it", async ({ page }) => {
  await open(page);
  const name = `web-${crypto.randomUUID().slice(0, 8)}`;
  const create = { action: "create", name, description: "Ordering groceries", body: "Order oat milk." };
  await send(page, `tool skill_manage ${JSON.stringify(create)}`);
  await expect(page.getByText(`tool said: Created ${name}`)).toBeVisible();

  const skills = await skillsPage(page);
  await skills.getByRole("navigation", { name: "Skills list" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const skill = skills.getByRole("article", { name });
  await expect(skill.getByText("Order oat milk.")).toBeVisible();

  await skill.getByRole("button", { name: "Edit" }).click();
  await skill.getByRole("textbox", { name: "Steps" }).fill("Order soy milk.");
  await skill.getByRole("button", { name: "Save" }).click();
  await expect(skill.getByText("Order soy milk.")).toBeVisible();

  await skill.getByRole("button", { name: "History" }).click();
  const versions = skill.getByRole("list", { name: `${name} versions` });
  await expect(versions).toContainText("edit by user");
  await versions.getByRole("button", { name: "Revert" }).click();
  await expect(skill.getByText("Order oat milk.")).toBeVisible();

  await skill.getByRole("button", { name: "Archive" }).click();
  await expect(skill.getByRole("button", { name: "Restore" })).toBeVisible();
});

test("groups a kit with its members as chips, opens a member from one, and shows the kits on the Skills page", async ({ page }) => {
  await open(page);
  const id = crypto.randomUUID().slice(0, 8);
  const [member, kit] = [`web-step-${id}`, `web-kit-${id}`];
  await send(page, `tool skill_manage ${JSON.stringify({ action: "create", name: member, description: "Picks five dinners", body: "## Steps\n1. Pick five dinners." })}`);
  await expect(page.getByText(`tool said: Created ${member}`)).toBeVisible();
  const body = `Run in order.\n\n## Members\n- ${member}\n- gone-${id}`;
  await send(page, `tool skill_manage ${JSON.stringify({ action: "create", name: kit, kind: "kit", description: "Plans the week", body })}`);
  await expect(page.getByText(`tool said: Created ${kit}`)).toBeVisible();

  const skills = await skillsPage(page);
  const list = skills.getByRole("navigation", { name: "Skills list" });
  await list.getByRole("button", { name: new RegExp(`^${kit} Plans`) }).click();
  const chips = skills.getByRole("article", { name: kit }).getByRole("list", { name: `${kit} members` });
  await expect(chips.getByRole("button", { name: `gone-${id}` })).toBeDisabled();
  // A chip opens its member, which says which kit runs it.
  await chips.getByRole("button", { name: member }).click();
  const opened = skills.getByRole("article", { name: member });
  await expect(opened.getByRole("heading", { name: "Steps" })).toBeVisible();
  await expect(opened.getByText(`in ${kit}`)).toBeVisible();

  await skills.getByRole("tab", { name: "Kits" }).click();
  await expect(page).toHaveURL(/skills=kits/);
  await expect(skills.getByRole("button", { name: new RegExp(`^${kit} Plans`) })).toBeVisible();
  await expect(skills.getByRole("button", { name: new RegExp(`^${member} Picks`) })).toBeHidden();
});

test("creates a specialist in the Soul tab, edits its brief and reverts it", async ({ page }) => {
  await open(page);
  const id = `web-${crypto.randomUUID().slice(0, 8)}`;
  await panel(page).getByRole("tab", { name: "Soul" }).click();
  await panel(page).getByRole("button", { name: "+ Specialist" }).click();

  const form = page.getByRole("dialog", { name: "New specialist" });
  await form.getByRole("textbox", { name: "Id" }).fill(id);
  await form.getByRole("textbox", { name: "Description" }).fill("Keeps the builds green.");
  await form.getByRole("textbox", { name: "Brief" }).fill("Run the tests first.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();

  await panel(page).getByRole("button", { name: new RegExp(`^@${id}`) }).click();
  const sheet = page.getByRole("dialog", { name: `@${id}` });
  await expect(sheet.getByText("Run the tests first.")).toBeVisible();
  await sheet.getByRole("button", { name: `Edit @${id}` }).click();
  await sheet.getByRole("textbox", { name: `@${id}` }).fill("Run the tests twice.");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByText("Version 2")).toBeVisible();

  await sheet.getByRole("button", { name: "More" }).click();
  await sheet.getByRole("menuitem", { name: "History and revert" }).click();
  await sheet.getByRole("list", { name: `@${id} versions` }).getByRole("button", { name: "Revert" }).click();
  await expect(sheet.getByText("Run the tests first.")).toBeVisible();
  await expect(sheet.getByText("Version 3")).toBeVisible();
});

test("shows each specialist's bloub in the Soul tab, and New avatar asks ky for another", async ({ page }) => {
  await open(page);
  const id = `web-${crypto.randomUUID().slice(0, 8)}`;
  await panel(page).getByRole("tab", { name: "Soul" }).click();
  await panel(page).getByRole("button", { name: "+ Specialist" }).click();
  const form = page.getByRole("dialog", { name: "New specialist" });
  await form.getByRole("textbox", { name: "Id" }).fill(id);
  await form.getByRole("textbox", { name: "Description" }).fill("Builds, fixes and ships changes.");
  await form.getByRole("textbox", { name: "Brief" }).fill("Ship small changes.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();

  // Without a saved one, the row shows the bloub rolled from its id.
  const row = panel(page).getByRole("button", { name: new RegExp(`^@${id}`) });
  await expect(row.getByRole("img", { name: `@${id}` })).toBeVisible();

  const bolt = { name: "Bolt", body: { w: 112, h: 104, corner: 32, color: "#ff7a3d" }, eyes: { count: 1, size: 26 }, top: { kind: "antenna", color: "#2b7fff" }, cheeks: false, feet: true };
  await send(page, `tool avatar ${JSON.stringify({ action: "set", for: id, spec: bolt })}`);
  await expect(page.getByText(`Saved as @${id}'s avatar.`)).toBeVisible();
  await expect(row.getByRole("img", { name: `@${id}` }).locator(`[fill="#ff7a3d"]`)).not.toHaveCount(0);
  await page.screenshot({ path: "test-results/web/specialist-avatar.png" });

  await row.click();
  const sheet = page.getByRole("dialog", { name: `@${id}` });
  await sheet.getByRole("button", { name: "More" }).click();
  await sheet.getByRole("menuitem", { name: "New avatar" }).click();
  await expect(sheet).toBeHidden();
  await expect(chat(page).getByText(new RegExp(`^Design a new avatar for @${id}`)).first()).toBeVisible();
});

// Crons are UTC and rows show them in the browser's time: India's half-hour offset shows the conversion.
test("sits the specialists answering a group chat beside ky in the pill, counts them, and leaves ky alone after", async ({ page }) => {
  await open(page);
  const tag = crypto.randomUUID().slice(0, 6);
  const [a, b, c] = ["a", "b", "c"].map((letter) => `crew${letter}-${tag}`);
  await panel(page).getByRole("tab", { name: "Soul" }).click();

  for (const id of [a, b, c]) {
    await panel(page).getByRole("button", { name: "+ Specialist" }).click();
    const form = page.getByRole("dialog", { name: "New specialist" });
    await form.getByRole("textbox", { name: "Id" }).fill(id!);
    await form.getByRole("textbox", { name: "Description" }).fill("Helps with sandwiches.");
    await form.getByRole("textbox", { name: "Brief" }).fill("Answer briefly.");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form).toBeHidden();
  }

  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await page.getByRole("button", { name: "Add specialists to this chat" }).click();

  for (const id of [a, b, c]) await page.getByRole("menuitemcheckbox", { name: new RegExp(`^@${id}`) }).click();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Group chat with/ })).toBeVisible();

  const pill = page.getByRole("button", { name: /^ky: Connected/ });
  await send(page, `@${a} @${b}\n${a}> gate\n${b}> on it`);
  await expect(pill).toHaveAccessibleName(new RegExp(`@${a} answering`));
  await expect(pill.getByText("1/3")).toBeVisible();
  await page.screenshot({ path: "test-results/web/crew-working.png", clip: (await pill.boundingBox())! });
  await page.screenshot({ path: "test-results/web/crew-working-full.png" });

  await release(page);
  await expect(pill).not.toHaveAccessibleName(/answering/);
  await expect(pill.getByText("/3")).toBeHidden();
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: "test-results/web/crew-after.png", clip: (await pill.boundingBox())! });
});

test.describe("automations in Activity", () => {
  test.use({ timezoneId: "Asia/Kolkata", locale: "en-US" });

  /** Activity's sheet of every routine, opened from Today's header. */
  async function routines(page: Page) {
    await panel(page).getByRole("tab", { name: "Activity" }).click();
    await panel(page).getByRole("button", { name: /routines?$/i }).click();

    return panel(page).getByRole("region", { name: "Routines" });
  }

  test("pauses, resumes and archives an automation from Activity", async ({ page }) => {
    await open(page);
    const title = `Check the news ${crypto.randomUUID().slice(0, 8)}`;
    const create = { action: "create", title, prompt: "Read the news and sum it up.", cron: "0 9 * * 1-5" };
    await send(page, `tool automation ${JSON.stringify(create)}`);
    await expect(page.getByText(`"${title}" (cron 0 9 * * 1-5`)).toBeVisible();

    // A cron is wall-clock time in the routine's zone: 9 means 9.
    const sheet = await routines(page);
    const automation = sheet.getByRole("listitem", { name: title });
    await expect(automation).toContainText("Weekdays · 9:00 AM");
    await expect(automation).toContainText(/in \d+[mhd]/);

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/routines-sheet.png` });

    await automation.getByRole("button", { name: "Pause" }).click();
    await expect(automation).toContainText("Paused");

    await automation.getByRole("button", { name: "Resume" }).click();
    await expect(automation).toContainText(/in \d+[mhd]/);
    await expect(automation.getByRole("button", { name: "Pause" })).toBeVisible();

    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    const edit = panel(page).getByRole("form", { name: "Edit automation" });
    await expect(edit).toContainText("Weekdays · 9:00 AM");
    await expect(edit).toContainText(/Next: /);

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/routine-form.png` });

    await edit.getByRole("button", { name: "More actions" }).click();
    await edit.getByRole("button", { name: "Archive" }).click();
    await expect(automation).toBeHidden();
  });

  test("adds, edits, runs and deletes an automation from Activity", async ({ page }) => {
    await open(page);
    const title = `Water the plants ${crypto.randomUUID().slice(0, 8)}`;
    const sheet = await routines(page);

    await sheet.getByRole("button", { name: "New", exact: true }).click();
    const form = panel(page).getByRole("form", { name: "New automation" });
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("Prompt").fill("say the plants are watered");
    await form.getByRole("radio", { name: "Cron" }).click();
    await form.getByLabel("Cron").fill("nope");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("alert")).toContainText('Cannot schedule "nope"');

    await form.getByLabel("Cron").fill("30 7 * * *");
    await expect(form).toContainText("Daily · 7:30 AM");
    await form.getByRole("button", { name: "Save" }).click();
    const automation = sheet.getByRole("listitem", { name: title });
    await expect(automation).toContainText("Daily · 7:30 AM");

    // The chips write the same local cron: Weekly on Monday at 8:00 AM.
    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    const edit = panel(page).getByRole("form", { name: "Edit automation" });
    await expect(edit.getByLabel("Title")).toHaveValue(title);
    await expect(edit.getByRole("radio", { name: "Daily" })).toHaveAttribute("aria-checked", "true");
    await edit.getByRole("radio", { name: "Weekly" }).click();

    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      const toggle = edit.getByRole("button", { name: day, exact: true });
      const pressed = (await toggle.getAttribute("aria-pressed")) === "true";

      if (pressed !== (day === "Monday")) await toggle.click();
    }

    await expect(edit.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "true");
    await edit.getByLabel("At", { exact: true }).fill("08:00");
    await expect(edit).toContainText("Mondays · 8:00 AM");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(automation).toContainText("Mondays · 8:00 AM");

    await automation.getByRole("button", { name: "Run now" }).click();
    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    await expect(edit).toContainText(/Ran (just now|\d+[mhd] ago)|Running/);

    await edit.getByRole("button", { name: "More actions" }).click();
    await edit.getByRole("button", { name: "Delete" }).click();
    await edit.getByRole("button", { name: "Delete for good" }).click();
    await expect(sheet.getByRole("listitem", { name: title })).toBeHidden();
  });

  test("gates an automation on an Executor program: the chat sees its test, Activity its last check, and edits keep it", async ({ page }) => {
    await open(page);
    await connectExecutor(page);
    const title = `School mail ${crypto.randomUUID().slice(0, 8)}`;
    const create = { action: "create", title, prompt: "tell me what school sent", cron: "*/15 * * * *", gate: "answer null" };
    await send(page, `tool automation ${JSON.stringify(create)}`);
    await expect(page.getByText("Gate test: returned nothing (null), so a fire now would be skipped.")).toBeVisible();

    const sheet = await routines(page);
    const automation = sheet.getByRole("listitem", { name: title });
    await expect(automation).toContainText("Every 15 min");

    // An edit that leaves the gate alone keeps it.
    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    const edit = panel(page).getByRole("form", { name: "Edit automation" });
    await expect(edit).toContainText("gated");
    await expect(edit.getByLabel("Gate")).toHaveValue("answer null");
    await edit.getByLabel("Prompt").fill("tell me what school sent, in one line");
    await edit.getByRole("button", { name: "Save" }).click();
    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    await expect(edit.getByLabel("Gate")).toHaveValue("answer null");

    await edit.getByLabel("Gate").fill('answer ["Trip form due Friday"]');
    await edit.getByRole("button", { name: "Save" }).click();
    await automation.getByRole("button", { name: "Run now" }).click();
    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    await expect(edit.getByText("gate: found")).toHaveAttribute("title", 'found: ["Trip form due Friday"]');
    await expect(edit).toContainText(/Ran (just now|\d+[mhd] ago)|Running/);

    // Clearing the field clears the gate.
    await edit.getByLabel("Gate").fill("");
    await edit.getByRole("button", { name: "Save" }).click();
    await automation.getByRole("button", { name: `Edit ${title}` }).click();
    await expect(edit.getByText(/^gate/)).toHaveCount(0);
    await edit.getByRole("button", { name: /^More Model/ }).click();
    await expect(edit.getByLabel("Gate")).toHaveValue("");

    await edit.getByRole("button", { name: "More actions" }).click();
    await edit.getByRole("button", { name: "Delete" }).click();
    await edit.getByRole("button", { name: "Delete for good" }).click();
    await expect(automation).toBeHidden();
  });

  test("shows today as a timeline: each routine's next run opens its form, and each fire is one row that opens its run", async ({ page }) => {
    await open(page);
    const title = `Stretch ${crypto.randomUUID().slice(0, 8)}`;
    await send(page, `tool automation ${JSON.stringify({ action: "create", title, prompt: "remind me to stretch", cron: "*/30 * * * *" })}`);
    await expect(chat(page).locator(".turn-event", { hasText: title })).toContainText("Created routine");
    const id = /Created automation (\w+),/.exec((await chat(page).getByText(/tool said: Created automation/).last().textContent()) ?? "")?.[1] ?? "";

    await panel(page).getByRole("tab", { name: "Activity" }).click();
    const today = panel(page).getByRole("list", { name: "Today" });
    await expect(today.getByRole("listitem", { name: /^Now, / })).toBeVisible();
    const row = today.getByRole("button", { name: new RegExp(title) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("every 30 min");

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-timeline.png` });

    await row.click();
    await expect(panel(page).getByRole("form", { name: "Edit automation" }).getByLabel("Title")).toHaveValue(title);
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    await expect(today).toBeVisible();

    // A fire is one row: above now, with its result, opening its run; never a task in the subagent fold too.
    await send(page, `tool automation ${JSON.stringify({ action: "run", id })}`);
    const fired = today.locator(".today-row", { hasText: title }).filter({ has: page.locator('.today-dot[data-tone="done"]') });
    await expect(fired).toHaveCount(1, { timeout: 30_000 });
    await expect(today.getByRole("button", { name: new RegExp(title) })).toHaveCount(2);
    await expect(panel(page).locator(".ledger-item", { hasText: title })).toHaveCount(0);
    await expect(panel(page).getByText(/automation-[0-9a-f]/)).toHaveCount(0);

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-fired.png` });

    await fired.click();
    const sheet = page.getByRole("dialog", { name: new RegExp(title) });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();

    await send(page, `tool automation ${JSON.stringify({ action: "delete", id })}`);
  });
});

test("an app action waits for the user's tap on its card: Approve finishes the program, and Settings sets the tool to Allow, Ask or Block", async ({ page }) => {
  await open(page);
  await connectExecutor(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);

  await send(page, `tool executor_execute ${JSON.stringify({ code: "approve gmail.send send mail to sam" })}`);
  const card = chat(page).getByRole("region", { name: "Approve this app action?" });
  await expect(card.getByText("send mail to sam")).toBeVisible();
  await expect(chat(page).getByText("Only your tap approves it")).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/approval-card.png` });
  await card.getByRole("button", { name: "Approve" }).click();

  // ky resumes the program at Executor itself, the card goes, and the chat hears what came of it.
  await expect(card).toBeHidden();
  await expect(chat(page).getByText(/did send mail to sam/).first()).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/approval-done.png` });
  await settings(page, "Tools");
  const policy = panel(page).getByRole("radiogroup", { name: "Approvals for gmail.send" });
  await policy.getByRole("radio", { name: "Block" }).click();
  await expect(policy.getByRole("radio", { name: "Block" })).toHaveAttribute("aria-checked", "true");

  if (SHOTS) await panel(page).getByRole("region", { name: "Approvals" }).screenshot({ path: `${SHOTS}/approval-policies.png` });
  // The stack is shared: put the tool back to the default.
  await policy.getByRole("radio", { name: "Ask" }).click();
  await expect(policy.getByRole("radio", { name: "Ask" })).toHaveAttribute("aria-checked", "true");
});

test("lists the tools ky can use", async ({ page }) => {
  await open(page);
  await connectExecutor(page);
  await panel(page).getByRole("button", { name: /What ky can use/ }).click();
  await expect(panel(page).getByText("machine", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("executor_skills", { exact: true })).toBeVisible();
});

test("shows a subagent's work in Activity and opens its chat", async ({ page }) => {
  await open(page);
  await send(page, "spawn browserhelper say hi from the subagent");
  const task = panel(page).getByRole("button", { name: /browserhelper/ }).first();
  await expect(task).toBeVisible();

  // The task opens its steps; its chat opens from there.
  await task.click();
  await page.getByRole("dialog").getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByRole("button", { name: "Back to the main chat" })).toBeVisible();
  // In the chat: Activity's summary of the task says the same once it ends.
  await expect(chat(page).getByText("echo: say hi from the subagent")).toBeVisible();
  await page.getByRole("button", { name: "Back to the main chat" }).click();
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
});

test("runs a task on a machine and shows its report", async ({ page }) => {
  await open(page);
  await settings(page, "Machines", "webmac");
  await expect(panel(page).locator(".page-head")).toContainText(/idle|task/);
  await send(page, "machine@webmac build the web site");
  await expect(page.getByText("fake claude did: build the web site").first()).toBeVisible();
  await expect(page.getByText("Report from").first()).toBeVisible();
});

test("lists the cloud machine first in Settings, asleep while it has no task", async ({ page }) => {
  await open(page);
  await settings(page, "Machines");
  const machines = panel(page).locator("#settings-machines").getByRole("listitem");
  await expect(machines.first()).toContainText("cloud");
  await expect(machines.first()).toContainText("Asleep");
  await expect(machines.filter({ hasText: "webmac" })).toContainText("Online");
  await machines.first().getByRole("button").click();
  await expect(panel(page).locator(".page-head")).toContainText("Asleep · wakes when it's sent a task");
  await expect(panel(page).getByRole("button", { name: "Unpair this computer" })).toHaveCount(0);
});

test("pauses a machine and notes what it is for in Settings, and the agent is refused it", async ({ page }) => {
  await open(page);
  await settings(page, "Machines");
  // A machine's settings are on its own page.
  const row = panel(page).getByRole("button", { name: /^webmac/ });
  const states = panel(page).getByRole("radiogroup", { name: "Let ky use webmac" });
  await expect(row).toContainText(process.platform === "darwin" ? "macOS" : "Linux");
  await row.click();
  await expect(panel(page).getByRole("heading", { name: "webmac" })).toBeFocused();

  await states.getByRole("radio", { name: "Paused" }).click();
  await expect(states.getByRole("radio", { name: "Paused" })).toHaveAttribute("aria-checked", "true");

  try {
    const note = panel(page).getByRole("textbox", { name: "What it's for (optional)" });
    await expect(panel(page).locator(".page-head")).toContainText("Paused");
    await note.fill("web builds");
    await note.press("Enter");

    await send(page, "machine@webmac build while paused");
    await expect(page.getByText(/webmac is paused/).first()).toBeVisible();

    await page.reload();
    await settings(page, "Machines", "webmac");
    await expect(states.getByRole("radio", { name: "Paused" })).toHaveAttribute("aria-checked", "true");
    await expect(note).toHaveValue("web builds");
  } finally {
    // The other tests use webmac.
    await states.getByRole("radio", { name: "On" }).click();
    await expect(states.getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
  }
});

test("adds a machine with a pairing code, then removes it", async ({ page }) => {
  await open(page);
  await settings(page, "Machines");
  await panel(page).getByRole("button", { name: "Add a machine" }).click();
  const command = panel(page).getByLabel("Pairing command", { exact: true });
  await expect(command).toContainText(`ky runner add ${process.env.KY_STACK_URL}`);
  await expect(panel(page).getByText(/Run this on the computer before \d/)).toBeVisible();
  await page.screenshot({ path: SHOTS ? `${SHOTS}/machines-command.png` : undefined });
  const code = (await command.textContent())!.trim().split(" ").at(-1)!;

  // The command, run on the new machine.
  const added = pairable("webadd", `${REPO}/test-results/web-stack`);
  expect((await added.pair(process.env.KY_STACK_URL!, code)).code).toBe(0);
  const machine = panel(page).getByRole("button", { name: /^webadd/ });
  await expect(machine).toBeVisible();

  await machine.click();
  await panel(page).getByRole("button", { name: "Unpair this computer" }).click();
  const confirm = panel(page).getByRole("alertdialog", { name: "Unpair webadd" });
  await expect(confirm).toContainText("pair again");
  await confirm.getByRole("button", { name: "Unpair", exact: true }).click();
  await expect(panel(page).getByText("This machine is no longer paired.")).toBeVisible();
  await settings(page, "Machines");
  await expect(panel(page).getByRole("listitem").filter({ hasText: "webadd" })).toHaveCount(0);
});

test("shows what a machine task is doing, then how long it took and what it cost", async ({ page }) => {
  await open(page);
  await send(page, "machine@webmac [delay=4000] [tools=Bash:pnpm build] build with steps");
  const card = panel(page).getByRole("button", { name: /build with steps/ }).first();
  await expect(card).toContainText("Running pnpm build");
  await expect(page.getByRole("button", { name: /^ky:/ })).toContainText("webmac: Running pnpm build");

  await expect(card).toContainText("1 turn · $0.01");
  await expect(card).not.toContainText("Running pnpm build");
  await card.click();
  await expect(page.getByRole("list", { name: "Steps" })).toContainText("pnpm build");
});

test("shows a task without its markdown, and its machine and time each on one line", async ({ page }) => {
  await open(page);
  const id = crypto.randomUUID().slice(0, 8);
  await send(page, `machine@webmac **Lint** the *web* app ${id}`);
  const name = new RegExp(`Lint the web app ${id}`);
  const card = panel(page).getByRole("button", { name }).first();
  await expect(card).toContainText("1 turn · $0.01");
  await expect(card).not.toContainText("*");

  // Squeezed, the machine and the time used to wrap mid-word onto two lines.
  for (const token of [card.getByText("webmac", { exact: true }), card.getByText(/^\d{1,2}:\d{2}/)]) {
    expect((await token.boundingBox())?.height).toBeLessThan(24);
  }

  // Opened, its steps read the agent's words without their markdown too.
  await card.click();
  const steps = page.getByRole("list", { name: "Steps" });
  await expect(steps).toContainText(`working on: Lint the web app ${id}`);
  await expect(steps).not.toContainText("*");
});

test("stops a machine task from Activity", async ({ page }) => {
  await open(page);
  await send(page, "machine@webmac [delay=60000] a long web job");
  const stop = panel(page).getByRole("button", { name: /^Stop .*long web job/ });
  await stop.click();
  await expect(stop).toBeHidden();
  await expect(panel(page).getByRole("button", { name: /long web job/ }).first()).toContainText(/Stopped/);
});

test("stops every working task at once from Activity", async ({ page }) => {
  await open(page);
  await send(page, "machine@webmac [delay=60000] the first long job");
  await expect(panel(page).getByRole("button", { name: /^Stop .*first long job/ })).toBeVisible();
  await send(page, "machine@webmac [delay=60000] the second long job");
  await expect(panel(page).getByRole("button", { name: /^Stop .*second long job/ })).toBeVisible();

  await panel(page).getByRole("button", { name: "Stop all", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: /^Stop .*long job/ })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Stop all", exact: true })).toBeHidden();
});

test("turns check-ins off and on from Activity, and keeps the choice after a reload", async ({ page }) => {
  await open(page);
  await panel(page).getByRole("tab", { name: "Activity" }).click();
  await panel(page).getByRole("button", { name: /routines?$/i }).click();
  const on = panel(page).getByRole("button", { name: "Check-ins on" });
  await expect(on).toHaveAttribute("aria-pressed", "true");
  await panel(page).getByRole("heading", { name: "Routines" }).screenshot({ path: SHOTS ? `${SHOTS}/check-ins-on.png` : undefined });

  await on.click();
  const off = panel(page).getByRole("button", { name: "Check-ins off" });
  await expect(off).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await panel(page).getByRole("tab", { name: "Activity" }).click();
  await panel(page).getByRole("button", { name: /routines?$/i }).click();
  // The stack is shared: leave check-ins on.
  await panel(page).getByRole("button", { name: "Check-ins off" }).click();
  await expect(panel(page).getByRole("button", { name: "Check-ins on" })).toBeVisible();
});

test("lists today's routines above its finished tasks, and only recent tasks until Show earlier", async ({ page }) => {
  await open(page);
  const id = crypto.randomUUID().slice(0, 8);
  const jobs = panel(page).getByRole("button", { name: new RegExp(`quick job ${id}`) });

  for (let index = 0; index <= 10; index++) {
    await send(page, `machine@webmac quick job ${id} ${index}`);
    await expect(page.getByText(new RegExp(`tool said: .*quick job ${id} ${index}\\b`))).toBeVisible();
  }

  // Eleven finished jobs, the newest of all: ten show, the first waits behind Show earlier.
  await expect(panel(page).getByRole("button", { name: new RegExp(`^Stop .*quick job ${id}`) })).toHaveCount(0);
  await expect(jobs).toHaveCount(10);
  await expect(panel(page).getByRole("button", { name: new RegExp(`quick job ${id} 0$`) })).toBeHidden();

  const today = panel(page).getByRole("region", { name: "Today" }).getByRole("heading");
  expect((await today.boundingBox())!.y).toBeLessThan((await jobs.first().boundingBox())!.y);

  await panel(page).getByRole("button", { name: /^Show earlier/ }).click();
  await expect(jobs).toHaveCount(11);
});

test("shows a task's screenshot and opens it in the lightbox", async ({ page }) => {
  await open(page);
  await send(page, "machine@webmac [attach] screenshot the web page");
  const thumbnail = page.getByRole("button", { name: "Open a fake screenshot" }).first();
  await thumbnail.click();

  const lightbox = page.getByRole("dialog", { name: "a fake screenshot" });
  await expect(lightbox.getByRole("img", { name: "a fake screenshot" })).toBeVisible();
  await lightbox.getByRole("button", { name: "Close" }).click();
  await expect(lightbox).toBeHidden();
});

test("Artifacts gathers what ky made: the sites it published and the screenshots tasks attached, by kind", async ({ page }) => {
  await open(page);
  const html = '<!doctype html><body style="margin:0;background:#e8eef7;font:64px sans-serif">Quarterly report</body>';
  await send(page, `tool site ${JSON.stringify({ action: "publish", title: "Quarterly report", html })}`);
  await expect(chat(page).locator("p", { hasText: /\(id [0-9a-f]{32},/ })).toBeVisible();
  await send(page, "machine@webmac [attach] screenshot the web page");
  await expect(page.getByRole("button", { name: "Open a fake screenshot" }).first()).toBeVisible();

  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Artifacts" }).click();
  await expect(page).toHaveURL(/\?artifacts=all/);
  const artifacts = page.getByRole("region", { name: "Artifacts" });
  await expect(artifacts.getByRole("link", { name: "Open Quarterly report" })).toHaveAttribute("href", /^\/s\/[0-9a-f]{32}\/$/);
  await expect(artifacts.getByRole("button", { name: "Open a fake screenshot" })).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/artifacts.png` });

  await artifacts.getByRole("tab", { name: "Sites" }).click();
  await expect(page).toHaveURL(/\?artifacts=sites/);
  await expect(artifacts.getByRole("button", { name: "Open a fake screenshot" })).toBeHidden();
  await expect(artifacts.getByRole("link", { name: "Open Quarterly report" })).toBeVisible();

  await artifacts.getByRole("tab", { name: "Images" }).click();
  await expect(artifacts.getByRole("link", { name: "Open Quarterly report" })).toBeHidden();
  await artifacts.getByRole("button", { name: "Open a fake screenshot" }).click();
  await expect(page.getByRole("dialog", { name: "a fake screenshot" })).toBeVisible();
  await page.getByRole("dialog", { name: "a fake screenshot" }).getByRole("button", { name: "Close" }).click();

  await artifacts.getByRole("tab", { name: "Audio" }).click();
  await expect(artifacts.getByText("No audio yet.")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?artifacts=images/);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: /^Main chat/ }).click();
  await expect(artifacts).toBeHidden();
  await expect(chat(page).getByText("Shared with the user, shown under this report: a fake screenshot")).toBeVisible();
});

test("Artifacts files a sound saved as a video under Audio, and its card holds the whole player", async ({ page }) => {
  await open(page);
  await send(page, `machine@webmac [sh] ky attach ${REPO}/test/web/fixtures/sound.webm "Lecture audio"`);
  await expect(page.getByText(/sh exited 0/).first()).toBeVisible();

  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Artifacts" }).click();
  const artifacts = page.getByRole("region", { name: "Artifacts" });
  await artifacts.getByRole("tab", { name: "Audio" }).click();
  const card = artifacts.getByRole("listitem").filter({ hasText: "Lecture audio" });
  await expect(card.getByText(/^Audio · /)).toBeVisible();
  await expect(card.getByRole("button", { name: /^Play/ })).toBeVisible();

  const save = await card.getByRole("link", { name: /^Save/ }).boundingBox();
  const edge = await card.boundingBox();
  expect(save && edge && save.x + save.width <= edge.x + edge.width - 8).toBe(true);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/artifacts-audio.png` });


  await artifacts.getByRole("tab", { name: "Videos" }).click();
  await expect(artifacts.getByText("No videos yet.")).toBeVisible();
});

test("sends an image with a message, and refuses a fifth image", async ({ page }) => {
  await open(page);

  const files = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `pixel-${index}.png`, mimeType: "image/png", buffer: PIXEL }));

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach images" }).click();
  await (await chooser).setFiles(files(1));
  await expect(page.getByRole("list", { name: "Images to send" }).getByRole("img")).toHaveCount(1);

  await send(page, "what is in this picture");
  await expect(page.getByText("echo: what is in this picture")).toBeVisible();
  await expect(page.getByRole("list", { name: "Images to send" })).toBeHidden();

  const again = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach images" }).click();
  await (await again).setFiles(files(5));
  await expect(page.getByRole("alert")).toHaveText("Attach at most 4 images.");
  await expect(page.getByRole("list", { name: "Images to send" }).getByRole("img")).toHaveCount(4);
});

test("offers a reload when a new deploy is live and a draft would be lost", async ({ page }) => {
  let connections = 0;
  const closers: Array<() => Promise<void>> = [];

  // The network between the page and ky: the second connection's hello names a new deploy.
  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (socket) => {
    connections++;
    const nth = connections;
    const server = socket.connectToServer();
    closers.push(() => socket.close());
    socket.onMessage((message) => server.send(message));

    server.onMessage((message) => {
      const frame = decodeServerFrame(String(message));
      socket.send(nth > 1 && frame?.type === "hello" ? JSON.stringify({ ...frame, version: "the-next-deploy" }) : message);
    });
  });

  await open(page);
  await composer(page).fill("a draft worth keeping");
  await closers.at(-1)!();

  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  await expect(composer(page)).toHaveValue("a draft worth keeping");
});

test("sends a message again after its socket drops before the answer, and pi takes it once", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);

  faults.dropOnAnswer = true;
  await send(page, "resent but taken once");
  await expect.poll(() => connections.length).toBe(2);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();

  const [operationId] = connections[0]!.submits;
  await expect.poll(() => connections[1]!.submits).toEqual([operationId]);
  await expect
    .poll(() => connections[1]!.results.find((each) => each.id === operationId)?.result)
    .toMatchObject({ operationId, accepted: false });

  await expect(page.getByText("echo: resent but taken once")).toHaveCount(1);
  await expect(page.getByText("resent but taken once", { exact: true })).toHaveCount(1);
});

test("takes a message while offline and sends it when the socket opens again", async ({ page, context }) => {
  const { connections } = await network(page);
  await open(page);

  await context.setOffline(true);
  await connections[0]!.route.close();
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toHaveCount(0);

  // The composer still writes and sends; the message waits in the thread.
  await expect(composer(page)).toBeEnabled();
  await expect(composer(page)).toHaveAttribute("placeholder", "Offline · sends on reconnect");
  await send(page, "typed with no network");
  await expect(composer(page)).toHaveValue("");
  await expect(page.getByText("typed with no network", { exact: true })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("echo: typed with no network")).toBeVisible();
  await expect(page.getByText("typed with no network", { exact: true })).toHaveCount(1);
});

/** The messages written offline, waiting above the composer. */
const waitingList = (page: Page) => page.getByRole("list", { name: "Waiting to send" });

/** The submits that carried `text`, on every socket. */
const carrying = (frames: readonly SubmitFrame[], text: string) => frames.filter((frame) => JSON.stringify(frame.input).includes(text));

test("keeps a message written offline through a reload, waiting above the composer, and ky gets it once it's back", async ({ page }) => {
  const net = await network(page);
  await open(page);
  await net.offline();

  await send(page, "kept through the reload");
  await expect(waitingList(page).getByText("kept through the reload")).toBeVisible();
  await expect(page.getByText("Waiting for connection · 1", { exact: true })).toBeVisible();
  // It waits above the composer, not as a bubble in the thread.
  await expect(chat(page).locator(".turn").getByText("kept through the reload", { exact: true })).toHaveCount(0);

  // A reload (a lapsed sign-in, a deploy, the app swiped away) keeps it: the device has it.
  await page.reload();
  await expect(waitingList(page).getByText("kept through the reload")).toBeVisible();

  await net.online();
  await expect(chat(page).getByText("echo: kept through the reload")).toBeVisible();
  await expect(waitingList(page)).toHaveCount(0);
  await expect(chat(page).getByText("kept through the reload", { exact: true })).toHaveCount(1);
  expect(carrying(net.submitted(), "kept through the reload")).toHaveLength(1);

  // Answered, it's gone from the device too: another reload doesn't bring it back.
  await page.reload();
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  await expect(chat(page).getByText("kept through the reload", { exact: true })).toHaveCount(1);
  await expect(waitingList(page)).toHaveCount(0);
});

test("deletes or edits a message written offline before it goes, and ky never gets the one deleted", async ({ page }) => {
  const net = await network(page);
  await open(page);
  await net.offline();

  await send(page, "never leaves the device");
  await send(page, "edited while offline");
  await expect(page.getByText("Waiting for connection · 2", { exact: true })).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/waiting-to-send.png` });

  // Delete takes it back at once, offline: ky never had it.
  await waitingList(page).getByRole("button", { name: "Delete waiting message: never leaves the device" }).click();
  await expect(waitingList(page).getByRole("listitem")).toHaveCount(1);

  // Edit puts it back in the composer, out of the queue, to change and send again.
  await waitingList(page).getByRole("button", { name: "Edit waiting message: edited while offline" }).click();
  await expect(composer(page)).toHaveValue("edited while offline");
  await expect(waitingList(page)).toHaveCount(0);
  await composer(page).fill("edited while offline, then sent");
  await composer(page).press("Enter");
  await expect(waitingList(page).getByText("edited while offline, then sent")).toBeVisible();

  await page.reload();
  await expect(waitingList(page).getByRole("listitem")).toHaveCount(1);

  await net.online();
  await expect(chat(page).getByText("echo: edited while offline, then sent")).toBeVisible();
  expect(carrying(net.submitted(), "never leaves the device")).toEqual([]);
  expect(carrying(net.submitted(), "edited while offline")).toHaveLength(1);
});

test("a message written offline in one tab goes once, and shows once, when two tabs come back", async ({ page, context }) => {
  const net = await network(page);
  await open(page);
  await net.offline();
  await send(page, "two tabs, one message");
  await expect(waitingList(page).getByText("two tabs, one message")).toBeVisible();

  // A second tab opened while offline finds it on the device too.
  const other = await context.newPage();
  const otherNet = await network(other);
  otherNet.faults.connect = "refuse";
  await other.goto("/");
  await expect(waitingList(other).getByText("two tabs, one message")).toBeVisible();

  await net.online();
  await expect(chat(page).getByText("echo: two tabs, one message")).toBeVisible();
  // The tab that sent it tells the other, which drops it rather than sending it again.
  await expect(waitingList(other)).toHaveCount(0);

  await otherNet.online();
  await expect(chat(other).getByText("echo: two tabs, one message")).toBeVisible();
  await expect(chat(other).getByText("two tabs, one message", { exact: true })).toHaveCount(1);
  await expect(chat(page).getByText("two tabs, one message", { exact: true })).toHaveCount(1);
  expect(carrying([...net.submitted(), ...otherNet.submitted()], "two tabs, one message")).toHaveLength(1);
  await other.close();
});

test("a message that waited offline for hours tells the model so, and the user's bubble stays as written", async ({ page }) => {
  await page.clock.install();
  const net = await network(page);
  await open(page);
  await net.offline();

  await send(page, "written before the tunnel");
  await expect(waitingList(page).getByText("written before the tunnel")).toBeVisible();
  await page.clock.fastForward("03:00:00");

  await net.online();
  // The stand-in model echoes what it was given: the words, and the note after them.
  await expect(chat(page).getByText(/echo: written before the tunnel[\s\S]*written 3h ago while offline, delivered now/)).toBeVisible();
  await expect(chat(page).getByText("written before the tunnel", { exact: true })).toHaveCount(1);

  const [frame] = carrying(net.submitted(), "written before the tunnel");
  expect(frame?.waited).toBeGreaterThanOrEqual(3 * 3_600_000);
});

test("offline, a task's Stop is dimmed and says why, since a stop that landed later would stop the wrong thing", async ({ page }) => {
  const net = await network(page);
  await open(page);

  await send(page, "machine@webmac [delay=60000] a job to stop once back");
  const stop = panel(page).getByRole("button", { name: /^Stop .*job to stop once back/ });
  await expect(stop).toBeEnabled();

  await net.offline();
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute("title", "Offline · works once ky reconnects");

  await net.online();
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(stop).toBeHidden();
});

test("an approval tapped offline shows as made and goes once ky is back", async ({ page }) => {
  const net = await network(page);
  await open(page);
  await connectExecutor(page);
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  await send(page, `tool executor_execute ${JSON.stringify({ code: "approve gmail.send send mail to robin offline" })}`);
  const card = chat(page).getByRole("region", { name: "Approve this app action?" });
  await expect(card.getByText("send mail to robin offline")).toBeVisible();

  await net.offline();

  // The tap shows as made, and the card says it goes once ky is back.
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(chat(page).getByText("Approved offline · goes to ky when it reconnects.")).toBeVisible();
  await expect(panel(page).getByRole("status").filter({ hasText: "1 change waits" })).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/approval-offline.png` });

  await net.online();
  await expect(card).toBeHidden();
  await expect(chat(page).getByText(/did send mail to robin offline/).first()).toBeVisible();
});

/** A word that keeps one run's messages apart from another's on the shared stack. */
const nonce = () => crypto.randomUUID().slice(0, 8);

test("bad network: offline says Offline, and back online it reconnects at once, not after the backoff", async ({ page, context }) => {
  const { connections } = await network(page);
  await open(page);

  await context.setOffline(true);
  await connections.at(-1)!.route.close();
  await expect(pill(page, "Offline")).toBeVisible({ timeout: GRACE_MS + 2_000 });
  await expect(pill(page, "Offline").getByText("Offline", { exact: true })).toBeVisible();

  const text = `sent offline ${nonce()}`;
  await send(page, text);
  // Long enough for partysocket's backoff to reach seconds, had it kept retrying.
  await page.waitForTimeout(12_000);
  const before = connections.length;

  await context.setOffline(false);
  const back = Date.now();
  await expect.poll(() => connections.length).toBeGreaterThan(before);
  expect(connections.at(-1)!.at - back).toBeLessThan(2_000);
  await expect(pill(page, "Connected")).toBeVisible();
  await deliveredOnce(page, connections, text);
});

test("bad network: a half-open socket a message goes into is replaced within the liveness timeout, and the message lands once", async ({ page }) => {
  const { connections, freeze } = await network(page);
  await open(page);
  const dead = connections.at(-1)!;
  freeze(dead);

  const text = `into a dead socket ${nonce()}`;
  const sent = Date.now();
  await send(page, text);
  await expect.poll(() => connections.length, { timeout: PROBE_AFTER_SEND_MS + REPLY_MS + 5_000 }).toBeGreaterThan(connections.indexOf(dead) + 1);
  expect(connections.at(-1)!.at - sent).toBeLessThan(PROBE_AFTER_SEND_MS + REPLY_MS + 2_000);
  expect(dead.pings).toBe(1);
  await deliveredOnce(page, connections, text);
});

test("bad network: a half-open socket that goes quiet is pinged and replaced", async ({ page }) => {
  test.setTimeout(QUIET_MS + REPLY_MS + 30_000);
  const { connections, freeze } = await network(page);
  await open(page);
  const dead = connections.at(-1)!;
  freeze(dead);
  const frozen = Date.now();

  await expect.poll(() => connections.length, { timeout: QUIET_MS + REPLY_MS + 5_000 }).toBeGreaterThan(connections.indexOf(dead) + 1);
  expect(connections.at(-1)!.at - frozen).toBeLessThan(QUIET_MS + REPLY_MS + 2_000);
  expect(dead.pings).toBe(1);
  await expect(pill(page, "Connected")).toBeVisible();
});

test("bad network: a live socket the server keeps answering is never pinged, and a slow one is not taken for dead", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);
  const socket = connections.at(-1)!;

  faults.slowMs = 1_500;
  const text = `slow but sure ${nonce()}`;
  await send(page, text);
  await deliveredOnce(page, connections, text);
  faults.slowMs = 0;

  expect(connections.at(-1)).toBe(socket);
  await expect(pill(page, "Connected")).toBeVisible();
});

test("bad network: refused sockets say Can't reach ky, and the message waits and lands once ky answers", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);

  faults.connect = "refuse";
  await connections.at(-1)!.route.close();
  const text = `while refused ${nonce()}`;
  await send(page, text);
  await expect(pill(page, "Can't reach ky")).toBeVisible({ timeout: UNREACHABLE_AFTER_MS + 2_000 });
  await expect(pill(page, "Can't reach ky").getByText("Can't reach ky · retrying")).toBeVisible();
  await expect(composer(page)).toHaveAttribute("placeholder", "Sends when ky reconnects");

  faults.connect = null;
  await expect(pill(page, "Connected")).toBeVisible({ timeout: 15_000 });
  await deliveredOnce(page, connections, text);
});

test("bad network: sockets that open but never reach ky are replaced and say Can't reach ky", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);

  faults.connect = "black-hole";
  await connections.at(-1)!.route.close();
  const text = `into the void ${nonce()}`;
  await send(page, text);
  await expect(pill(page, "Reconnecting")).toBeVisible({ timeout: GRACE_MS + 2_000 });
  await expect(pill(page, "Can't reach ky")).toBeVisible({ timeout: UNREACHABLE_AFTER_MS + 2_000 });

  faults.connect = null;
  await expect(pill(page, "Connected")).toBeVisible({ timeout: FIRST_FRAME_MS + 5_000 });
  await deliveredOnce(page, connections, text);
});

test("bad network: a flapping socket delivers a message sent through it once, with no duplicate bubble", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);

  faults.flapMs = 400;
  await connections.at(-1)!.route.close();
  await expect.poll(() => connections.length).toBeGreaterThan(2);
  const text = `through the flapping ${nonce()}`;
  await send(page, text);
  await page.waitForTimeout(4_000);

  faults.flapMs = 0;
  await expect(pill(page, "Connected")).toBeVisible({ timeout: 20_000 });
  await deliveredOnce(page, connections, text);
});

test("bad network: frames lost on the way down come back with the snapshot after a reconnect", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);

  faults.dropDown = true;
  const text = `half heard ${nonce()}`;
  await send(page, text);
  await page.waitForTimeout(2_000);
  faults.dropDown = false;

  await connections.at(-1)!.route.close();
  await deliveredOnce(page, connections, text);
});

test("bad network: the pill says why ky is disconnected — reconnecting, can't reach, offline, signed out — and goes back to Connected", async ({ page, context }) => {
  test.setTimeout(120_000);
  const { connections, faults } = await network(page);
  await open(page);

  /** Each state at phone width, with the panel shut and open, then at desktop width, when KY_SHOTS names a folder. */
  const shoot = async (state: string) => {
    if (!SHOTS) return;
    await page.setViewportSize({ width: 420, height: 820 });
    const close = page.getByRole("button", { name: "Close panel" });

    if (await close.isVisible()) await close.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${state}-phone.png` });
    await page.getByRole("button", { name: /^ky: / }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${state}-phone-panel.png` });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${state}-desktop.png` });
  };

  await shoot("connected");

  faults.connect = "black-hole";
  await connections.at(-1)!.route.close();
  await expect(pill(page, "Reconnecting")).toBeVisible({ timeout: GRACE_MS + 2_000 });
  await shoot("reconnecting");
  await expect(pill(page, "Can't reach ky")).toBeVisible({ timeout: UNREACHABLE_AFTER_MS + 2_000 });
  await expect(panel(page).getByRole("status")).toHaveText(/^Can't reach ky/);
  await shoot("unreachable");
  faults.connect = null;
  await expect(pill(page, "Connected")).toBeVisible({ timeout: FIRST_FRAME_MS + 5_000 });

  await context.setOffline(true);
  await connections.at(-1)!.route.close();
  await expect(pill(page, "Offline")).toBeVisible({ timeout: GRACE_MS + 2_000 });
  await shoot("offline");
  await context.setOffline(false);
  await expect(pill(page, "Connected")).toBeVisible({ timeout: 5_000 });

  await context.clearCookies();
  await connections.at(-1)!.route.close();
  await expect(pill(page, "Signed out")).toBeVisible();
  await shoot("signed-out");

  // Signed in again (as in another tab), the socket's next retry gets through by itself, and Sign in goes.
  await signIn(page);
  await expect(pill(page, "Connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
});

test("bad network: a running turn's output comes back after its socket went half-open", async ({ page }) => {
  const { connections, freeze } = await network(page);
  await open(page);
  await send(page, "gate");
  await expect(composer(page)).toHaveAttribute("placeholder", "Steer the running turn");

  const dead = connections.at(-1)!;
  freeze(dead);
  await release(page);
  // The network changed under the page: it checks the socket at once.
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect.poll(() => connections.length, { timeout: REPLY_MS + 5_000 }).toBeGreaterThan(connections.indexOf(dead) + 1);
  await expect(page.getByText(/^tool said: released after/).last()).toBeVisible();
  await expect(composer(page)).toHaveAttribute("placeholder", "Message ky");
});

test("keeps an unanswered message for its own chat when the page switches chats", async ({ page }) => {
  const { connections, faults } = await network(page);
  await open(page);

  // The first socket loses the submit, so it stays unanswered.
  faults.loseSubmits = true;
  await send(page, "held for the main chat");
  await expect.poll(() => connections[0]!.submits).toHaveLength(1);
  faults.loseSubmits = false;

  const chats = page.getByRole("navigation", { name: "Chats" });
  await chats.getByRole("button", { name: "New side chat" }).click();
  await expect(page).toHaveURL(/\?session=/);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  const side = connections.at(-1)!;
  expect(side.session).not.toBe(connections[0]!.session);
  expect(side.submits).toEqual([]);

  // Back in the main chat, its socket sends the message again, and it runs there.
  await chats.getByRole("button", { name: /^Main chat/ }).click();
  await expect(page.getByText("echo: held for the main chat")).toBeVisible();
  expect(side.submits).toEqual([]);
});

test("refuses an image the stand-in model can't read, never resends it, and warns before sending", async ({ page }) => {
  const { connections } = await network(page);

  const attach = async () => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach images" }).click();
    await (await chooser).setFiles([{ name: "pixel.png", mimeType: "image/png", buffer: PIXEL }]);
    await expect(page.getByRole("list", { name: "Images to send" }).getByRole("img")).toHaveCount(1);
  };

  const cantRead = "GPT OSS 120B can't read images. Pick a model that can in Models, or send text only.";

  await mac(page, "1");
  await open(page);
  await pick(page, "Main agent", /Opus/);
  await pick(page, "Fallback", /^GPT OSS 120B/);

  // The Mac goes away unnoticed: the page still shows Claude, so only the server, which asks the Mac, can refuse.
  await mac(page, "leaves");
  await attach();
  await send(page, "what is in this picture");
  await expect(page.getByRole("alert")).toHaveText(cantRead);
  const [refused] = connections[0]!.submits;
  expect(connections[0]!.errors).toEqual([refused]);

  // A dropped socket does not send the refused message again.
  await connections[0]!.route.close();
  await expect.poll(() => connections.length).toBe(2);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  expect(connections[1]!.submits).toEqual([]);

  // With a text-only main model the page warns before anything is sent.
  await page.reload();
  await pick(page, "Main agent", /^GPT OSS 120B/);
  await attach();
  await expect(page.getByRole("alert")).toHaveText(cantRead);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  // Put the purposes back for the other tests.
  await pick(page, "Main agent", /^Glm 5.3 Flash/);
  await pick(page, "Fallback", /^Glm 5.3 Flash/);
});

/** Every URL the page asks for that matches, so a test can see when a lazy chunk loads. */
function requested(page: Page, pattern: RegExp): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (pattern.test(request.url())) urls.push(request.url());
  });

  return urls;
}

test("highlights a code block, loading the highlighter only with the first fence", async ({ page }) => {
  const highlighter = requested(page, /streamdown_code|@streamdown\/code|shiki/);
  await open(page);
  const id = crypto.randomUUID().slice(0, 8);
  await send(page, `plain words ${id}`);
  await expect(page.getByText(`echo: plain words ${id}`)).toBeVisible();
  expect(highlighter).toEqual([]);

  await composer(page).fill(`\`\`\`ts\nconst highlighted${id} = 1;\n\`\`\``);
  await composer(page).press("Enter");
  const token = page.getByText(`highlighted${id}`).last();
  await expect(token).toBeVisible();
  await expect.poll(() => highlighter.length).toBeGreaterThan(0);
  // Shiki colors each token inline; plain text has no color of its own.
  await expect
    .poll(() => token.evaluate((element) => element.closest("pre")?.querySelector("span[style*='color']") !== null))
    .toBe(true);
});

test("totals a machine task's changes before loading the diff viewer, and loads it on open", async ({ page }) => {
  const viewer = requested(page, /pierre/);
  await open(page);
  await send(page, "machine@webmac [diff] change the code");
  const changes = page.getByRole("button", { name: /^Changes/ }).first();
  await expect(changes).toContainText("2 files");
  await expect(changes).toContainText("+3");
  await expect(changes).toContainText("−1");
  expect(viewer).toEqual([]);

  await changes.click();
  await expect.poll(() => viewer.length).toBeGreaterThan(0);
  const file = page.getByRole("button", { name: /a\.ts/ }).first();
  await file.click();
  await expect(page.getByText("const c = 4;").first()).toBeVisible();
});

test("serves the web app manifest and icons to the Home Screen without signing in", async ({ page, playwright }) => {
  await open(page);
  await expect(page.locator("link[rel=manifest]")).toHaveAttribute("href", "/manifest.webmanifest");

  const stranger = await playwright.request.newContext({ baseURL: process.env.KY_STACK_URL });

  try {
    const manifest = await stranger.get("/manifest.webmanifest", { maxRedirects: 0 });
    expect(manifest.status()).toBe(200);
    expect(await manifest.json()).toMatchObject({ name: "ky", display: "standalone" });
    // Each shortcut opens a page the app has an address for.
    const { shortcuts } = Value.Parse(Type.Object({ shortcuts: Type.Array(Type.Object({ url: Type.String() })) }), await manifest.json());
    expect(shortcuts.map((each) => each.url)).toEqual(["/", "/?skills=all", "/?artifacts=all"]);

    const icon = await stranger.get("/icons/icon-512.png", { maxRedirects: 0 });
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");

    // Everything else is refused without Access's sign-in.
    const home = await stranger.get("/", { maxRedirects: 0 });
    expect(home.status()).toBe(401);
    expect(await home.text()).toBe(REFUSED);
  } finally {
    await stranger.dispose();
  }
});

test("opens the page each app shortcut names", async ({ page }) => {
  // Each page covers the chat, so there's no connected chat to wait for.
  await signIn(page);
  await page.goto("/?skills=all");
  await expect(page.getByRole("region", { name: "Skills" })).toBeVisible();
  await page.goto("/?artifacts=all");
  await expect(page.getByRole("region", { name: "Artifacts" })).toBeVisible();
});

/** What the PWA tests' stand-ins hold: the launch consumer ky set, and the badge and tray as each side saw them. */
declare global {
  var kyLaunch: (params: { readonly targetURL?: string }) => void;
  var kyCleared: number;
  var kyClosed: string[];
  var kyBadges: (number | "dot" | "clear")[];
  var kyTray: { title: string; body: string; close(): void }[];
  /** public/sw.js's own registration, as its global scope has it. */
  var registration: ServiceWorkerRegistration;
}

test("opens a shortcut launched into an open ky there, without reloading it", async ({ page }) => {
  // Chromium hands an installed app's launch to its open window (the manifest's launch_handler) through launchQueue.
  await page.addInitScript(() => {
    Object.defineProperty(window, "launchQueue", { configurable: true, value: { setConsumer: (consume: typeof globalThis.kyLaunch) => (globalThis.kyLaunch = consume) } });
  });
  await open(page);
  await page.evaluate(() => Object.assign(window, { notReloaded: true }));

  // Another site's address, and the one already open, change nothing.
  await page.evaluate(() => globalThis.kyLaunch({ targetURL: "https://example.com/?skills=all" }));
  await page.evaluate(() => globalThis.kyLaunch({ targetURL: location.href }));
  await expect(page).toHaveURL(/\/$/);

  await page.evaluate(() => globalThis.kyLaunch({ targetURL: `${location.origin}/?skills=all` }));
  await expect(page.getByRole("region", { name: "Skills" })).toBeVisible();
  await expect(page).toHaveURL(/\/\?skills=all$/);

  await page.evaluate(() => globalThis.kyLaunch({ targetURL: `${location.origin}/` }));
  await expect(page.getByRole("region", { name: "Skills" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
});

test("badges the app icon with ky's notifications in the tray, and opening ky reads them", async ({ page, context }) => {
  // The page's side: the badge it clears and the notifications it closes, as headless Chromium shows none.
  await page.addInitScript(() => {
    globalThis.kyCleared = 0;
    globalThis.kyClosed = [];
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: async () => void globalThis.kyCleared++ });
    Object.defineProperty(ServiceWorkerRegistration.prototype, "getNotifications", {
      configurable: true,
      value: async () => ["The pharmacy", "The bakery"].map((title) => ({ close: () => void globalThis.kyClosed.push(title) }))
    });
  });
  await open(page);
  await expect.poll(() => page.evaluate(() => globalThis.kyCleared)).toBe(1);

  // The stack runs Vite's dev server, where ky doesn't register public/sw.js itself.
  const cdp = await context.newCDPSession(page);

  try {
    const registered = new Promise<string>((resolve) =>
      cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
        const ours = registrations.find((each) => each.scopeURL === new URL("/", page.url()).href && !each.isDeleted);

        if (ours) resolve(ours.registrationId);
      })
    );

    await cdp.send("ServiceWorker.enable");
    await page.evaluate(async () => void (await navigator.serviceWorker.register("/sw.js")));
    const registrationId = await registered;
    const worker = context.serviceWorkers().find((each) => each.url().endsWith("/sw.js")) ?? (await context.waitForEvent("serviceworker"));

    // The worker's side: a stand-in tray for what it shows, and the badge it sets.
    await worker.evaluate(() => {
      globalThis.kyBadges = [];
      globalThis.kyTray = [];
      Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: async (count?: number) => void globalThis.kyBadges.push(count ?? "dot") });
      Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: async () => void globalThis.kyBadges.push("clear") });
      Object.assign(globalThis.registration, {
        showNotification: async (title: string, options: NotificationOptions) => {
          const shown = { title, body: options.body ?? "", close: () => (globalThis.kyTray = globalThis.kyTray.filter((each) => each !== shown)) };

          globalThis.kyTray.push(shown);
        },
        getNotifications: async () => globalThis.kyTray
      });
    });

    const badges = () => worker.evaluate(() => globalThis.kyBadges);
    // src/push.ts's lines: the title, the chat's address, then the text.
    const push = (data: string) => cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(page.url()).origin, registrationId, data });

    /** What the browser does when the user taps or swipes away the tray's first notification. */
    const userCloses = (type: "notificationclick" | "notificationclose") =>
      worker.evaluate((kind) => {
        const [first] = globalThis.kyTray;

        if (kind === "notificationclick") first?.close();
        else globalThis.kyTray = globalThis.kyTray.slice(1);
        const waits: Promise<unknown>[] = [];

        // A plain event standing in for the NotificationEvent, which a page or worker can't make.
        self.dispatchEvent(Object.assign(new Event(kind), { notification: first ?? { close: () => {}, data: { url: "/" } }, waitUntil: (wait: Promise<unknown>) => waits.push(wait) }));

        return Promise.allSettled(waits).then(() => undefined);
      }, type);

    await push("ky\n/\nThe pharmacy closes at six today.");
    await expect.poll(badges).toEqual([1]);
    await push("ky\n/\nAnd the bakery at five.");
    await expect.poll(badges).toEqual([1, 2]);
    await push("ky\n/\nAnd the post office at four.");
    await expect.poll(badges).toEqual([1, 2, 3]);

    // Swiped away, tapped: each recounts what is left, and the last one gone clears the badge.
    await userCloses("notificationclose");
    await expect.poll(badges).toEqual([1, 2, 3, 2]);
    await userCloses("notificationclick");
    await expect.poll(badges).toEqual([1, 2, 3, 2, 1]);
    await userCloses("notificationclose");
    await expect.poll(badges).toEqual([1, 2, 3, 2, 1, "clear"]);

    // Coming back to ky reads what is in the tray: the badge goes and so do ky's notifications.
    await switchAway(page, 1_000);
    await expect.poll(() => page.evaluate(() => globalThis.kyCleared)).toBe(2);
    // The first load had no worker registered yet, so nothing to close then.
    await expect.poll(() => page.evaluate(() => globalThis.kyClosed)).toEqual(["The pharmacy", "The bakery"]);

    // A push with nothing readable in it still shows, as ky's, opening the main chat: Safari drops a page's
    // subscription when its pushes show nothing.
    await push("");
    await expect.poll(() => worker.evaluate(() => globalThis.kyTray.map((shown) => shown.title))).toEqual(["ky"]);
  } finally {
    await page.evaluate(async () => void (await navigator.serviceWorker.getRegistration())?.unregister());
    await cdp.detach();
  }
});

/** Hide the page, let `awayMs` pass on its clock, and show it again, as switching apps on a phone does. */
async function switchAway(page: Page, awayMs: number): Promise<void> {
  await page.evaluate((away) => {
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    setVisibility("hidden");
    const now = Date.now.bind(Date);
    Date.now = () => now() + away;
    setVisibility("visible");
  }, awayMs);
}

test("reopens its socket when the page comes back after a while away, not after a glance", async ({ page }) => {
  const { connections } = await network(page);
  await open(page);
  const before = connections.length;

  await switchAway(page, 2_000);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  expect(connections.length).toBe(before);

  await switchAway(page, 20_000);
  await expect.poll(() => connections.length).toBe(before + 1);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();

  const id = crypto.randomUUID().slice(0, 8);
  await send(page, `back again ${id}`);
  await expect(page.getByText(`echo: back again ${id}`)).toBeVisible();
});

test("tells ky on each socket whether the user is looking, so a reply pushes only once they have left", async ({ page }) => {
  const { connections } = await network(page);
  await open(page);
  const said = () => connections.at(-1)?.watching ?? [];

  await expect.poll(said).toEqual([true]);

  // Gone to another app: said as it hides, before iOS would freeze the socket. Back: said again.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(said).toEqual([true, false]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(said).toEqual([true, false, true]);

  // A new socket after a long time away is told too: ky keeps the word per socket.
  const before = connections.length;
  await switchAway(page, 20_000);
  await expect.poll(() => connections.length).toBe(before + 1);
  await expect.poll(said).toEqual([true]);

  // So is another chat's socket.
  await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
  await expect.poll(() => connections.at(-1)?.session ?? null).not.toBeNull();
  await expect.poll(said).toEqual([true]);
});

test("paints the last chat from the cache before the socket answers, then the snapshot replaces it", async ({ page }) => {
  await open(page);
  const id = crypto.randomUUID().slice(0, 8);
  await send(page, `remember me ${id}`);
  await expect(page.getByText(`echo: remember me ${id}`)).toBeVisible();
  // The view is saved once the chat settles, and as the page is hidden.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(800);

  // ky is unreachable: every socket the reloaded page opens is closed at once.
  let reachable = false;
  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (route) => {
    if (reachable) route.connectToServer();
    else void route.close();
  });
  await page.reload();
  await expect(page.getByText(`echo: remember me ${id}`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeHidden();

  reachable = true;
  await page.reload();
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  await expect(page.getByText(`echo: remember me ${id}`)).toBeVisible();
});

test.describe("voice notes and video", () => {
  // Chromium's stand-in microphone (playwright.config.ts) plays a beep.
  test.use({ permissions: ["microphone"] });

  test("records a voice note, sends a video, and ky plays both back in a card", async ({ page }) => {
    await open(page);
    // Each clip went up before its message; its player plays the file it went up as.
    const fileOf = async (player: Locator) => /\/files\/([0-9a-f]{32})$/.exec((await player.evaluate((element) => element.closest("figure")?.querySelector("audio, video")?.getAttribute("src"))) ?? "")?.[1] ?? "";

    // Record: the strip takes the text's place, with the time and the sound as it comes.
    await page.getByRole("button", { name: "Record a voice note" }).click();
    await expect(page.getByRole("status", { name: /^Recording, 0:0[1-9]/ })).toBeVisible();
    await expect(composer(page)).toBeHidden();

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/voice-recording.png` });

    await page.getByRole("button", { name: "Send voice note" }).click();
    const note = chat(page).getByRole("button", { name: "Play Voice note" });
    await expect(note).toBeVisible();
    await expect(composer(page)).toBeVisible();

    // A video goes up first, then rides with the words.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach images, audio or video" }).click();
    await (await chooser).setFiles(`${REPO}/test/web/fixtures/clip.webm`);
    await expect(page.getByRole("list", { name: "Clips to send" }).getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("progressbar")).toBeHidden();
    await send(page, "what happens in this one");
    await expect(chat(page).getByRole("figure").getByLabel("clip.webm")).toBeVisible();
    await expect(page.getByRole("list", { name: "Clips to send" })).toBeHidden();

    // ky shows the clips back in a card, by their files.
    const voice = await fileOf(note);
    const video = await fileOf(chat(page).getByRole("figure").getByLabel("clip.webm"));
    expect([voice, video]).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), expect.stringMatching(/^[0-9a-f]{32}$/)]);

    const ui = {
      title: "Played back",
      blocks: [
        { type: "audio", src: voice, caption: "Your note" },
        { type: "video", src: video, caption: "Your video" }
      ]
    };

    await send(page, `tool ui ${JSON.stringify(ui)}`);

    const card = chat(page).getByRole("region", { name: "Played back" });
    await expect(card.getByRole("button", { name: "Play Your note" })).toBeVisible();
    await expect(card.getByRole("figure").getByLabel("Your video")).toBeVisible();

    await note.click();
    await expect(chat(page).getByRole("button", { name: "Pause Voice note" })).toBeVisible();

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/voice-and-video.png` });

    if (SHOTS) {
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/voice-and-video-card.png` });
    }
  });

  test("a clip attached offline waits with its message, goes up once ky is back, and the message names its file", async ({ page }) => {
    const net = await network(page);
    await open(page);
    // Offline: the upload can't reach ky either.
    await page.route("**/api/media", (route) => route.abort("internetdisconnected"));
    await net.offline();

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach images, audio or video" }).click();
    await (await chooser).setFiles(`${REPO}/test/web/fixtures/clip.webm`);
    const clips = page.getByRole("list", { name: "Clips to send" });
    await expect(clips.getByRole("listitem")).toHaveCount(1);
    await expect(clips.getByRole("listitem")).toHaveAttribute("title", "Offline · uploads when ky reconnects");
    await expect(page.getByText("The clip didn't upload")).toHaveCount(0);

    await send(page, "a clip from the tunnel");
    await expect(clips).toBeHidden();
    await expect(waitingList(page).getByText(/a clip from the tunnel · clip\.webm/)).toBeVisible();

    // Kept on the device, bytes and all, through a reload.
    await page.reload();
    await expect(waitingList(page).getByText(/a clip from the tunnel · clip\.webm/)).toBeVisible();

    await page.unroute("**/api/media");
    await net.online();
    const player = chat(page).getByRole("figure").getByLabel("clip.webm").last();
    await expect(chat(page).getByText("a clip from the tunnel", { exact: true })).toBeVisible();
    await expect(player).toBeVisible();
    await expect(waitingList(page)).toHaveCount(0);

    // The message went with the file the upload gave it, which plays from ky.
    const [frame] = carrying(net.submitted(), "a clip from the tunnel");
    const file = /file="([0-9a-f]{32})"/.exec(JSON.stringify(frame?.input))?.[1] ?? "";
    expect((await page.request.get(`/files/${file}`)).status()).toBe(200);
    expect(carrying(net.submitted(), "a clip from the tunnel")).toHaveLength(1);
  });

  test("a video with no picture plays as a voice note, and a sound saves to the device", async ({ page }) => {
    await open(page);
    // A download's sound comes as .webm, which ky files as a video.
    const sound = await readFile(`${REPO}/test/web/fixtures/sound.webm`);

    const reply = await page.evaluate(
      async (bytes) => (await fetch("/api/media", { method: "PUT", headers: { "Content-Type": "video/webm" }, body: new Uint8Array(bytes) })).text(),
      [...sound]
    );

    const id = /"id":"([0-9a-f]{32})"/.exec(reply)?.[1] ?? "";

    await send(page, `tool ui ${JSON.stringify({ title: "Listen later", blocks: [{ type: "video", src: id, caption: "how-to-be-calm.webm" }] })}`);

    const card = chat(page).getByRole("region", { name: "Listen later" });
    await expect(card.getByRole("button", { name: "Play how-to-be-calm.webm" })).toBeVisible();
    await expect(card.locator("video")).toHaveCount(0);

    const save = card.getByRole("link", { name: "Save how-to-be-calm.webm" });
    await expect(save).toHaveAttribute("download", "how-to-be-calm.webm");
    const download = page.waitForEvent("download");
    await save.click();
    expect((await download).suggestedFilename()).toBe("how-to-be-calm.webm");

    if (SHOTS) {
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/sound-as-voice-note.png` });
    }
  });

  test("a voice note plays at the speed the user picked, seeks from the keys, and one at a time", async ({ page }) => {
    await open(page);
    const sound = await readFile(`${REPO}/test/web/fixtures/sound.webm`);

    const reply = await page.evaluate(
      async (bytes) => (await fetch("/api/media", { method: "PUT", headers: { "Content-Type": "audio/webm" }, body: new Uint8Array(bytes) })).text(),
      [...sound]
    );

    const id = /"id":"([0-9a-f]{32})"/.exec(reply)?.[1] ?? "";

    const blocks = [
      { type: "audio", src: id, caption: "First" },
      { type: "audio", src: id, caption: "Second" }
    ];

    await send(page, `tool ui ${JSON.stringify({ title: "Two notes", blocks })}`);
    const card = chat(page).getByRole("region", { name: "Two notes" });

    // The speed steps 1×, 1.5×, 2× and back, and every note keeps the user's pick, after a reload too.
    await card.getByRole("button", { name: "Speed 1×, change" }).first().click();
    await card.getByRole("button", { name: "Speed 1.5×, change" }).first().click();
    await expect(card.getByRole("button", { name: "Speed 2×, change" }).first()).toBeVisible();
    await page.reload();
    await expect(card.getByRole("button", { name: "Speed 2×, change" })).toHaveCount(2);

    // The waveform is a slider: End goes to the end, Home back to the start.
    const seek = card.getByRole("slider", { name: "Seek First" });
    await expect(seek).toHaveAttribute("aria-valuemax", "4");
    await seek.focus();
    await page.keyboard.press("End");
    await expect(seek).toHaveAttribute("aria-valuenow", "4");
    await page.keyboard.press("Home");
    await expect(seek).toHaveAttribute("aria-valuenow", "0");

    // Starting one note stops the other.
    await card.getByRole("button", { name: "Play First" }).click();
    await expect(card.getByRole("button", { name: "Pause First" })).toBeVisible();
    await card.getByRole("button", { name: "Play Second" }).click();
    await expect(card.getByRole("button", { name: "Pause Second" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Play First" })).toBeVisible();
    expect(await card.locator("audio").evaluateAll((players) => players.map((player) => (player instanceof HTMLAudioElement ? player.playbackRate : 0)))).toEqual([2, 2]);

    if (SHOTS) {
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/voice-note-speed.png` });
    }

    await card.getByRole("button", { name: "Speed 2×, change" }).first().click();
  });
});

test("Routines sit by Skills in the sidebar: a row a routine, opened in place for its runs, and Stop while one runs", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  const tag = crypto.randomUUID().slice(0, 6);

  const idOf = async (title: string) => {
    const said = chat(page).getByText(new RegExp(`tool said: Created automation \\w+, "${title}"`));

    return /Created automation (\w+),/.exec((await said.textContent()) ?? "")?.[1] ?? "";
  };

  const digest = `Inbox digest ${tag}`;
  await send(page, `tool automation ${JSON.stringify({ action: "create", title: digest, prompt: "sum up the inbox", cron: "0 9 * * 1-5", createdBy: "user" })}`);
  const digestId = await idOf(digest);
  const triage = `Triage ${tag}`;
  await send(page, `tool automation ${JSON.stringify({ action: "create", title: triage, prompt: "gate", cron: "0 * * * *", createdBy: "user" })}`);
  await idOf(triage);
  const weekly = `Weekly review ${tag}`;
  await send(page, `tool automation ${JSON.stringify({ action: "create", title: weekly, prompt: "review the week", cron: "0 16 * * 5", createdBy: "user" })}`);
  await send(page, `tool automation ${JSON.stringify({ action: "pause", id: await idOf(weekly) })}`);

  const sidebar = page.getByRole("navigation", { name: "Chats" });
  await sidebar.getByRole("button", { name: "Routines" }).click();
  await expect(page).toHaveURL(/routines(&|$)/);
  const routines = page.getByRole("region", { name: "Routines" });
  await expect(routines.getByRole("heading", { name: "Routines" })).toBeVisible();
  await expect(routines.getByRole("listitem", { name: weekly })).toContainText("Paused");
  await expect(routines.getByRole("listitem", { name: digest })).toContainText(/Weekdays · 9:00 AM · Next run in/);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/routines-list.png` });

  // Opening a row shows its runs in place, and the address names it.
  const digestRow = routines.getByRole("listitem", { name: digest });
  await digestRow.getByRole("button", { name: new RegExp(digest) }).click();
  await expect(page).toHaveURL(new RegExp(`routines=${digestId}`));
  await expect(digestRow).toContainText("No runs yet");

  // Three runs of the digest, one after another, give it a history.
  for (const count of [1, 2, 3]) {
    await digestRow.getByRole("button", { name: "Run now" }).click();
    // A run still going would skip the next as an overlap, and run now's slot is a second, so each waits.
    await expect(digestRow.getByRole("option", { name: /^Succeeded/ })).toHaveCount(count, { timeout: 30_000 });
    await page.waitForTimeout(1_100);
  }

  await expect(digestRow.getByRole("listbox", { name: "Recent runs" }).getByRole("option", { selected: true })).toHaveCount(1);
  await expect(digestRow.getByRole("region", { name: "Latest run" })).toContainText("Succeeded");
  await expect(digestRow).toContainText("Last run today");
  await expect(digestRow.getByRole("switch")).toHaveAttribute("aria-checked", "true");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/routine-open.png` });

  // A live run: the row says what it's doing, the sidebar pulses, Stop ends it, and a stop is no failure.
  const triageRow = routines.getByRole("listitem", { name: triage });
  await triageRow.getByRole("button", { name: new RegExp(triage) }).click();
  await expect(digestRow.getByRole("region", { name: "Latest run" })).toHaveCount(0);
  await triageRow.getByRole("button", { name: "Run now" }).click();
  await expect(triageRow.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 30_000 });
  await expect(triageRow).toContainText("Running");
  await expect(sidebar.getByRole("status", { name: "A routine is running" })).toBeVisible();

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/routine-running.png` });

  await triageRow.getByRole("button", { name: "Stop" }).click();
  await expect(triageRow.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(triageRow.getByRole("region", { name: "Latest run" })).toContainText("Stopped");
  await release(page);
  await expect(triageRow.getByRole("region", { name: "Latest run" })).toContainText("Stopped");
  await expect(sidebar.getByRole("status", { name: "A routine is running" })).toHaveCount(0);
  await expect(routines).not.toContainText("failed this week");

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/routine-stopped.png` });

  // The switch pauses it, and the head counts one fewer on schedule.
  await triageRow.getByRole("switch").click();
  await expect(triageRow.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(triageRow).toContainText("Paused");
});
