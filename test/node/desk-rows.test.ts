import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkRow } from "../../src/ui/kit/WorkRow.tsx";
import { UndoRow } from "../../src/ui/LastNight.tsx";
import { money } from "../../src/ui/Spend.tsx";

/** What a row draws first, as HTML; opening and its slide are for the browser tests (test/web). */
const draw = <P extends object>(component: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(component, props));

describe("money", () => {
  it("says cents under a dollar and dollars from one", () => {
    expect(money(0)).toBe("0¢");
    expect(money(0.021)).toBe("2¢");
    expect(money(0.84)).toBe("84¢");
    expect(money(1)).toBe("$1.00");
    expect(money(1.237)).toBe("$1.24");
  });

  it("calls a sliver less than a cent, not nothing", () => {
    expect(money(0.004)).toBe("<1¢");
  });

  it("rounds just under a dollar up to cents, not to a dollar sign", () => {
    expect(money(0.994)).toBe("99¢");
  });
});

describe("a work row", () => {
  it("draws its glyph, title, meta and trailing slot, and doesn't open without detail", () => {
    const html = draw(WorkRow, { status: "needs", label: "Started: Moving quotes", title: "Moving quotes", meta: "Started on its own · Today", trailing: "Kept" });

    expect(html).toContain('aria-label="Started: Moving quotes"');
    expect(html).toContain('data-status="needs"');
    expect(html).toContain('<span class="kit-work-title">Moving quotes</span>');
    expect(html).toContain('<span class="kit-work-meta">Started on its own · Today</span>');
    expect(html).toContain('<span class="kit-work-trail">Kept</span>');
    expect(html).not.toContain("aria-expanded");
  });

  it("is a closed disclosure when it has detail, the detail unshown until opened", () => {
    const html = draw(WorkRow, { status: "open", label: "Kitchen renovation", title: "Kitchen renovation", detail: "Updated Tuesday" });

    expect(html).toContain('<button type="button" class="kit-work-row kit-work-opener" aria-expanded="false"');
    expect(html).not.toContain("Updated Tuesday");
  });
});

describe("an undo row", () => {
  const change = { icon: "pencil", title: "Rewrote travel-planning", sub: "You said no red-eyes", busy: false, onUndo: () => {} } as const;

  it("offers Undo beside what changed and why", () => {
    const html = draw(UndoRow, { ...change, undone: false });

    expect(html).toContain("You said no red-eyes");
    expect(html).toContain('aria-label="Undo: Rewrote travel-planning"');
    expect(html).not.toContain("data-settled");
  });

  it("once undone, says so and strikes the change", () => {
    const html = draw(UndoRow, { ...change, undone: true });

    expect(html).toContain("data-settled");
    expect(html).toContain('<span class="kit-work-trail">Undone</span>');
    expect(html).not.toContain("Undo:");
  });

  it("shows why an undo was refused under why the change was made, keeping both", () => {
    const html = draw(UndoRow, { ...change, undone: false, refusal: "The skill changed since" });

    expect(html).toContain('<span class="ledger-reason-line">You said no red-eyes</span>');
    expect(html).toContain('role="status">The skill changed since');
  });
});
