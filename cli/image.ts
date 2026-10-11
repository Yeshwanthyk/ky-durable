/**
 * Copies the cloud machine's image into the account's registry, as Scotty's deploy/image.ts does:
 * Cloudflare runs containers only from registry.cloudflare.com, and ky's image is published to
 * GitHub's registry by .github/workflows/release.yml, pinned by digest in the release.
 *
 * Every manifest and blob is checked against its digest before anything is pushed, and a layer is
 * spooled to disk, never held in memory. A blob the account's registry has already is skipped, so
 * a deploy of the same image copies nothing; and when the release pins a manifest (not an index)
 * the account's registry already holds, the copy asks GitHub's registry nothing at all.
 *
 * GitHub's registry is asked signed out: the package is public. With KY_GHCR_TOKEN (a GitHub token
 * with read:packages) set, the pull token is asked for with it, so a private one pulls too.
 *
 * KY_REGISTRY_BASE_URL points every registry at one server, `<base>/<host>/…`, as
 * CLOUDFLARE_API_BASE_URL points the API; the tests point it at test/fakes/registry.ts.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

/** Where the account's images live. */
export const TARGET = "registry.cloudflare.com";

/** The registries a release's image may come from. */
const SOURCES = new Set(["ghcr.io"]);

const REFERENCE = /^([a-z0-9.-]+)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/;

const INDEXES = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);

const MANIFESTS = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);

const ACCEPT = [...INDEXES, ...MANIFESTS].join(", ");

const Blob = Type.Object({ digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), size: Type.Integer({ minimum: 0 }), mediaType: Type.Optional(Type.String()) });

type Blob = Static<typeof Blob>;

const Index = Type.Object({
  manifests: Type.Array(
    Type.Object({ digest: Type.String(), size: Type.Integer(), mediaType: Type.String(), platform: Type.Optional(Type.Object({ os: Type.String(), architecture: Type.String() })) })
  )
});

const Manifest = Type.Object({ config: Blob, layers: Type.Array(Blob) });

const Token = Type.Object({ token: Type.String() });

/** What the account's registry takes: a short-lived login from the containers API. */
export type RegistryLogin = { username: string; password: string };

export type CopyOptions = {
  /** The release's image, `ghcr.io/<owner>/<name>@sha256:…`. */
  source: string;
  account: string;
  /** The repository in the account's registry. */
  repository: string;
  login: RegistryLogin;
};

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A registry's origin: `https://<host>`, or under KY_REGISTRY_BASE_URL. */
function origin(host: string): string {
  const base = process.env.KY_REGISTRY_BASE_URL;

  return base ? `${base.replace(/\/+$/, "")}/${host}` : `https://${host}`;
}

function failed(step: string, response?: Response, hint = ""): Error {
  return new Error(`Copying the cloud machine's image failed at ${step}${response ? ` (${response.status})` : ""}${hint}`);
}

async function expect(response: Response, status: number, step: string, hint?: string): Promise<void> {
  if (response.status === status) return;
  await response.body?.cancel();
  throw failed(step, response, hint);
}

/** What to do when GitHub's registry refuses the image, as it does a private package signed out. */
function refusedHint(response: Response): string | undefined {
  if (![401, 403, 404].includes(response.status)) return undefined;

  return process.env.KY_GHCR_TOKEN
    ? ": KY_GHCR_TOKEN can't read it; it needs read:packages, and access to the ky-cloud package"
    : ": make the ky-cloud package public on GitHub, or set KY_GHCR_TOKEN to a GitHub token with read:packages";
}

/** The pull token request's sign-in: KY_GHCR_TOKEN as a password (GitHub ignores the user name), else none. */
function sourceLogin(): Record<string, string> {
  const token = process.env.KY_GHCR_TOKEN?.trim();

  return token ? { authorization: `Basic ${Buffer.from(`ky:${token}`).toString("base64")}` } : {};
}

function decode<T extends TSchema>(schema: T, bytes: Uint8Array, step: string): Static<T> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw failed(step);
  }

  if (!Value.Check(schema, parsed)) throw failed(step);

  return parsed;
}

/** Writes a blob to `file`, refusing it unless it has the size and digest its manifest says. */
async function spool(response: Response, blob: Blob, file: string): Promise<void> {
  if (!response.body) throw failed("source blob", response);
  const sum = createHash("sha256");
  let size = 0;

  // SAFETY: fetch's body is a web ReadableStream of bytes; the DOM and node:stream/web types differ only in name.
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        size += chunk.byteLength;

        if (size > blob.size) throw failed(`blob ${blob.digest} size`);
        sum.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(file)
  );

  if (size !== blob.size || `sha256:${sum.digest("hex")}` !== blob.digest) throw failed(`blob ${blob.digest} digest`);
}

/** The registry's pull for `source`, and its linux/amd64 manifest, checked against its digest. */
async function resolve(source: string) {
  const [, host, repo, requested] = REFERENCE.exec(source) ?? [];

  if (!host || !repo || !requested || !SOURCES.has(host)) throw new Error(`The release's image ${source} isn't one ky copies: it must be ghcr.io/<owner>/<name>@sha256:…`);
  const tokenUrl = new URL(`${origin(host)}/token`);

  tokenUrl.searchParams.set("scope", `repository:${repo}:pull`);
  tokenUrl.searchParams.set("service", host);
  const tokenAnswer = await fetch(tokenUrl, { headers: sourceLogin() });

  await expect(tokenAnswer, 200, "the source's token", refusedHint(tokenAnswer));
  const { token } = decode(Token, new Uint8Array(await tokenAnswer.arrayBuffer()), "the source's token");
  const get = (part: string) => fetch(`${origin(host)}/v2/${repo}/${part}`, { headers: { authorization: `Bearer ${token}`, accept: ACCEPT } });

  /** A manifest or index by digest, checked against it. */
  const manifest = async (digest: string) => {
    const answer = await get(`manifests/${digest}`);

    await expect(answer, 200, `manifest ${digest}`, refusedHint(answer));
    const content = new Uint8Array(await answer.arrayBuffer());

    if (sha256(content) !== digest) throw failed(`manifest ${digest} digest`);

    return { content, digest, mediaType: answer.headers.get("content-type")?.split(";")[0]?.trim() ?? "" };
  };

  let chosen = await manifest(requested);

  if (INDEXES.has(chosen.mediaType)) {
    const entry = decode(Index, chosen.content, "the image index").manifests.find((each) => each.platform?.os === "linux" && each.platform.architecture === "amd64");

    if (!entry) throw new Error(`The release's image ${source} has no linux/amd64 image`);
    chosen = await manifest(entry.digest);

    if (chosen.content.byteLength !== entry.size || chosen.mediaType !== entry.mediaType) throw failed("the linux/amd64 manifest");
  }

  if (!MANIFESTS.has(chosen.mediaType)) throw failed(`manifest type ${chosen.mediaType}`);

  return { get, chosen };
}

/** The digest `source`'s linux/amd64 image has, which its copy in the account's registry goes by. */
export async function imageDigest(source: string): Promise<string> {
  return (await resolve(source)).chosen.digest;
}

/** Copies `source`'s linux/amd64 image into the account's registry; returns its reference there. */
export async function copyImage({ source, account, repository, login }: CopyOptions): Promise<string> {
  const base = `${origin(TARGET)}/v2/${account}/${repository}`;
  const authorization = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;

  const target = (method: string, part: string, init: RequestInit = {}) =>
    fetch(part.startsWith("http") ? part : `${base}/${part}`, { ...init, method, headers: { authorization, ...init.headers } });

  // The image workflow pins a linux/amd64 manifest, which the copy goes by: a deploy of an image
  // already copied stops here. A registry holds a manifest only once it has every blob it names.
  const [, host, , pinned] = REFERENCE.exec(source) ?? [];
  const held = host && pinned && SOURCES.has(host) ? await target("HEAD", `manifests/${pinned}`) : undefined;

  await held?.body?.cancel();

  if (held?.status === 200 && held.headers.get("docker-content-digest") === pinned) return `${TARGET}/${account}/${repository}@${pinned}`;
  const { get, chosen } = await resolve(source);
  const image = decode(Manifest, chosen.content, "the image manifest");

  const scratch = await mkdtemp(path.join(tmpdir(), "ky-image-"));

  try {
    const missing: { blob: Blob; file: string }[] = [];

    // Every missing blob is fetched and checked before any is pushed.
    for (const [index, blob] of [image.config, ...image.layers].entries()) {
      const head = await target("HEAD", `blobs/${blob.digest}`);

      if (head.status === 200) continue;
      await expect(head, 404, `checking blob ${blob.digest}`);
      const answer = await get(`blobs/${blob.digest}`);

      await expect(answer, 200, `source blob ${blob.digest}`);
      const file = path.join(scratch, String(index));

      await spool(answer, blob, file);
      missing.push({ blob, file });
    }

    for (const { blob, file } of missing) {
      const started = await target("POST", "blobs/uploads/");

      await expect(started, 202, "starting an upload");
      const location = started.headers.get("location");

      if (!location) throw failed("the upload's location", started);
      const url = new URL(location, `${base}/`);

      // The login goes only where it came from.
      if (url.origin !== new URL(base).origin) throw failed("the upload's location");
      url.searchParams.set("digest", blob.digest);

      // SAFETY: Readable.toWeb of a file stream is a byte stream; Node's fetch takes `duplex`, which RequestInit's types leave out.
      const pushed = await target("PUT", url.toString(), {
        headers: { "content-type": "application/octet-stream", "content-length": String(blob.size) },
        body: Readable.toWeb(createReadStream(file)) as ReadableStream,
        duplex: "half"
      } as RequestInit);

      await expect(pushed, 201, `pushing blob ${blob.digest}`);
    }

    const put = await target("PUT", `manifests/${chosen.digest}`, { headers: { "content-type": chosen.mediaType }, body: chosen.content });

    await expect(put, 201, "pushing the manifest");
    const head = await target("HEAD", `manifests/${chosen.digest}`);

    await expect(head, 200, "checking the manifest");

    if (head.headers.get("docker-content-digest") !== chosen.digest) throw failed("the pushed manifest's digest", head);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return `${TARGET}/${account}/${repository}@${chosen.digest}`;
}
