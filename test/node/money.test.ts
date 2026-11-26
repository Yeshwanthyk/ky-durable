import { describe, expect, it } from "vitest";
import { money } from "../../src/ui/task-progress.ts";

describe("money", () => {
  it("says a cost as people do: dollars from one up, cents under, and under a cent as such", () => {
    expect(money(0.0004)).toBe("<1¢");
    expect(money(0.01)).toBe("1¢");
    expect(money(0.237)).toBe("24¢");
    expect(money(0.996)).toBe("$1.00");
    expect(money(1.239)).toBe("$1.24");
  });
});
