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

export const SiteMeta = Schema.Struct({ title: Schema.String, created: Schema.Number, token: Schema.optionalKey(Schema.String) });

export type SiteMeta = typeof SiteMeta.Type;

const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(SiteMeta));

export const metaOr = (text: string): SiteMeta | undefined => Option.getOrUndefined(decodeMeta(text));

export const SiteRow = Schema.Struct({ id: Schema.String, title: Schema.String, created: Schema.Number, public: Schema.Boolean });

export type SiteRow = typeof SiteRow.Type;

export const SiteArgs = Type.Object({
  action: Type.Union([Type.Literal("publish"), Type.Literal("list"), Type.Literal("make_public"), Type.Literal("make_private"), Type.Literal("delete")]),
  id: Type.Optional(Type.String({ description: "The site, for make_public, make_private and delete; for publish, the site whose files to replace." })),
  title: Type.Optional(Type.String({ description: "publish: the site's title." })),
  html: Type.Optional(Type.String({ description: "publish: one HTML page, served as the site's index.html." })),
  dir: Type.Optional(Type.String({ description: "publish: a workspace folder, such as /workspace/site, served with its index.html at the root." }))
});

export type SiteArgs = Static<typeof SiteArgs>;

export interface SiteFiles {
  find(root: string, pattern: string, options: { limit: number; offset: number; exclude: string[] }): Promise<ReadonlyArray<{ readonly path: string; readonly type: string }>>;
  stat(path: string): Promise<{ readonly size: number }>;
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
}

export class NotAChat extends Schema.TaggedError<NotAChat>()("NotAChat", {}) implements Refusable {
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

export class Unreadable extends Schema.TaggedError<Unreadable>()("Unreadable", { dir: Schema.String, reason: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Couldn't read ${this.dir}: ${this.reason}`;
  }
}
