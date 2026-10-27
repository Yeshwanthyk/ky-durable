import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALETTE } from "../../src/sites/embed-theme";

const css = readFileSync(new URL("../../src/ui/scotty.css", import.meta.url), "utf8");

/** A scotty.css block's custom properties, from its selector's first rule. */
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));

  return new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name = "", value = ""]) => [name, value.trim()]));
}

describe("a page's theme in a card", () => {
  it("wears the chat's own colors, in light and dark", () => {
    const light = tokens(":root");
    const dark = tokens('[data-mode="dark"]');


    for (const [token, value] of Object.entries(PALETTE.light)) expect([token, light.get(token)]).toEqual([token, value]);

    for (const [token, value] of Object.entries(PALETTE.dark)) expect([token, dark.get(token)]).toEqual([token, value]);
  });
});
