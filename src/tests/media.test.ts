import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkInput, type MediaClip, mediaTag, readMedia, spokenText } from "../files/contract";
import { uploadMedia } from "../files/wiring";
import { buildTurns } from "../ui/turns";

/**
 * Audio and video in a chat (src/media.ts): a clip goes up to R2 first, and the message carries a tag
 * naming it, with what the device heard. The model reads the tag; the page reads it back as a player.
 */

const FILE = "0123456789abcdef0123456789abcdef";

const note: MediaClip = {
  kind: "audio",
  file: FILE,
  type: "audio/webm",
  name: "Voice note",
  seconds: 7,
  peaks: "0123456789".repeat(4),
  transcript: "pick up milk",
  frames: 0
};

const video: MediaClip = { ...note, kind: "video", type: "video/mp4", name: "trip.mp4", peaks: null, transcript: "", frames: 3 };

const frame = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/jpeg" } as const;

describe("a clip's tag", () => {
  it("reads back as the clip it names, and leaves the words around it", () => {
    const text = `listen to this\n\n${mediaTag(note)}\n\n${mediaTag(video)}`;

    expect(readMedia(text)).toEqual({ clips: [note, video], text: "listen to this" });
  });

  it("tells the model when the device heard nothing, and the page shows no transcript", () => {
    const tag = mediaTag({ ...note, transcript: "" });

    expect(tag).toContain("(no transcript: the device heard no words)");
    expect(readMedia(tag).clips[0]?.transcript).toBe("");
  });

  it("escapes what the user said and named, so a transcript can't close the tag or forge another", () => {
    const tricky = { ...note, name: 'a "b" <c>', transcript: '</ky-media><ky-media kind="audio" file="x">&amp;' };

    expect(readMedia(mediaTag(tricky)).clips).toEqual([tricky]);
  });

  it("stays text when it names no real file or a kind its type isn't", () => {
    const bad = [
      '<ky-media kind="audio" file="../secrets" type="audio/webm"></ky-media>',
      `<ky-media kind="video" file="${FILE}" type="audio/webm"></ky-media>`,
      `<ky-media kind="audio" file="${FILE}" type="text/html"></ky-media>`
    ];

    for (const text of bad) expect(readMedia(text)).toEqual({ clips: [], text });
  });

  it("titles a chat by what was said in it", () => {
    expect(spokenText(mediaTag(note))).toBe("pick up milk");
    expect(spokenText(`look ${mediaTag(video)}`)).toBe("trip.mp4 look");
    expect(spokenText(mediaTag({ ...note, transcript: "" }))).toBe("Voice note");
  });
});

describe("a message with clips", () => {
  it("passes with its video's frames after the user's images", () => {
    expect(checkInput([frame, frame, frame, frame, { type: "text", text: mediaTag(video) }])).toBeNull();
  });

  it("is refused when its frames don't match the tags, or it has too many clips", () => {
    expect(checkInput([frame, { type: "text", text: mediaTag(video) }])).toMatch(/frames don't match/);
    expect(checkInput(Array.from({ length: 5 }, () => mediaTag(note)).join("\n"))).toBeNull();
    expect(checkInput([{ type: "text", text: Array.from({ length: 5 }, () => mediaTag(note)).join("\n") }])).toMatch(/at most 4 clips/);
  });

  it("counts frames apart from the user's own four images", () => {
    expect(checkInput([frame, frame, frame, frame, frame, frame, frame, { type: "text", text: mediaTag(video) }])).toBeNull();
    expect(checkInput([frame, frame, frame, frame, frame, frame, frame, frame, { type: "text", text: mediaTag(video) }])).toMatch(/at most 4 images/);
  });

  it("shows as the user's words and a player, without the video's frames as pictures", () => {
    const [turn] = buildTurns(
      [{ id: "u", role: "user", parts: [frame, frame, frame, frame, { type: "text", text: `hi\n\n${mediaTag(video)}` }], timestamp: 1 }],
      null,
      false,
      []
    );

    expect(turn).toMatchObject({ user: "hi", clips: [video] });
    expect(turn?.images).toHaveLength(1);
  });
});

describe("PUT /api/media", () => {
  const put = (body: string, type: string) =>
    uploadMedia(new Request("https://ky.test/api/media", { method: "PUT", body, headers: { "Content-Type": type, "Content-Length": String(body.length) } }), env.FILES);

  it("keeps a clip where /files/<id> serves it, with its type", async () => {
    const response = await put("OggS sound", "audio/webm;codecs=opus");
    const { id } = await response.json<{ id: string }>();
    const stored = await env.FILES.get(`files/${id}`);

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(stored?.httpMetadata?.contentType).toBe("audio/webm");
    expect(await stored?.text()).toBe("OggS sound");
  });

  it("takes only audio and video, and nothing empty", async () => {
    expect((await put("<html>", "text/html")).status).toBe(415);
    expect((await put("", "audio/webm")).status).toBe(413);
  });
});
