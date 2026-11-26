import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../../src/approvals/contract.ts";
import type { ApprovalAction } from "../../src/approvals/contract.ts";
import { ApprovalCards, ApprovalsContext, askOf, markAnswered, needingYou } from "../../src/ui/Approvals.tsx";
import { Deck } from "../../src/ui/desk/Deck.tsx";
import { DeskPage, needsYou } from "../../src/ui/desk/DeskPage.tsx";

/** Keys, taps and the leaving card are for the browser tests (test/web); here, what the page draws first. */
const ask = (id: string, more: Partial<ApprovalView> = {}): ApprovalView => ({
  id,
  kind: "executor",
  subject: "Gmail",
  summary: `Send the reply for ${id}.`,
  chat: `chat-${id}`,
  createdAt: 1,
  ...more
});

/** The Desk page, with `approvals` waiting across every chat and `waiting` tapped offline. */
const page = (approvals: readonly ApprovalView[], waiting: ReadonlyMap<string, ApprovalAction> = new Map()) =>
  renderToStaticMarkup(
    createElement(
      ApprovalsContext.Provider,
      { value: { approvals, onDecide: async () => undefined, waiting } },
      createElement(DeskPage, { now: 0, onOpen: () => {}, onChats: () => {} })
    )
  );

/** Chat `chat`'s approvals with their footer, as its thread draws them. */
const inChat = (chat: string, approvals: readonly ApprovalView[], waiting: ReadonlyMap<string, ApprovalAction> = new Map()) =>
  renderToStaticMarkup(
    createElement(ApprovalsContext.Provider, { value: { approvals, onDecide: async () => undefined, waiting, onOpenDesk: () => {} } }, createElement(ApprovalCards, { chat }))
  );

describe("the Desk's greeting", () => {
  it("counts what needs the user in words while there are few", () => {
    expect([0, 1, 4, 12].map(needsYou)).toEqual(["Nothing needs you", "One thing needs you", "Four things need you", "12 things need you"]);
  });
});

describe("the deck", () => {
  it("holds what the user can answer from any chat: not one lapsed, put off, or a browser hand-off", () => {
    const all = [ask("a"), ask("lapsed", { lapsedAt: 2 }), ask("later"), ask("handoff", { kind: "browser-handoff" }), ask("b")];

    expect(needingYou(all, new Set([askOf(ask("later"))]), new Map(), new Set()).map((approval) => approval.id)).toEqual(["a", "b"]);
  });

  it("leaves out one tapped offline and one just answered on the page", () => {
    const all = [ask("a"), ask("offline"), ask("answered"), ask("b")];

    expect(needingYou(all, new Set(), new Map([["offline", "accept"]]), new Set([askOf(ask("answered"))])).map((approval) => approval.id)).toEqual(["a", "b"]);
  });

  it("shows the first card as 1 of all, with two edges behind it at most", () => {
    const deck = ["a", "b", "c", "d"].map((id) => ask(id));
    const html = renderToStaticMarkup(createElement(Deck, { deck }));

    expect(html).toContain("Send the reply for a.");
    expect(html).not.toContain("Send the reply for b.");
    expect(html).toContain("1 of 4");
    expect(html).toContain('data-behind="2"');
  });

  it("shows no position or edges for a single card", () => {
    const html = renderToStaticMarkup(createElement(Deck, { deck: [ask("a")] }));

    expect(html).not.toContain(" of 1");
    expect(html).toContain('data-behind="0"');
  });
});

describe("the Desk page", () => {
  it("greets with the count and puts the deck first", () => {
    const html = page([ask("x"), ask("y")]);

    expect(html).toContain("Two things need you");
    expect(html).toContain('aria-label="Only you can decide"');
  });

  it("draws nothing for an empty deck", () => {
    expect(renderToStaticMarkup(createElement(Deck, { deck: [] }))).toBe("");
  });

  it("leaves an approval tapped offline out of the deck and the greeting", () => {
    const html = page([ask("x"), ask("y")], new Map([["x", "accept"]]));

    expect(html).toContain("One thing needs you");
    expect(html).not.toContain("Send the reply for x.");
    expect(html).toContain("Send the reply for y.");
  });

  it("counts what was just answered on the page as gone, until a refusal puts it back", () => {
    markAnswered(ask("x"), true);
    expect(page([ask("x"), ask("y")])).toContain("One thing needs you");
    markAnswered(ask("x"), false);
    expect(page([ask("x"), ask("y")])).toContain("Two things need you");
  });

  it("counts a new ask again when the server reuses an answered approval's id", () => {
    markAnswered(ask("again"), true);
    expect(page([ask("again")])).not.toContain("Send the reply for again.");
    expect(page([ask("again", { createdAt: 2 })])).toContain("Send the reply for again.");
    markAnswered(ask("again"), false);
  });

  it("counts as the chat does: its \"x of y\" and \"more in other chats\" leave out the same ones the greeting does", () => {
    const all = [ask("a", { chat: "main" }), ask("handoff", { chat: "car", kind: "browser-handoff" }), ask("offline", { chat: "car" }), ask("b", { chat: "car" })];
    const waiting = new Map<string, ApprovalAction>([["offline", "decline"]]);

    expect(page(all, waiting)).toContain("Two things need you");
    expect(inChat("main", all, waiting)).toContain(">1 of 2<");
    expect(inChat("main", all, waiting)).toContain("1 more waiting in other chats");
  });

  it("heads the page like Routines: the keyboard on its name, and under it the count, said aloud as it changes", () => {
    const html = page([ask("x")]);

    expect(html).toContain('<h1 tabindex="-1">Desk</h1>');
    expect(html).toContain('<p class="desk-count" aria-live="polite">One thing needs you</p>');
  });

  it("is all clear when nothing waits: no deck, and it says so", () => {
    const html = page([ask("gone", { lapsedAt: 3 })]);

    expect(html).toContain("Nothing needs you");
    expect(html).not.toContain("Only you can decide");
  });
});
