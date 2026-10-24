import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { retype } from "../file-types";
import { connect, inside } from "./drive";

/**
 * Files stored as video before upload read their tracks: once, each takes the type its tracks give, so a
 * sound kept as .mp4 or .webm sorts under Audio. A real video stays a video, and the pass runs only once.
 */

const encoder = new TextEncoder();

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const length = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, length);
  out.set(encoder.encode(type), 4);
  children.reduce((at, child) => (out.set(child, at), at + child.length), 8);

  return out;
}

/** An MP4 whose tracks have these handlers, with media ahead of its index as a recorder leaves it. */
const mp4 = (...handlers: string[]) =>
  join(
    box("ftyp", encoder.encode("isom")),
    box("mdat", new Uint8Array(64)),
    box("moov", ...handlers.map((handler) => box("trak", box("mdia", box("hdlr", new Uint8Array(8), encoder.encode(handler))))))
  );

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);

  return out;
}

describe("stored files", () => {
  it("take the type their tracks give, once", async () => {
    const name = crypto.randomUUID();
    (await connect(name)).close();
    const lecture = crypto.randomUUID().replaceAll("-", "");
    const clip = crypto.randomUUID().replaceAll("-", "");
    const sound = mp4("soun");
    const video = mp4("vide", "soun");
    await env.FILES.put(`files/${lecture}`, sound);
    await env.FILES.put(`files/${clip}`, video);

    const types = await inside(name, async (agent, state) => {
      // As a deploy from before typing left them: stored as video, and not yet retyped.
      state.storage.sql.exec("DELETE FROM ky_files_typed");
      agent.files.record({ id: lecture, task: "t", name: "lecture.mp4", type: "video/mp4", size: sound.length, caption: null });
      agent.files.record({ id: clip, task: "t", name: "clip.mp4", type: "video/mp4", size: video.length, caption: null });
      await retype(agent.files, env.FILES);
      const first = Object.fromEntries(agent.files.list().map((file) => [file.name, file.type]));

      // A file stored as video after the pass isn't read again.
      state.storage.sql.exec("UPDATE ky_files SET type = 'video/mp4' WHERE id = ?", lecture);
      await retype(agent.files, env.FILES);

      return { first, again: agent.files.list().find((file) => file.id === lecture)?.type };
    });

    expect(types.first).toEqual({ "lecture.mp4": "audio/mp4", "clip.mp4": "video/mp4" });
    expect(types.again).toBe("video/mp4");
  });
});
