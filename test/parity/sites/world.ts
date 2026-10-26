import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { vi } from "vitest";
import type { SiteBody, SiteBucket, SiteFiles, SiteObject } from "../../../src/sites/contract";

export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json | undefined };

const text = new TextDecoder();

const bytesOf = (value: string | Uint8Array) => (value instanceof Uint8Array ? value : new TextEncoder().encode(value));

function etagOf(bytes: Uint8Array): string {
  let hash = 2166136261;

  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;

  return hash.toString(16).padStart(8, "0");
}

export type FakeBucket = SiteBucket & { readonly objects: Map<string, Uint8Array>; dump(): Record<string, string> };

export function fakeBucket(seed: Record<string, string> = {}): FakeBucket {
  const objects = new Map<string, Uint8Array>(Object.entries(seed).map(([key, value]) => [key, bytesOf(value)]));

  const head = (key: string): SiteObject | null => {
    const bytes = objects.get(key);

    if (!bytes) return null;
    const etag = etagOf(bytes);

    return { key, size: bytes.byteLength, etag, httpEtag: `"${etag}"` };
  };

  const listed = (key: string): SiteObject[] => {
    const found = head(key);

    return found ? [found] : [];
  };

  return {
    objects,
    dump: () => Object.fromEntries([...objects].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, bytes]) => [key, text.decode(bytes)])),
    head: async (key) => head(key),
    get: async (key): Promise<SiteBody | null> => {
      const found = head(key);
      const bytes = objects.get(key);

      return found && bytes ? { ...found, body: new Response(bytes.slice()).body ?? new ReadableStream(), text: async () => text.decode(bytes) } : null;
    },
    put: async (key, value) => {
      objects.set(key, bytesOf(value).slice());

      return head(key);
    },
    delete: async (keys) => {
      for (const key of keys instanceof Array ? keys : [keys]) objects.delete(key);
    },
    list: async ({ prefix, delimiter }) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const folded = (key: string) => (delimiter === undefined ? -1 : key.indexOf(delimiter, prefix.length));
      const delimitedPrefixes = [...new Set(keys.filter((key) => folded(key) !== -1).map((key) => key.slice(0, folded(key) + 1)))];

      return { objects: keys.filter((key) => folded(key) === -1).flatMap(listed), delimitedPrefixes };
    }
  };
}

export type FakeFile = { readonly body: string; readonly size?: number; readonly fails?: string };

export type FakeFiles = SiteFiles & { readonly reads: string[] };

export function fakeFiles(files: Record<string, FakeFile>): FakeFiles {
  const reads: string[] = [];

  const entries = (root: string) => {
    const under = Object.keys(files).filter((path) => path.startsWith(`${root}/`));
    const folders = new Set(under.flatMap((path) => path.slice(root.length + 1).split("/").slice(0, -1).map((_, at, parts) => `${root}/${parts.slice(0, at + 1).join("/")}`)));

    return [...[...folders].map((path) => ({ path, type: "directory" })), ...under.map((path) => ({ path, type: "file" }))]
      .filter(({ path }) => !path.slice(root.length + 1).split("/").some((part) => part.startsWith(".")))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  };

  const file = (path: string) => {
    const found = files[path];

    if (!found) throw new Error(`ENOENT: no such file, ${path}`);

    return found;
  };

  return {
    reads,
    find: async (root, _pattern, { limit, offset }) => {
      if (!Object.keys(files).some((path) => path.startsWith(`${root}/`))) throw new Error(`ENOENT: no such directory, ${root}`);

      return entries(root).slice(offset, offset + limit);
    },
    stat: async (path) => {
      const found = file(path);

      return { size: found.size ?? new TextEncoder().encode(found.body).byteLength };
    },
    readFile: async (path) => {
      const found = file(path);
      reads.push(path);

      if (found.fails !== undefined) throw new Error(found.fails);

      return new Response(found.body).body ?? new ReadableStream();
    }
  };
}

export function seededRandom() {
  let uuids = 0;
  let bytes = 0;

  return {
    use() {
      vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
        const hex = (++uuids).toString(16).padStart(32, "0");

        // SAFETY: a UUID's shape, 8-4-4-4-12 hex digits.
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
      });
      vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) for (let at = 0; at < array.length; at++) array[at] = (++bytes * 37) % 256;

        return array;
      });
    }
  };
}

export const siteId = (n: number) => n.toString(16).padStart(32, "0");

export type Tool = (args: Record<string, string>, conversation?: number) => Promise<{ text: string; failed: boolean }>;

export function toolOf(extension: Extension): Tool {
  const tool = extension.tools?.[0];

  if (!tool) throw new Error("The site extension has no tool");

  return async (args, conversation = 1) => {
    // SAFETY: the site tool reads only the calling conversation from its api.
    const api = { conversationId: conversation, taskId: 1, callId: "call-1" } as ToolExecutionApi;
    const result = await tool.execute(args, api, BACKGROUND_CONTEXT);

    return { text: (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), failed: result.isError === true };
  };
}

export type Routes = {
  siteRoute(request: Request, env: { readonly FILES: SiteBucket }, url: URL): Promise<Response> | undefined;
  publicSiteRoute(request: Request, env: { readonly FILES: SiteBucket }, url: URL): Promise<Response> | undefined;
};

export function requestOf(routes: Routes, bucket: SiteBucket) {
  const env = { FILES: bucket };

  return async (method: string, path: string): Promise<Json> => {
    const url = new URL(`https://ky.test${path}`);
    const request = new Request(url, { method });
    const response = await (routes.publicSiteRoute(request, env, url) ?? routes.siteRoute(request, env, url));

    if (!response) return null;

    return { status: response.status, headers: [...response.headers].sort(([a], [b]) => (a < b ? -1 : 1)), body: await response.text() };
  };
}
