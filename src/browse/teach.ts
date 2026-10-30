import type { Workspace } from "@cloudflare/computer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Failed, type Recorded, Recording, TEACH_DIR, TeachEvent } from "./contract";

/**
 * Show-me hand-offs: while the user drives ky's browser, a recorder in each frame of the page logs what they click,
 * type and send, with what each element says it is. A field that looks secret by its type, name, id, autocomplete,
 * label or placeholder (a password, a one-time code, a card, a PIN, a token) is logged as [hidden], never its value.
 * That is all the hiding there is: a value the user types into an ordinary field is kept, even one their Vault holds.
 */

export type RecorderOptions = { readonly key: string; readonly cap: number };

export const RECORDER: RecorderOptions = { key: "__ky_teach__", cap: 300 };

/**
 * The recorder, run in a frame as it is: Playwright sends its source to the page, so it reaches nothing outside
 * itself. Each event is a JSON line appended to the frame's window.name, which outlives a navigation in the tab,
 * and to its origin's localStorage; only the newest `cap` are kept.
 */
export function recorder({ key, cap }: RecorderOptions): void {
  if (Object.hasOwn(window, key)) return;
  Object.defineProperty(window, key, { value: true });
  const head = `${key}\n`;
  const SECRET = /pass|otp|one-?time|code|cvv|cvc|csc|card|cc-|ssn|pin|secret|token|security/i;
  const CLICKABLE = "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick]";
  const clip = (text: string | null | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const keep = (lines: string) => {
    const kept = lines.split("\n").filter(Boolean).slice(-cap).join("\n");

    try {
      window.name = head + kept;
    } catch {
      // A frame that can't keep its name still keeps localStorage.
    }

    try {
      localStorage.setItem(key, kept);
    } catch {
      // Storage can be off for a frame; window.name still holds the log.
    }
  };

  const logged = () => {
    const named = window.name.startsWith(head) ? window.name.slice(head.length) : "";
    let stored = "";

    try {
      stored = localStorage.getItem(key) ?? "";
    } catch {
      // As above.
    }

    return stored.length > named.length ? stored : named;
  };

  const labelOf = (element: Element) => {
    const id = element.getAttribute("id") ?? "";
    const label = element.closest("label") ?? (/^[\w-]+$/.test(id) ? document.querySelector(`label[for="${id}"]`) : null);

    return clip(element.getAttribute("aria-label") || label?.textContent || element.getAttribute("title"), 80);
  };

  const field = (element: Element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;

  const secret = (element: Element) => {
    const type = (element.getAttribute("type") ?? "").toLowerCase();

    if (type === "password" || type === "hidden") return true;
    const hints = ["name", "id", "autocomplete", "aria-label", "placeholder"].map((name) => element.getAttribute(name) ?? "");

    return SECRET.test([...hints, labelOf(element)].join(" "));
  };

  const textOf = (element: Element) => {
    if (element instanceof HTMLInputElement) return ["submit", "button", "reset"].includes(element.type) ? clip(element.value, 80) : "";

    return field(element) || !(element instanceof HTMLElement) ? "" : clip(element.innerText, 80);
  };

  const describe = (element: Element) => {
    const attribute = (name: string, max = 80) => clip(element.getAttribute(name), max) || undefined;

    return {
      tag: element.tagName.toLowerCase(),
      text: textOf(element) || undefined,
      label: labelOf(element) || undefined,
      name: attribute("name"),
      id: attribute("id"),
      placeholder: attribute("placeholder"),
      role: attribute("role", 40),
      href: attribute("href", 300),
      type: attribute("type", 40)
    };
  };

  const valueOf = (element: Element) => {
    if (secret(element)) return "[hidden]";

    if (element instanceof HTMLInputElement) return ["checkbox", "radio"].includes(element.type) ? String(element.checked) : clip(element.value, 120);

    if (element instanceof HTMLSelectElement) return clip([...element.selectedOptions].map((option) => option.text).join(", "), 120);

    return element instanceof HTMLTextAreaElement ? clip(element.value, 120) : "";
  };

  const write = (event: { readonly t: string; readonly el?: ReturnType<typeof describe>; readonly value?: string; readonly title?: string }) =>
    keep(`${logged()}\n${JSON.stringify({ ...event, url: location.href.slice(0, 300), frame: window !== window.top, at: Date.now() })}`);

  const target = (event: Event) => (event.target instanceof Element ? event.target : null);

  addEventListener(
    "click",
    (event) => {
      const element = target(event);
      const clicked = element?.closest(CLICKABLE) ?? element;

      if (clicked) write({ t: "click", el: describe(clicked) });
    },
    true
  );

  addEventListener(
    "change",
    (event) => {
      const element = target(event);

      if (element && field(element)) write({ t: "input", el: describe(element), value: valueOf(element) });
    },
    true
  );

  addEventListener(
    "submit",
    (event) => {
      const element = target(event);

      if (element) write({ t: "submit", el: describe(element) });
    },
    true
  );

  write({ t: "page", title: clip(document.title, 120) });
}

/** A frame's log, as JSON lines, cleared once read. */
export function readLog({ key }: RecorderOptions): string {
  const head = `${key}\n`;
  const named = window.name.startsWith(head) ? window.name.slice(head.length) : "";
  let stored = "";

  try {
    stored = localStorage.getItem(key) ?? "";
    localStorage.removeItem(key);
  } catch {
    // Storage can be off for a frame.
  }

  if (named !== "") window.name = "";

  return stored.length > named.length ? stored : named;
}

const eventOf = Schema.decodeUnknownOption(Schema.fromJsonString(TeachEvent));

/** The recording, from what the frames logged and the pages the tab went through since `from`; a line that isn't an event is dropped. */
export function recordingOf(recorded: Recorded, from: number, about: { readonly site: string; readonly instructions: string; readonly at: number }): Recording {
  const events = recorded.logs
    .flatMap((log) => log.split("\n").flatMap((line) => Option.toArray(eventOf(line))))
    .toSorted((a, b) => a.at - b.at)
    .slice(-RECORDER.cap);

  const { entries, currentIndex } = recorded.history;
  const pages = entries.slice(Math.max(0, from), currentIndex + 1).filter((page) => !page.url.startsWith("about:"));

  return { site: about.site, instructions: about.instructions, finishedAt: about.at, pages, events };
}

/** Whether the user did anything ky could learn from: a click, a field or a form, not only pages loading. */
export const showed = (recording: Recording) => recording.events.some((event) => event.t !== "page");

const encode = Schema.encodeEffect(Schema.fromJsonString(Recording));

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Recording));

const failed = (cause: unknown) => new Failed({ said: cause instanceof Error ? cause.message : String(cause) });

/** Keep the recording in the workspace, as JSON under /workspace/teach; its path. */
export function keepRecording(fs: Workspace["fs"], recording: Recording) {
  const path = `${TEACH_DIR}/${recording.site.replace(/[^\w.-]/g, "_")}-${recording.finishedAt}.json`;

  return encode(recording).pipe(
    Effect.mapError(failed),
    Effect.flatMap((json) =>
      Effect.tryPromise({
        try: async () => {
          await fs.mkdir(TEACH_DIR, { recursive: true });
          await fs.writeFile(path, json);
        },
        catch: failed
      })
    ),
    Effect.as(path)
  );
}

export function readRecording(fs: Workspace["fs"], path: string) {
  return Effect.tryPromise({ try: () => fs.readFile(path, { encoding: "utf8" }), catch: failed }).pipe(Effect.flatMap((json) => Effect.mapError(decode(json), failed)));
}

const quoted = (text: string | undefined) => (text ? `"${text}"` : "");

function elementText(event: TeachEvent): string {
  const el = event.el ?? {};
  const named = [el.label, el.text, el.placeholder].find(Boolean);
  const kind = el.role ?? (el.tag === "input" && el.type ? `${el.type} field` : el.tag === "a" ? "link" : (el.tag ?? "element"));
  const ids = [el.name ? `name=${el.name}` : "", el.id ? `id=${el.id}` : "", el.href ? `href=${el.href}` : ""].filter(Boolean).join(", ");

  return [kind, quoted(named), ids ? `(${ids})` : ""].filter(Boolean).join(" ");
}

function stepText(event: TeachEvent): string {
  const where = `${event.frame ? "in a frame of " : "on "}${event.url}`;

  if (event.t === "page") return `page ${quoted(event.title)} ${where}`;

  if (event.t === "click") return `clicked ${elementText(event)} ${where}`;

  if (event.t === "submit") return `sent the form ${elementText(event)} ${where}`;

  return `set ${elementText(event)} to ${event.value === "[hidden]" ? "[hidden]" : quoted(event.value)} ${where}`;
}

/** The recording as the skill draft reads it: the pages, then each step in order. */
export function demoText(recording: Recording, path: string): string {
  const pages = recording.pages.map((page, index) => `${index + 1}. ${quoted(page.title) || "(untitled)"} ${page.url}`);
  const steps = recording.events.map((event, index) => `${index + 1}. ${stepText(event)}`);

  return [
    `Site: ${recording.site}`,
    `What the user was asked to show: ${recording.instructions}`,
    `The recording is kept in ${path}.`,
    "<recording>",
    `Pages, in order:\n${pages.join("\n") || "(none)"}`,
    `Steps, in order:\n${steps.join("\n")}`,
    "</recording>"
  ].join("\n");
}
