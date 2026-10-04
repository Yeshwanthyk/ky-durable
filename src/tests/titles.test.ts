import { describe, expect, it } from "vitest";
import { clean, Titler } from "../titles";

describe("naming chats and tasks", () => {
  it("keeps the first line, without a label, quotes or markdown", () => {
    expect(clean('Title: "Trip to Lisbon"\nmore', 60)).toBe("Trip to Lisbon");
    expect(clean("**Fix the login bug**", 60)).toBe("Fix the login bug");
    expect(clean("\n\n  Summary: Found three flights.  ", 60)).toBe("Found three flights.");
  });

  it("trims a long answer to fit", () => {
    expect(clean("a".repeat(80), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("gives up quietly when the model fails or has nothing", async () => {
    const failing = new Titler(async () => {
      throw new Error("offline");
    });

    const empty = new Titler(async () => "  ");

    expect(await failing.title("Plan a trip")).toBeNull();
    expect(await empty.summary("A report")).toBeNull();
    expect(await new Titler(async () => "Trip plan").title("   ")).toBeNull();
  });
});
