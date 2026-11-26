import { describe, expect, it } from "vitest";
import { money } from "../../src/ui/Spend.tsx";

// The rest of money's cases are in desk-rows.test.ts; this is the edge where cents round up to a dollar.
describe("money", () => {
  it("says a dollar once its cents round to one, not 100¢", () => {
    expect(money(0.996)).toBe("$1.00");
  });
});
