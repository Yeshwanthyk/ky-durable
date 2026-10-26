import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export const PageRead = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  links: Schema.Array(Schema.Struct({ text: Schema.String, href: Schema.String }))
});

export type PageRead = typeof PageRead.Type;

export const PdfInfo = Schema.Struct({ Title: Schema.NonEmptyString });

export type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type Reply = { output?: Part[]; isError?: boolean };

export type Step = { do: "click" | "fill" | "press" | "wait"; selector?: string; value?: string };

export type Args = { url: string; steps?: Step[]; screenshot?: boolean };

export class TookTooLong extends Schema.TaggedError<TookTooLong>()("TookTooLong", { what: Schema.String, ms: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.what} took longer than ${this.ms / 1000}s`;
  }
}

export class Stopped extends Schema.TaggedError<Stopped>()("Stopped", { reason: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.reason;
  }
}

export class Failed extends Schema.TaggedError<Failed>()("Failed", { said: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.said;
  }
}

export class PdfAnswered extends Schema.TaggedError<PdfAnswered>()("PdfAnswered", { status: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `fetching the PDF answered HTTP ${this.status}`;
  }
}

export class NothingToRead extends Schema.TaggedError<NothingToRead>()("NothingToRead", { url: Schema.String, status: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.url} answered HTTP ${this.status} with nothing to read.`;
  }
}

export class NotAPdf extends Schema.TaggedError<NotAPdf>()("NotAPdf", { url: Schema.String, aborted: Schema.Boolean }) implements Refusable {
  get refusal(): string {
    return this.aborted
      ? `${this.url} aborted its navigation in the browser, so browse can't read it.`
      : `${this.url} downloads a file that is neither a page nor a PDF, so browse can't read it.`;
  }
}

export class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", { url: Schema.String, mb: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.url} is a PDF over ${this.mb} MB, too large to read.`;
  }
}
