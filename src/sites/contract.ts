import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import type { Refusable } from "../core/edge";

export const SITE_TOOL = "site";

export const MAX_FILES = 200;

export const MAX_BYTES = 10 * 1024 * 1024;

export const MAX_SITES = 50;

export const META = ".site";

export const SITE_ID = /^[0-9a-f]{32}$/;

export const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

export const siteKey = (id: string, path: string) => `sites/${id}/${path}`;

export const publicKey = (token: string) => `sites-public/${token}`;

const SiteMeta = Schema.StructWithRest(
  Schema.Struct({ title: Schema.String, created: Schema.Number, token: Schema.optionalKey(Schema.String), app: Schema.optionalKey(Schema.Boolean) }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export type SiteMeta = typeof SiteMeta.Type;

const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(SiteMeta));

export const metaOr = (text: string): SiteMeta | undefined => Option.getOrUndefined(decodeMeta(text));

export const SITE_TABLES = { sites: "ky_sites", links: "ky_site_links", items: "ky_site_items", edits: "ky_site_edits" } as const;

export const MAX_ITEM_BYTES = 32 * 1024;

export const MAX_ITEMS = 2000;

export const MAX_COLLECTIONS = 50;

export const MAX_LINKS = 50;

export const EDIT_BATCH_MS = 30_000;

export const COLLECTION = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const LINK_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** The paths a site's own files can't take: its data and its version are served there. */
export const reserved = (path: string) => ["_data", "_version"].includes(path.split("/")[0] ?? "");

export const LinkMode = Schema.Literals(["view", "edit"]);

export type LinkMode = typeof LinkMode.Type;

export const RouteMode = Schema.Literals(["view", "edit", "owner"]);

export type RouteMode = typeof RouteMode.Type;

const Route = Schema.Struct({ site: Schema.String, mode: RouteMode });

export type Route = typeof Route.Type;

const decodeRoute = Schema.decodeUnknownOption(Schema.fromJsonString(Route));

export const routeText = (route: Route) => JSON.stringify(route);

/** A link's route in the bucket: its JSON, or, from before links, the bare site id the one public token served, a view. */
export const routeOr = (text: string): Route | undefined =>
  SITE_ID.test(text) ? { site: text, mode: "view" } : Option.getOrUndefined(Option.filter(decodeRoute(text), (route) => SITE_ID.test(route.site)));

const SiteLink = Schema.Struct({ token: Schema.String, label: Schema.String, mode: LinkMode, created: Schema.Number, revoked: Schema.Boolean });

export type SiteLink = typeof SiteLink.Type;

const SiteItem = Schema.Struct({ key: Schema.String, value: Schema.Json, updated: Schema.Number });

export type SiteItem = typeof SiteItem.Type;

const SiteVersion = Schema.Struct({ published: Schema.Number, data: Schema.Number });

export type SiteVersion = typeof SiteVersion.Type;

export interface SiteRow {
  readonly id: string;
  readonly title: string;
  readonly created: number;
  readonly public: boolean;
}

export const ShareBody = Schema.Struct({ label: Schema.optionalKey(Schema.String), mode: Schema.optionalKey(LinkMode) });

export type DataOp =
  | { readonly op: "collections" }
  | { readonly op: "list"; readonly collection: string }
  | { readonly op: "get"; readonly collection: string; readonly key: string }
  | { readonly op: "put"; readonly collection: string; readonly key: string; readonly value: Schema.Json }
  | { readonly op: "remove"; readonly collection: string; readonly key: string };

export type DataCaller = { readonly kind: "owner" } | { readonly kind: "link"; readonly token: string };

export type DataAnswer = { readonly status: number; readonly body: Schema.Json };

export const SiteArgs = Type.Object({
  action: Type.Union([
    Type.Literal("publish"),
    Type.Literal("list"),
    Type.Literal("make_public"),
    Type.Literal("make_private"),
    Type.Literal("share"),
    Type.Literal("revoke"),
    Type.Literal("read_data"),
    Type.Literal("write_data"),
    Type.Literal("remove_data"),
    Type.Literal("delete")
  ]),
  id: Type.Optional(Type.String({ description: "The site, for every action but list; for publish, the site whose files to replace." })),
  title: Type.Optional(Type.String({ description: "publish: the site's title." })),
  html: Type.Optional(Type.String({ description: "publish: one HTML page, served as the site's index.html." })),
  dir: Type.Optional(Type.String({ description: "publish: a workspace folder, such as /workspace/site, served with its index.html at the root." })),
  app: Type.Optional(Type.Boolean({ description: "publish: a living site, whose pages get window.ky.data and reload when it changes. Kept on a republish when left out." })),
  label: Type.Optional(Type.String({ description: 'share: who the link is for, like "Sam".' })),
  mode: Type.Optional(Type.Union([Type.Literal("view"), Type.Literal("edit")], { description: "share: view (the default) only reads; edit also writes the site's data." })),
  token: Type.Optional(Type.String({ description: "revoke: the link's token, as list shows it." })),
  collection: Type.Optional(Type.String({ description: "read_data, write_data, remove_data: the collection. read_data without one lists the collections." })),
  key: Type.Optional(Type.String({ description: "read_data, write_data, remove_data: the item's key. read_data without one lists the collection's items." })),
  value: Type.Optional(Type.Unknown({ description: "write_data: the item, any JSON value." }))
});

export type SiteArgs = Static<typeof SiteArgs>;

export interface SiteFiles {
  find(root: string, pattern: string, options: { limit: number; offset: number; exclude: string[] }): Promise<ReadonlyArray<{ readonly path: string; readonly type: string }>>;
  stat(path: string): Promise<{ readonly size: number }>;
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
}

export interface SiteObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
}

export interface SiteBody extends SiteObject {
  readonly body: ReadableStream;
  text(): Promise<string>;
}

export interface SiteBucket {
  head(key: string): Promise<SiteObject | null>;
  get(key: string): Promise<SiteBody | null>;
  put(key: string, value: string | Uint8Array): Promise<SiteObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; delimiter?: string }): Promise<{ readonly objects: ReadonlyArray<SiteObject>; readonly delimitedPrefixes: ReadonlyArray<string> }>;
}

export class ChatOnly extends Schema.TaggedError<ChatOnly>()("ChatOnly", {}) implements Refusable {
  get refusal(): string {
    return "Not done: only a chat with the user may publish sites.";
  }
}

export class NoSite extends Schema.TaggedError<NoSite>()("NoSite", { id: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No site ${this.id}.`;
  }
}

export class TooManySites extends Schema.TaggedError<TooManySites>()("TooManySites", {}) implements Refusable {
  get refusal(): string {
    return `Not published: ky keeps at most ${MAX_SITES} sites. Delete one first.`;
  }
}

export class HtmlOrDir extends Schema.TaggedError<HtmlOrDir>()("HtmlOrDir", {}) implements Refusable {
  get refusal(): string {
    return "Not published: give either html or dir.";
  }
}

export class NotAFolder extends Schema.TaggedError<NotAFolder>()("NotAFolder", { dir: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Not published: name a folder in the workspace, such as /workspace/site, not ${this.dir}.`;
  }
}

export class NoFiles extends Schema.TaggedError<NoFiles>()("NoFiles", { dir: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Not published: ${this.dir} has no files.`;
  }
}

export class TooManyFiles extends Schema.TaggedError<TooManyFiles>()("TooManyFiles", { dir: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Not published: a site holds at most ${MAX_FILES} files, and ${this.dir} has more.`;
  }
}

export class TooBig extends Schema.TaggedError<TooBig>()("TooBig", { bytes: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `Not published: a site holds at most ${MAX_BYTES / 1024 / 1024} MB, and this is ${(this.bytes / 1024 / 1024).toFixed(1)} MB.`;
  }
}

export class NoLink extends Schema.TaggedError<NoLink>()("NoLink", { token: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No live link ${this.token} on this site.`;
  }
}

export class TooManyLinks extends Schema.TaggedError<TooManyLinks>()("TooManyLinks", {}) implements Refusable {
  get refusal(): string {
    return `Not shared: a site has at most ${MAX_LINKS} live links. Revoke one first.`;
  }
}

export class ViewOnly extends Schema.TaggedError<ViewOnly>()("ViewOnly", {}) implements Refusable {
  get refusal(): string {
    return "This link only views the site; it can't change its data.";
  }
}

export class BadDataName extends Schema.TaggedError<BadDataName>()("BadDataName", { what: Schema.Literals(["collection", "key"]), name: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.what === "collection"
      ? `A collection's name is 1 to 64 lowercase letters, digits, _ and -, starting with a letter or digit, not ${JSON.stringify(this.name)}.`
      : `An item's key is 1 to 128 letters, digits, _, . and -, starting with a letter or digit, not ${JSON.stringify(this.name)}.`;
  }
}

export class NotJson extends Schema.TaggedError<NotJson>()("NotJson", {}) implements Refusable {
  get refusal(): string {
    return "An item is a JSON value.";
  }
}

export class ItemTooBig extends Schema.TaggedError<ItemTooBig>()("ItemTooBig", { bytes: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `Not saved: an item holds at most ${MAX_ITEM_BYTES / 1024} KB of JSON, and this is ${(this.bytes / 1024).toFixed(1)} KB.`;
  }
}

export class TooManyItems extends Schema.TaggedError<TooManyItems>()("TooManyItems", { collection: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Not saved: a collection holds at most ${MAX_ITEMS} items, and ${this.collection} is full.`;
  }
}

export class TooManyCollections extends Schema.TaggedError<TooManyCollections>()("TooManyCollections", {}) implements Refusable {
  get refusal(): string {
    return `Not saved: a site holds at most ${MAX_COLLECTIONS} collections.`;
  }
}

export class Unreadable extends Schema.TaggedError<Unreadable>()("Unreadable", { dir: Schema.String, reason: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Couldn't read ${this.dir}: ${this.reason}`;
  }
}
