import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLog, RECORDER, recorder, recordingOf } from "../../src/browse/teach";

/** The show-me recorder (src/browse/teach.ts) in a page of fake elements: it never logs a value from a field that looks secret. */

class FakeElement {
  readonly tagName: string;
  readonly attributes: Record<string, string>;

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(): FakeElement | null {
    return null;
  }
}

class FakeHTMLElement extends FakeElement {
  innerText = "";
}

class FakeInput extends FakeHTMLElement {
  checked = false;
  value: string;

  constructor(attributes: Record<string, string>, value: string) {
    super("INPUT", attributes);
    this.value = value;
  }

  get type(): string {
    return this.attributes.type ?? "text";
  }
}

class FakeTextArea extends FakeHTMLElement {}

class FakeSelect extends FakeHTMLElement {}

class FakeFrame {
  name = "";

  get top(): FakeFrame {
    return this;
  }
}

type Listener = (event: { target: FakeElement }) => void;

function page() {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, string>();
  const frame = new FakeFrame();

  vi.stubGlobal("window", frame);
  vi.stubGlobal("location", { href: "https://shop.test/checkout" });
  vi.stubGlobal("document", { title: "Checkout", querySelector: () => null });
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
  vi.stubGlobal("addEventListener", (type: string, listener: Listener) => listeners.set(type, listener));
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
  vi.stubGlobal("HTMLSelectElement", FakeSelect);
  recorder(RECORDER);

  const fire = (type: string, target: FakeElement) => listeners.get(type)?.({ target });

  return { fire, log: () => readLog(RECORDER) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const WORDS = ["password", "passcode", "otp", "one-time-code", "cvv", "cvc", "cc-number", "card", "ssn", "pin", "secret", "token", "security-code"];

const cased = (word: string) => fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((upper) => word.split("").map((char, at) => (upper[at] ? char.toUpperCase() : char)).join(""));

const around = (word: string) => fc.tuple(fc.stringMatching(/^[a-z_]{0,6}$/), cased(word), fc.stringMatching(/^[a-z_]{0,6}$/)).map((parts) => parts.join(""));

const secretField = fc.oneof(
  fc.constant({ type: "password" }),
  fc.tuple(fc.constantFrom("name", "id", "autocomplete", "aria-label", "placeholder"), fc.constantFrom(...WORDS).chain(around)).map(([key, value]) => ({ [key]: value }))
);

const value = fc.stringMatching(/^[A-Za-z0-9]{6,40}$/).map((typed) => `typed${typed}`);

describe("the show-me recorder", () => {
  it("logs [hidden] for a field that looks secret, never what was typed, on a change or a click", () => {
    fc.assert(
      fc.property(secretField, value, (attributes, typed) => {
        const { fire, log } = page();
        const input = new FakeInput(attributes, typed);
        fire("change", input);
        fire("click", input);
        const logged = log();

        expect(logged).not.toContain(typed);
        expect(logged).toContain('"value":"[hidden]"');
        vi.unstubAllGlobals();
      })
    );
  });

  it("logs what was typed in an ordinary field, with what the field says it is", () => {
    fc.assert(
      fc.property(fc.constantFrom("q", "search", "email", "city", "quantity", "note"), value, (name, typed) => {
        const { fire, log } = page();
        fire("change", new FakeInput({ name, "aria-label": "Search the shop" }, typed));
        const recording = recordingOf({ logs: [log()], history: { currentIndex: 0, entries: [] } }, 0, { site: "shop.test", instructions: "", at: 0 });

        expect(recording.events.map((event) => event.t)).toEqual(["page", "input"]);
        expect(recording.events[1]).toMatchObject({ value: typed, el: { tag: "input", name, label: "Search the shop" }, url: "https://shop.test/checkout", frame: false });
        vi.unstubAllGlobals();
      })
    );
  });

  it("keeps the newest 300 events, and a read clears the log", () => {
    const { fire, log } = page();
    const button = new FakeHTMLElement("BUTTON");
    button.innerText = "Add to cart";

    for (let count = 0; count < 320; count++) fire("click", button);
    const lines = log().split("\n");

    expect(lines).toHaveLength(300);
    expect(lines.at(-1)).toContain('"text":"Add to cart"');
    expect(log()).toBe("");
  });
});
