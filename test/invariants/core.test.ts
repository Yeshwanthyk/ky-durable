import Type from "typebox";
import { describe, expect, it } from "vitest";
import { bodyAs, decode, decodeOr, parseAs, parseOr } from "../../src/core/decode";
import { isRefusal, refused } from "../../src/core/refusal";

const Row = Type.Object({ name: Type.String(), count: Type.Integer({ minimum: 0 }) });

describe("decode", () => {
  it("passes a value its schema accepts", () => {
    expect(decode(Row, { name: "a", count: 1 }, "a row")).toEqual({ name: "a", count: 1 });
  });

  it.each([null, undefined, [], "row", { name: "a" }, { name: "a", count: -1 }])("refuses %j, naming what it was", (value) => {
    expect(() => decode(Row, value, "a row")).toThrow("a row isn't what ky expects.");
  });

  it("falls back on a damaged stored value instead of throwing", () => {
    expect(decodeOr(Row, { name: 1 }, null)).toBeNull();
  });
});

describe("parse", () => {
  it("reads JSON its schema accepts", () => {
    expect(parseAs(Row, `{"name":"a","count":2}`, "a row")).toEqual({ name: "a", count: 2 });
  });

  it("says when text isn't JSON at all", () => {
    expect(() => parseAs(Row, "{", "a row")).toThrow("a row isn't JSON.");
  });

  it.each(["{", "null", `{"name":"a"}`, ""])("falls back on the corrupt column %j", (text) => {
    expect(parseOr(Row, text, "default")).toBe("default");
  });

  it("checks a fetch body", async () => {
    await expect(bodyAs(new Response(`{"name":"a","count":0}`), Row, "the body")).resolves.toEqual({ name: "a", count: 0 });
    await expect(bodyAs(new Response("<html>"), Row, "the body")).rejects.toThrow("the body isn't JSON.");
  });
});

describe("refusal", () => {
  it("is one shape, told apart from a result by its key", () => {
    expect(isRefusal(refused("No such chat."))).toBe(true);
    expect(isRefusal({ id: "chat" })).toBe(false);
  });
});
