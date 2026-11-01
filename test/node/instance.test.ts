import { describe, expect, it } from "vitest";
import { instanceName } from "../../src/core/instance";

describe("the agent's name", () => {
  it("is the name its owner gave the Worker, trimmed", () => {
    expect(instanceName({ KY_NAME: "squarey" })).toBe("squarey");
    expect(instanceName({ KY_NAME: " squarey " })).toBe("squarey");
  });

  it("is ky where nothing names it", () => {
    expect(instanceName({})).toBe("ky");
    expect(instanceName({ KY_NAME: "" })).toBe("ky");
    expect(instanceName({ KY_NAME: "  " })).toBe("ky");
  });
});
