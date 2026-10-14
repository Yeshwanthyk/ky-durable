import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { decodeServerFrame, parsed } from "../../src/tests/frames.ts";
import { ANTHROPIC_KEY } from "../fakes/vendors.ts";
import { machine as pairable } from "../harness/runner.ts";
import { accessCookie } from "../../src/tests/fake-access.ts";
import { REPO } from "../harness/stack.ts";

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

  for (const row of rows) await panel(page).getByRole("button", { name: new RegExp(`^${row}`) }).first().click();
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

const Submit = Type.Object({ type: Type.Literal("submit"), id: Type.String(), operationId: Type.String() });

/** One socket the page opened: the session it asked for, the submits it sent and the answers it got. */
type Connection = {
  session: string | null;
  submits: string[];
  results: Array<{ id: string; result: JsonValue }>;
  errors: string[];
  route: WebSocketRoute;
};

/**
 * The network between the page and ky, seen frame by frame. It can lose the
 * page's submits on the way in, or drop the socket just as a submit's answer
 * comes back, as a flaky connection would.
 */
async function network(page: Page) {
  const connections: Connection[] = [];
  const faults = { loseSubmits: false, dropOnAnswer: false };

  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (route) => {
    const connection: Connection = {
      session: new URL(route.url()).searchParams.get("session"),
      submits: [],
      results: [],
      errors: [],
      route
    };

    connections.push(connection);
    const server = route.connectToServer();

    route.onMessage((message) => {
      const value = parsed(String(message));
      const submit = Value.Check(Submit, value) ? value : undefined;

      if (submit) connection.submits.push(submit.operationId);

      if (submit && faults.loseSubmits) return;

      server.send(message);
    });

    server.onMessage((message) => {
      const answered = record(connection, String(message));

      if (answered !== undefined && faults.dropOnAnswer && connection.submits.includes(answered)) {
        faults.dropOnAnswer = false;
        void route.close();

        return;
      }

      route.send(message);
    });
  });

  return { connections, faults };
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

test("reloads into Access's sign-in when the socket drops after the sign-in lapses", async ({ page }) => {
  const closers: Array<() => Promise<void>> = [];

  await page.routeWebSocket(/\/agents\/pi-agent\/me/, (socket) => {
    const server = socket.connectToServer();
    closers.push(() => socket.close());
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
  });

  await open(page);
  await page.context().clearCookies();
  await closers.at(-1)!();

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
  await expect(chat(page).getByRole("button", { name: "What's connected" })).toBeVisible();

  await cards.getByRole("button", { name: /Tell ky who you are/ }).click();
  await expect(chat(page).getByText(/^Interview me so you know who I am/).first()).toBeVisible();
});

test("streams the answer to a message", async ({ page }) => {
  await open(page);
  await send(page, "hello from the browser");
  await expect(page.getByText("echo: hello from the browser")).toBeVisible();
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
  await chats.getByRole("button", { name: "Main chat" }).click();
  await expect(side.getByRole("img", { name: "New" })).toBeHidden();
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
    await expect(providers.getByRole("listitem").filter({ hasText: "Anthropic" })).toContainText("3 models");
    await expect(key).toHaveValue("");
    await expect(providers.getByRole("alert")).toBeHidden();
    await settings(page, "Models");
    await expect(main).toContainText("· Anthropic");
  } finally {
    await settings(page, "Providers");
    await providers.getByRole("button", { name: "Remove the Anthropic key" }).click();
    await expect(providers.getByRole("listitem").filter({ hasText: "Anthropic" })).toHaveCount(0);
    await settings(page, "Models");
    await expect(main).toContainText("Glm 5.3 Flash · Workers AI");
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

  await expect(subscriptions.getByText("Pair a machine first; Claude Code and Codex run there.")).toBeVisible();
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
    expect(input?.width).toBeGreaterThan(180);
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

  await panel(page).getByRole("tab", { name: "Skills" }).click();
  const skill = panel(page).getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(`^${name}`) }) });
  await skill.getByRole("button", { name: new RegExp(`^${name}`) }).click();
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

// Crons are UTC and rows show them in the browser's time: India's half-hour offset shows the conversion.
test.describe("automations in Activity", () => {
  test.use({ timezoneId: "Asia/Kolkata", locale: "en-US" });

  test("pauses, resumes and archives an automation from Activity", async ({ page }) => {
    await open(page);
    const title = `Check the news ${crypto.randomUUID().slice(0, 8)}`;
    const create = { action: "create", title, prompt: "Read the news and sum it up.", cron: "0 9 * * 1-5" };
    await send(page, `tool automation ${JSON.stringify(create)}`);
    await expect(page.getByText(`"${title}" (cron 0 9 * * 1-5 UTC)`)).toBeVisible();

    await panel(page).getByRole("tab", { name: "Activity" }).click();
    const automation = panel(page).getByRole("listitem", { name: title });
    await expect(automation).toContainText("Weekdays · 2:30 PM");
    await expect(automation).toContainText(" · in ");

    await automation.getByRole("button", { name: "Pause" }).click();
    await expect(automation).toContainText("Paused");

    await automation.getByRole("button", { name: "Resume" }).click();
    await expect(automation).toContainText(" · in ");
    await expect(automation.getByRole("button", { name: "Pause" })).toBeVisible();

    await automation.getByRole("button", { name: "Edit" }).click();
    await panel(page).getByRole("form", { name: "Edit automation" }).getByRole("button", { name: "Archive" }).click();
    await expect(automation).toBeHidden();
  });

  test("adds, edits, runs and deletes an automation from Activity", async ({ page }) => {
    await open(page);
    await panel(page).getByRole("tab", { name: "Activity" }).click();
    const title = `Water the plants ${crypto.randomUUID().slice(0, 8)}`;

    await panel(page).getByRole("button", { name: "New", exact: true }).click();
    const form = panel(page).getByRole("form", { name: "New automation" });
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("Prompt").fill("say the plants are watered");
    await form.getByLabel("Cron").fill("nope");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("alert")).toContainText('Cannot schedule "nope"');

    await form.getByLabel("Cron").fill("30 7 * * *");
    await expect(form).toContainText("Daily · 1:00 PM, your time");
    await form.getByRole("button", { name: "Save" }).click();
    const automation = panel(page).getByRole("listitem", { name: title });
    await expect(automation).toContainText("Daily · 1:00 PM");

    await automation.getByRole("button", { name: "Edit" }).click();
    const edit = panel(page).getByRole("form", { name: "Edit automation" });
    await expect(edit.getByLabel("Title")).toHaveValue(title);
    await edit.getByLabel("Cron").fill("0 8 * * 1");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(automation).toContainText("Mondays · 1:30 PM");

    await automation.getByRole("button", { name: "Run now" }).click();
    await expect(automation).toContainText(/Ran (just now|\d+[mhd] ago)|Running/);

    await automation.getByRole("button", { name: "Edit" }).click();
    await edit.getByRole("button", { name: "Delete" }).click();
    await edit.getByRole("button", { name: "Delete for good" }).click();
    await expect(panel(page).getByRole("listitem", { name: title })).toBeHidden();
  });
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

  await task.click();
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
  await expect(panel(page).getByText(/run this before \d/)).toBeVisible();
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
  await expect(panel(page).getByRole("list", { name: "Recent steps" })).toContainText("Running pnpm build");
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

  await card.click();
  const item = panel(page).getByRole("listitem").filter({ has: page.getByRole("button", { name }) });
  await expect(item.getByText("web", { exact: true })).toBeVisible();
  await expect(item).not.toContainText("*");
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
  const on = panel(page).getByRole("button", { name: "Check-ins on" });
  await expect(on).toHaveAttribute("aria-pressed", "true");
  await panel(page).getByRole("heading", { name: /^Automations/ }).screenshot({ path: SHOTS ? `${SHOTS}/check-ins-on.png` : undefined });

  await on.click();
  const off = panel(page).getByRole("button", { name: "Check-ins off" });
  await expect(off).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await panel(page).getByRole("tab", { name: "Activity" }).click();
  // The stack is shared: leave check-ins on.
  await panel(page).getByRole("button", { name: "Check-ins off" }).click();
  await expect(panel(page).getByRole("button", { name: "Check-ins on" })).toBeVisible();
});

test("lists automations above the history, and only recent tasks until Show earlier", async ({ page }) => {
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

  const automations = panel(page).getByRole("heading", { name: /^Automations/ });
  expect((await automations.boundingBox())!.y).toBeLessThan((await jobs.first().boundingBox())!.y);

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
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

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
