import { describe, expect, it } from "vitest";
import { agoText, LATE_AFTER_MS, withLateNote, withoutLateNote } from "../core/late";
import { projectMessage } from "../core/transcript";
import { withFiles } from "../outbox";

const HOUR = 3_600_000;

describe("a message that waited offline", () => {
  it("tells the model how long it waited, after the words, once the wait is long enough to matter", () => {
    expect(withLateNote("hello", undefined)).toBe("hello");
    expect(withLateNote("hello", LATE_AFTER_MS - 1)).toBe("hello");
    expect(withLateNote("hello", 3 * HOUR)).toBe("hello\n\n<ky-late>(written 3h ago while offline, delivered now)</ky-late>");
  });

  it("puts the note after the last words of a message with images, or as its own words when it has none", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

    expect(withLateNote([image, { type: "text", text: "look" }], 10 * 60_000)).toEqual([
      image,
      { type: "text", text: "look\n\n<ky-late>(written 10 min ago while offline, delivered now)</ky-late>" }
    ]);
    expect(withLateNote([image], 50 * HOUR)).toEqual([image, { type: "text", text: "<ky-late>(written 2 days ago while offline, delivered now)</ky-late>" }]);
  });

  it("says the wait in the fewest words", () => {
    expect([agoText(30_000), agoText(5 * 60_000), agoText(90 * 60_000), agoText(30 * HOUR), agoText(72 * HOUR)]).toEqual(["1 min", "5 min", "2h", "30h", "3 days"]);
  });

  it("keeps the note out of the user's bubble: the thread shows the words as written", () => {
    const late = withLateNote("on my way", 3 * HOUR);
    expect(withoutLateNote("on my way\n\n<ky-late>(written 3h ago while offline, delivered now)</ky-late>")).toBe("on my way");

    expect(projectMessage({ role: "user", content: late, timestamp: 1 }, "1").parts).toEqual([{ type: "text", text: "on my way" }]);
    // A note alone, after images, leaves just the images.
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    expect(projectMessage({ role: "user", content: withLateNote([image], 3 * HOUR), timestamp: 1 }, "1").parts).toEqual([image]);
    // Words that merely mention the tag mid-message are the user's own.
    expect(withoutLateNote("<ky-late>x</ky-late> and more")).toBe("<ky-late>x</ky-late> and more");
  });
});

describe("a clip attached offline", () => {
  it("is named by a stand-in until its upload gives it its own file", () => {
    const standIn = "a".repeat(32);
    const real = "b".repeat(32);
    const other = "c".repeat(32);
    const files = new Map([[standIn, real]]);

    expect(withFiles(`hi\n\n<ky-media kind="audio" file="${standIn}" type="audio/webm">x</ky-media>`, files)).toBe(
      `hi\n\n<ky-media kind="audio" file="${real}" type="audio/webm">x</ky-media>`
    );
    expect(withFiles([{ type: "text", text: `<ky-media file="${other}"></ky-media>` }], files)).toEqual([{ type: "text", text: `<ky-media file="${other}"></ky-media>` }]);
  });
});
