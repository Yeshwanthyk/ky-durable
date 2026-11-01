import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { chatgpt } from "../../cli/runner/cloud.ts";

type Sent = { url: string; headers: Headers; body: Uint8Array };

let server: Server | undefined;

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** The runner's `/chatgpt` relay on a real port, with ChatGPT stood in for by `answer`. */
async function relay(answer: () => Response): Promise<{ url: string; sent: Sent[] }> {
  const sent: Sent[] = [];

  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: new Request(input).url, headers: new Headers(init?.headers), body: new Uint8Array(await new Response(init?.body).arrayBuffer()) });

    return answer();
  };

  server = createServer((request, response) => void chatgpt(request, response, upstream));
  await new Promise<void>((resolve) => server?.listen(0, resolve));

  // SAFETY: a server listening on a port has an AddressInfo address, never a pipe's string.
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/chatgpt`, sent };
}

describe("the cloud machine's ChatGPT relay", () => {
  it("passes a zstd body on as pi sent it, saying it is zstd", async () => {
    const { url, sent } = await relay(() => new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } }));
    const body = zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt" })));

    const answer = await fetch(url, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", "content-encoding": "zstd" }, body });

    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe("data: ok\n\n");
    expect(sent[0]?.headers.get("content-encoding")).toBe("zstd");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer t");
    expect(Buffer.from(sent[0]?.body ?? []).equals(body)).toBe(true);
  });

  it("keeps ChatGPT's own status and drops the encoding fetch already undid", async () => {
    const { url } = await relay(() => new Response('{"detail":"no"}', { status: 401, headers: { "content-type": "application/json", "content-encoding": "gzip" } }));

    const answer = await fetch(url, { method: "POST", body: "{}" });

    expect(answer.status).toBe(401);
    expect(answer.headers.get("content-encoding")).toBeNull();
  });
});
