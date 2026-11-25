import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../../src/approvals/contract.ts";
import { ApprovalCards, ApprovalsContext, DecisionCard, snooze } from "../../src/ui/Approvals.tsx";

/** What a card draws first, as HTML; taps and motion are for the browser tests (test/web). */
const draw = <P extends object>(component: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(component, props));

const ask = (id: string, chat: string, more: Partial<ApprovalView> = {}): ApprovalView => ({
  id,
  kind: "executor",
  subject: "Gmail",
  summary: `Send the reply for ${id}.`,
  chat,
  createdAt: 1,
  ...more
});

/** Chat `chat`'s approvals, as its thread draws them, with `approvals` waiting across every chat. */
const inChat = (chat: string, approvals: readonly ApprovalView[], onOpenDesk?: () => void) =>
  renderToStaticMarkup(
    createElement(
      ApprovalsContext.Provider,
      { value: { approvals, onDecide: async () => undefined, waiting: new Map(), onOpenDesk } },
      createElement(ApprovalCards, { chat })
    )
  );

describe("a decision card", () => {
  it("says what ky wants, its summary, then Later, a quiet Decline and the one primary Approve", () => {
    const html = draw(DecisionCard, { approval: ask("a", "main"), onDecide: () => {}, onLater: () => {} });

    expect(html).toContain('aria-label="Needs you"');
    expect(html).toContain("Approve this app action?</b>");
    expect(html).toContain("Send the reply for a.");
    expect([...html.matchAll(/data-variant="(\w+)"[^>]*>(\w+)</g)].map(([, variant, label]) => `${label}:${variant}`)).toEqual(["Later:quiet", "Decline:quiet", "Approve:primary"]);
  });

  it("shows where it stands only among several, and leaves Later off without a snooze", () => {
    const one = draw(DecisionCard, { approval: ask("a", "main"), onDecide: () => {}, position: { index: 0, of: 1 } });
    const several = draw(DecisionCard, { approval: ask("a", "main"), onDecide: () => {}, position: { index: 0, of: 4 } });

    expect(one).not.toContain("decision-position");
    expect(one).not.toContain("Later");
    expect(several).toContain(">1 of 4<");
  });

  it("takes no other tap once one was made offline, and says so", () => {
    const html = draw(DecisionCard, { approval: ask("a", "main"), onDecide: () => {}, onLater: () => {}, waiting: "accept" });

    expect(html).toContain("Approved offline");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("Later");
  });
});

describe("a decision card with a tap on its way", () => {
  it("takes no second tap: Later, Decline and Approve are all off until it lands or is refused", () => {
    const html = draw(DecisionCard, { approval: ask("a", "main"), onDecide: () => {}, onLater: () => {}, pending: true });

    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("Only your tap approves it");
  });
});

describe("approvals in a chat", () => {
  const waiting = [ask("a", "main"), ask("b", "car"), ask("c", "car"), ask("d", "lisbon", { lapsedAt: 2 })];

  it("counts what waits in other chats, not what expired, and links the Desk", () => {
    const html = inChat("main", waiting, () => {});

    expect(html).toContain(">1 of 3<");
    expect(html).toContain("2 more waiting in other chats");
    expect(html).toContain(">Open Desk</button>");
  });

  it("leaves the link off with no Desk to open, and the footer off with nothing here", () => {
    expect(inChat("main", waiting)).not.toContain("Open Desk");
    expect(inChat("empty", waiting)).toBe("");
  });

  it("stops showing and counting what was put off with Later", () => {
    snooze("b");

    const html = inChat("main", waiting, () => {});

    expect(html).toContain(">1 of 2<");
    expect(html).toContain("1 more waiting in other chats");
    expect(inChat("car", waiting)).not.toContain("Send the reply for b.");
  });
});
