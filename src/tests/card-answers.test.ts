import { describe, expect, it } from "vitest";
import { answered, card, cardName, compose, decompose, lettered, needsSend, optionState, type Question, sendsOnTap, takesTaps, toggled } from "../ui/card-answers";
import type { Tool } from "../ui/conversation";

const call = (input: string): Tool => ({
  kind: "tool",
  id: "c",
  name: "ui",
  category: "other",
  summary: "ui",
  status: "done",
  input,
  output: "",
  images: [],
  durationMs: null
});

const senders: Question = {
  type: "choice",
  label: "Which should I unsubscribe you from?",
  multiple: true,
  options: [{ label: "Lyft" }, { label: "Audible Canada" }, { label: "Affirm" }]
};

const size: Question = { type: "choice", label: "Size", options: [{ label: "Small" }, { label: "Large" }] };

const name: Question = { type: "input", label: "Name" };

describe("card", () => {
  it("keeps the blocks it knows and skips one it does not, or one that is malformed", () => {
    const shown = card(call(JSON.stringify({ title: "Hi", blocks: [{ type: "text", text: "Hello" }, { type: "chart", points: [1, 2] }, { type: "choice", label: "Pick" }] })));

    expect(shown).toEqual({ title: "Hi", blocks: [{ type: "text", text: "Hello" }] });
  });

  it("shows an image from one of ky's files or an https address, and skips one from anywhere else", () => {
    const file = { type: "image", src: "0123456789abcdef0123456789abcdef", caption: "The page" };
    const web = { type: "image", src: "https://example.com/cat.png" };
    const others = ["javascript:alert(1)", "http://example.com/cat.png", "data:image/png;base64,AA", "/files/../x", "https://a b"];

    const shown = card(call(JSON.stringify({ blocks: [file, web, ...others.map((src) => ({ type: "image", src }))] })));

    expect(shown).toEqual({ blocks: [file, web] });
  });

  it("shows numbers, charts and tables side by side and in tabs, but keeps questions out of columns, where no one answers them", () => {
    const stats = { type: "stats", items: [{ value: 53, label: "PRs" }, { value: "41", label: "ky", series: 1 }] };
    const chart = { type: "chart", kind: "bar", stacked: true, x: ["Fri", "Sat"], series: [{ name: "ky", values: [17, 21] }, { name: "scotty", values: [4, 4] }] };
    const table = { type: "table", columns: ["PR", "Title"], rows: [["#145", "Diagrams"]] };
    const tabs = { type: "tabs", tabs: [{ label: "ky", blocks: [table] }, { label: "scotty", blocks: [{ type: "text", text: "None" }] }] };
    const columns = { type: "columns", columns: [[chart], [tabs]] };
    const asking = { type: "columns", columns: [[chart], [{ type: "choice", label: "Pick", options: [{ label: "A" }] }]] };

    expect(card(call(JSON.stringify({ title: "PRs", subtitle: "Oct 17–19", blocks: [stats, columns, asking] })))).toEqual({ title: "PRs", subtitle: "Oct 17–19", blocks: [stats, columns] });
  });

  it("shows none while its arguments are not JSON yet, or have no block it knows", () => {
    expect(card(call('{"blocks":[{"type":"te'))).toBeNull();
    expect(card(call(JSON.stringify({ blocks: [{ type: "chart" }] })))).toBeNull();
  });
});

describe("a card's answer", () => {
  it("is one question's value as it is, a multiple choice's joined by commas", () => {
    expect(compose([senders], [["Audible Canada", "Affirm"]])).toBe("Audible Canada, Affirm");
    expect(compose([name], [["  Lumi "]])).toBe("Lumi");
  });

  it("is a line per question when there are several, leaving out those with nothing in them", () => {
    expect(compose([size, name], [["Large"], ["Lumi"]])).toBe("Size: Large\nName: Lumi");
    expect(compose([size, name], [["Large"], []])).toBe("Size: Large");
  });

  it("reads back from the message that sent it", () => {
    expect(decompose([senders], "Audible Canada, Affirm")).toEqual([["Audible Canada", "Affirm"]]);
    expect(decompose([size, name], "Size: Large\nName: Lumi")).toEqual([["Large"], ["Lumi"]]);
  });

  it("chooses nothing when the user typed their own words instead", () => {
    expect(decompose([senders], "none of them, thanks")).toEqual([[]]);
    expect(decompose([size, name], "whatever you think")).toEqual([[], []]);
  });

  it("is ready once every question has something in it", () => {
    expect(answered([size, name], [["Large"], [" "]])).toBe(false);
    expect(answered([size, name], [["Large"], ["Lumi"]])).toBe(true);
    expect(answered([], [])).toBe(false);
  });
});

describe("choosing", () => {
  it("waits for Send when there is more than one question or a multiple choice", () => {
    expect(needsSend([senders])).toBe(true);
    expect(needsSend([size, name])).toBe(true);
    expect(needsSend([size])).toBe(false);
    expect(needsSend([name])).toBe(false);
  });

  it("takes taps only as the chat's latest word, before it is answered or sent from", () => {
    expect(takesTaps(true, null, false)).toBe(true);
    expect(takesTaps(false, null, false)).toBe(false);
    expect(takesTaps(true, "Large", false)).toBe(false);
    expect(takesTaps(true, null, true)).toBe(false);
  });

  it("names a card by its title, else its first question", () => {
    expect(cardName({ title: "Inbox", blocks: [size] })).toBe("Inbox");
    expect(cardName({ blocks: [{ type: "text", text: "Hi" }, size] })).toBe("Size");
  });

  it("presses an option of a multiple choice or an answered card, and dims what was not chosen once it takes no taps", () => {
    expect(optionState(true, true, false, true)).toEqual({ pressed: true, dim: false, ticked: true });
    expect(optionState(false, false, false, true)).toEqual({ pressed: undefined, dim: false, ticked: false });
    expect(optionState(false, false, true, false)).toEqual({ pressed: false, dim: true, ticked: false });
  });

  it("sends on the tap only for a single choice alone", () => {
    expect(sendsOnTap([size])).toBe(true);
    expect(sendsOnTap([senders])).toBe(false);
    expect(sendsOnTap([size, name])).toBe(false);
    expect(sendsOnTap([name])).toBe(false);
  });

  it("ticks and unticks a multiple choice's options, and replaces a single choice's", () => {
    expect(toggled(["Lyft"], "Affirm", true)).toEqual(["Lyft", "Affirm"]);
    expect(toggled(["Lyft", "Affirm"], "Lyft", true)).toEqual(["Affirm"]);
    expect(toggled(["Small"], "Large", false)).toEqual(["Large"]);
  });

  it("picks an option by its letter, either case, and nothing past the last", () => {
    if (senders.type !== "choice") throw new Error("senders is a choice");
    expect(lettered(senders, "b")?.label).toBe("Audible Canada");
    expect(lettered(senders, "C")?.label).toBe("Affirm");
    expect(lettered(senders, "d")).toBeUndefined();
    expect(lettered(senders, "Enter")).toBeUndefined();
  });
});
