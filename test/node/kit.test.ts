import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../../src/ui/kit/Button.tsx";
import { HoldButton } from "../../src/ui/kit/HoldButton.tsx";
import { Segmented, SettingRow } from "../../src/ui/kit/SettingRow.tsx";
import { type GlyphStatus, StatusGlyph } from "../../src/ui/kit/StatusGlyph.tsx";

/** What a kit component draws first, as HTML; holding and arrow keys are for the browser tests (test/web). */
const draw = <P extends object>(component: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(component, props));

describe("a kit button", () => {
  it("is a plain secondary 32px button unless told otherwise", () => {
    expect(draw(Button, { children: "Save" })).toBe('<button type="button" class="kit-button" data-variant="secondary" data-size="32">Save</button>');
  });

  it("carries its variant, size and extra class", () => {
    const html = draw(Button, { variant: "primary", size: 44, className: "wide", children: "Go" });

    expect(html).toContain('class="kit-button wide"');
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('data-size="44"');
  });
});

describe("hold to delete", () => {
  it("draws its label twice: once plain, once as the red fill that starts hidden", () => {
    const html = draw(HoldButton, { children: "Hold to delete", onConfirm: () => {} });

    expect(html).toContain('class="kit-button kit-hold"');
    expect(html).not.toContain("data-held");
    expect(html).toContain(
      'Hold to delete<span class="kit-hold-fill" aria-hidden="true"></span><span class="kit-hold-window" aria-hidden="true"><span class="kit-hold-label">Hold to delete</span></span>'
    );
  });
});

describe("a status glyph", () => {
  const statuses: GlyphStatus[] = ["working", "needs", "done", "failed", "open"];
  const drawing = (status: GlyphStatus) => draw(StatusGlyph, { status }).replace(/<svg[^>]*>|<\/svg>/g, "");

  it("draws each status in its own shape, so none rests on colour", () => {
    expect(new Set(statuses.map(drawing)).size).toBe(statuses.length);
  });

  it("names itself for a screen reader", () => {
    expect(draw(StatusGlyph, { status: "needs" })).toContain('role="img" aria-label="Needs you"');
    expect(draw(StatusGlyph, { status: "done", label: "Sent" })).toContain('aria-label="Sent"');
  });
});

describe("a setting row", () => {
  it("names its group by the label and describes it by the hint, with the control last", () => {
    const html = draw(SettingRow, { label: "Pace", hint: "How often ky looks", children: "control" });
    const labelId = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const hintId = /aria-describedby="([^"]+)"/.exec(html)?.[1];

    expect(html).toContain(`id="${labelId}">Pace</span>`);
    expect(html).toContain(`id="${hintId}">How often ky looks</p>`);
    expect(html).toMatch(/<div class="kit-setting-control">control<\/div><\/div>$/);
  });

  it("leaves the description off when there is no hint", () => {
    expect(draw(SettingRow, { label: "Pace", children: "control" })).not.toContain("aria-describedby");
  });
});

describe("a segmented choice", () => {
  it("is a named radio group whose chosen option alone takes Tab", () => {
    const html = draw(Segmented<"quiet" | "balanced" | "eager">, {
      label: "Pace",
      value: "balanced",
      onChange: () => {},
      options: [
        { value: "quiet", label: "Quiet" },
        { value: "balanced", label: "Balanced" },
        { value: "eager", label: "Eager" }
      ]
    });

    expect(html).toContain('role="radiogroup" aria-label="Pace"');
    expect([...html.matchAll(/aria-checked="(\w+)"[^>]*tabindex="(-?\d)"/g)].map(([, checked, tab]) => `${checked}:${tab}`)).toEqual(["false:-1", "true:0", "false:-1"]);
  });
});
