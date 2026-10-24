import { baseType, MAX_MEDIA_BYTES, mediaKind } from "./media";

// Apart from src/files.ts, which the cloud machine also loads (container/image.inputs): this route is the Worker's alone.

const reply = (status: number, text: string) => new Response(`${text}\n`, { status });

/**
 * PUT /api/media: a clip the user attaches in the composer, a voice note or a video, kept where /files/<id>
 * serves it. Only behind Access: the page uploads it before it sends the message that names it (src/media.ts).
 * The body streams into R2 at the length it declares, so a clip near the limit is never held whole.
 */
export async function uploadMedia(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.method !== "PUT") return reply(405, "Use PUT");
  const type = baseType(request.headers.get("Content-Type") ?? "");

  if (mediaKind(type) === null) return reply(415, "Send an audio or video clip: webm, mp4, mov, m4a, mp3, ogg, wav or flac");
  const size = Number(request.headers.get("Content-Length"));

  if (!Number.isInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) {
    return reply(413, `A clip must be 1 byte to ${MAX_MEDIA_BYTES / 1024 / 1024} MB`);
  }

  if (request.body === null) return reply(400, "Send the clip as the body");
  const id = crypto.randomUUID().replaceAll("-", "");
  const body = request.body.pipeThrough(new FixedLengthStream(size));
  await bucket.put(`files/${id}`, body, { httpMetadata: { contentType: type } });

  return Response.json({ id, url: `/files/${id}` });
}
