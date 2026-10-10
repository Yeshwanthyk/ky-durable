/**
 * Fake container registries for `ky deploy`'s image copy (cli/image.ts), on one server, as
 * KY_REGISTRY_BASE_URL points it: `/<host>/…` is the registry at `<host>`.
 *
 * - ghcr.io holds one published image, an index whose linux/amd64 manifest has a config and two
 *   layers, and hands out anonymous pull tokens. Made private, as a new package is, the anonymous
 *   token pulls nothing (403), and only a token asked for with the GitHub token it was given pulls.
 * - registry.cloudflare.com takes pushes with the login the fake Cloudflare API hands out
 *   (`REGISTRY_LOGIN`), and refuses a manifest whose blobs it doesn't have.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { portOf } from "./port.ts";

/** The login `POST containers/registries/registry.cloudflare.com/credentials` answers. */
export const REGISTRY_LOGIN = { username: "v1", password: "registry-password" };

const SOURCE_REPO = "ky-owner/ky-cloud";

const INDEX = "application/vnd.oci.image.index.v1+json";

const MANIFEST = "application/vnd.oci.image.manifest.v1+json";

export type FakeRegistry = {
  url: string;
  /** The published image, `ghcr.io/…@sha256:…` of its index. */
  source: string;
  /** The linux/amd64 manifest's digest, which the account's copy goes by. */
  manifest: string;
  /** Makes the package private: only a pull token asked for with `token` (as Basic's password) pulls. */
  privately: (token: string) => void;
  /** Requests to ghcr.io so far, to see a deploy of an image already copied ask it nothing. */
  pulls: () => number;
  /** Every blob the account's registry holds, by repository. */
  pushed: Map<string, Set<string>>;
  /** Blob pushes so far, to see a second deploy copy nothing. */
  uploads: () => number;
  close: () => Promise<void>;
};

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** What the registry answers or is sent: a JSON document. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const json = (document: Json) => new TextEncoder().encode(JSON.stringify(document));

async function read(message: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];

  for await (const chunk of message) chunks.push(Buffer.from(chunk));

  return new Uint8Array(Buffer.concat(chunks));
}

/** A response's status, headers and body. */
type Answer = { status: number; headers?: Record<string, string>; body?: Uint8Array };

/** One request to a registry: its method, the path after `/<host>/`, its query and its body. */
type Asked = { method: string; path: string; url: URL; authorization?: string; body: () => Promise<Uint8Array> };

const PUSHED = Type.Object({ config: Type.Object({ digest: Type.String() }), layers: Type.Array(Type.Object({ digest: Type.String() })) });

/** The image ghcr.io publishes: an index whose linux/amd64 manifest has a config and two layers. */
function publish() {
  const config = json({ os: "linux", architecture: "amd64", config: { Entrypoint: ["ky", "runner", "cloud"] } });
  const layers = [new TextEncoder().encode("layer one"), new TextEncoder().encode("layer two")];
  const descriptor = (blob: Uint8Array, mediaType: string) => ({ mediaType, digest: sha256(blob), size: blob.byteLength });

  const manifest = json({
    schemaVersion: 2,
    mediaType: MANIFEST,
    config: descriptor(config, "application/vnd.oci.image.config.v1+json"),
    layers: layers.map((layer) => descriptor(layer, "application/vnd.oci.image.layer.v1.tar+gzip"))
  });

  const index = json({
    schemaVersion: 2,
    mediaType: INDEX,
    manifests: [
      { ...descriptor(json({ arm: true }), MANIFEST), platform: { os: "linux", architecture: "arm64" } },
      { ...descriptor(manifest, MANIFEST), platform: { os: "linux", architecture: "amd64" } }
    ]
  });

  return {
    index: sha256(index),
    manifest: sha256(manifest),
    blobs: new Map([config, ...layers].map((blob) => [sha256(blob), blob])),
    manifests: new Map([
      [sha256(index), { content: index, type: INDEX }],
      [sha256(manifest), { content: manifest, type: MANIFEST }]
    ])
  };
}

/** A pull token: the member's when asked for with `secret` as Basic's password, else the anonymous one. */
function pullToken(authorization: string | undefined, secret: string | undefined): Answer {
  const password = Buffer.from(authorization?.replace(/^Basic /, "") ?? "", "base64").toString().split(":")[1];
  const token = secret && password === secret ? "member-token" : "pull-token";

  return { status: 200, headers: { "content-type": "application/json" }, body: json({ token }) };
}

/** 401 without a pull token, 403 for the anonymous one on a private package, else nothing. */
function refused(authorization: string | undefined, secret: string | undefined): Answer | undefined {
  if (authorization !== "Bearer pull-token" && authorization !== "Bearer member-token") return { status: 401 };

  return secret && authorization !== "Bearer member-token" ? { status: 403 } : undefined;
}

/** ghcr.io: pull tokens, and the published image's manifests and blobs; `secret` makes it private. */
function ghcr(image: ReturnType<typeof publish>, asked: Asked, secret: string | undefined): Answer {
  if (asked.path === "token") return pullToken(asked.authorization, secret);

  const refusal = refused(asked.authorization, secret);

  if (refusal) return refusal;
  const [, repo, kind, digest = ""] = /^v2\/(.+)\/(manifests|blobs)\/(sha256:[a-f0-9]{64})$/.exec(asked.path) ?? [];

  if (repo !== SOURCE_REPO) return { status: 404 };
  const found = kind === "manifests" ? image.manifests.get(digest) : { content: image.blobs.get(digest), type: "application/octet-stream" };

  return found?.content ? { status: 200, headers: { "content-type": found.type }, body: found.content } : { status: 404 };
}

/** registry.cloudflare.com: pushes with REGISTRY_LOGIN, refusing a manifest whose blobs it doesn't have. */
class AccountRegistry {
  readonly pushed = new Map<string, Set<string>>();
  readonly #manifests = new Set<string>();
  readonly #sessions = new Set<string>();
  uploads = 0;

  async answer(asked: Asked): Promise<Answer> {
    if (asked.authorization !== `Basic ${Buffer.from(`${REGISTRY_LOGIN.username}:${REGISTRY_LOGIN.password}`).toString("base64")}`) return { status: 401 };
    const [, repo = "", part = ""] = /^v2\/([a-f0-9]+\/[a-z0-9-]+)\/(.+)$/.exec(asked.path) ?? [];
    const held = this.pushed.get(repo) ?? new Set<string>();

    this.pushed.set(repo, held);
    const route = `${asked.method} ${part.replace(/^(blobs\/uploads\/|blobs\/|manifests\/).*$/, "$1")}`;

    if (route === "HEAD blobs/") return { status: held.has(part.slice("blobs/".length)) ? 200 : 404 };

    if (route === "POST blobs/uploads/") return this.#start(repo);

    if (route === "PUT blobs/uploads/") return this.#upload(held, part.slice("blobs/uploads/".length), asked);

    if (route === "HEAD manifests/") return this.#headManifest(`${repo}@${part.slice("manifests/".length)}`);

    if (route === "PUT manifests/") return this.#putManifest(held, repo, part.slice("manifests/".length), await asked.body());

    return { status: 404 };
  }

  #start(repo: string): Answer {
    const session = crypto.randomUUID();

    this.#sessions.add(session);

    return { status: 202, headers: { location: `/registry.cloudflare.com/v2/${repo}/blobs/uploads/${session}` } };
  }

  async #upload(held: Set<string>, session: string, asked: Asked): Promise<Answer> {
    const digest = asked.url.searchParams.get("digest");

    if (!this.#sessions.delete(session) || digest !== sha256(await asked.body())) return { status: 400 };
    held.add(digest);
    this.uploads++;

    return { status: 201 };
  }

  #headManifest(reference: string): Answer {
    return { status: this.#manifests.has(reference) ? 200 : 404, headers: { "docker-content-digest": reference.split("@")[1] ?? "" } };
  }

  #putManifest(held: Set<string>, repo: string, digest: string, body: Uint8Array): Answer {
    const sent: unknown = JSON.parse(new TextDecoder().decode(body));

    if (sha256(body) !== digest || !Value.Check(PUSHED, sent)) return { status: 400 };

    // A manifest whose blobs aren't there is refused, as a registry does.
    if (![sent.config, ...sent.layers].every((blob) => held.has(blob.digest))) return { status: 400 };
    this.#manifests.add(`${repo}@${digest}`);

    return { status: 201 };
  }
}

export async function fakeRegistry(): Promise<FakeRegistry> {
  const image = publish();
  const account = new AccountRegistry();
  let pulls = 0;
  let secret: string | undefined;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.test");
    const [, host, ...rest] = url.pathname.split("/");
    const asked: Asked = { method: request.method ?? "GET", path: rest.join("/"), url, authorization: request.headers.authorization, body: () => read(request) };

    if (host === "ghcr.io") pulls++;
    const answer = host === "ghcr.io" ? ghcr(image, asked, secret) : host === "registry.cloudflare.com" ? await account.answer(asked) : { status: 404 };

    response.writeHead(answer.status, answer.headers).end(answer.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${portOf(server)}`,
    source: `ghcr.io/${SOURCE_REPO}@${image.index}`,
    manifest: image.manifest,
    privately: (token) => {
      secret = token;
    },
    pulls: () => pulls,
    pushed: account.pushed,
    uploads: () => account.uploads,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
