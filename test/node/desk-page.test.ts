import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../../src/approvals/contract.ts";
import { ApprovalsContext } from "../../src/ui/Approvals.tsx";
import { Deck, deckOf } from "../../src/ui/desk/Deck.tsx";
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

/** The Desk page, with `approvals` waiting across every chat. */
const page = (approvals: readonly ApprovalView[]) =>
  renderToStaticMarkup(
    createElement(
      ApprovalsContext.Provider,
      { value: { approvals, onDecide: async () => undefined, waiting: new Map() } },
      createElement(DeskPage, { now: 0, variantId: "squircle-encre", onOpen: () => {}, onChats: () => {} })
    )
  );

describe("the Desk's greeting", () => {
  it("counts what needs the user in words while there are few", () => {
    expect([0, 1, 4, 12].map(needsYou)).toEqual(["Nothing needs you", "One thing needs you", "Four things need you", "12 things need you"]);
  });
});

describe("the deck", () => {
  it("holds what the user can answer from any chat: not one lapsed, put off, or a browser hand-off", () => {
    const all = [ask("a"), ask("lapsed", { lapsedAt: 2 }), ask("later"), ask("handoff", { kind: "browser-handoff" }), ask("b")];

    expect(deckOf(all, new Set(["later"])).map((approval) => approval.id)).toEqual(["a", "b"]);
  });

  it("shows the first card as 1 of all, with two edges behind it at most", () => {
    const deck = ["a", "b", "c", "d"].map((id) => ask(id));
    const html = renderToStaticMarkup(createElement(Deck, { deck, onAnswered: () => {} }));

    expect(html).toContain("Send the reply for a.");
    expect(html).not.toContain("Send the reply for b.");
    expect(html).toContain("1 of 4");
    expect(html).toContain('data-behind="2"');
  });

  it("shows no position or edges for a single card", () => {
    const html = renderToStaticMarkup(createElement(Deck, { deck: [ask("a")], onAnswered: () => {} }));

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

  it("is all clear when nothing waits: no deck, and it says so", () => {
    const html = page([ask("gone", { lapsedAt: 3 })]);

    expect(html).toContain("Nothing needs you");
    expect(html).not.toContain("Only you can decide");
  });
});
