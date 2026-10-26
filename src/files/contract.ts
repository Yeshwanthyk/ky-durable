import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export * from "./media";

export const FILE_TABLES = Object.freeze({ files: "ky_files", typed: "ky_files_typed" } as const);

export const FileRow = Schema.Struct({
  id: Schema.String,
  task: Schema.String,
  name: Schema.String,
  type: Schema.String,
  size: Schema.Number,
  caption: Schema.NullOr(Schema.String),
  created_at: Schema.Number
});

export type FileRow = typeof FileRow.Type;

export type NewFile = Omit<FileRow, "created_at">;

export const DIFF_TYPE = "text/x-diff";

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export class WrongMethod extends Schema.TaggedError<WrongMethod>()("WrongMethod", {}) implements Refusable {
  get status(): number {
    return 405;
  }

  get refusal(): string {
    return "Use PUT";
  }
}

export class NoTask extends Schema.TaggedError<NoTask>()("NoTask", {}) implements Refusable {
  get status(): number {
    return 400;
  }

  get refusal(): string {
    return "Name the task: ?task=<id>";
  }
}

export class NotAFileType extends Schema.TaggedError<NotAFileType>()("NotAFileType", {}) implements Refusable {
  get status(): number {
    return 415;
  }

  get refusal(): string {
    return "Type must be png, jpeg, webp, gif, webm, mp4, an audio type of webm, mp4, mpeg, ogg or wav, or x-diff";
  }
}

export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", { max: Schema.Number }) implements Refusable {
  get status(): number {
    return 413;
  }

  get refusal(): string {
    return `File must be 1 byte to ${this.max / 1024 / 1024} MB`;
  }
}

export class BadLabel extends Schema.TaggedError<BadLabel>()("BadLabel", {}) implements Refusable {
  get status(): number {
    return 400;
  }

  get refusal(): string {
    return "Bad file name or caption";
  }
}

export class ShortBody extends Schema.TaggedError<ShortBody>()("ShortBody", {}) implements Refusable {
  get status(): number {
    return 400;
  }

  get refusal(): string {
    return "Body is not Content-Length bytes";
  }
}

export class NotRecorded extends Schema.TaggedError<NotRecorded>()("NotRecorded", { why: Schema.String }) implements Refusable {
  get status(): number {
    return 404;
  }

  get refusal(): string {
    return this.why;
  }
}

export class NotAClip extends Schema.TaggedError<NotAClip>()("NotAClip", {}) implements Refusable {
  get status(): number {
    return 415;
  }

  get refusal(): string {
    return "Send an audio or video clip: webm, mp4, mov, m4a, mp3, ogg, wav or flac";
  }
}

export class ClipTooLarge extends Schema.TaggedError<ClipTooLarge>()("ClipTooLarge", { max: Schema.Number }) implements Refusable {
  get status(): number {
    return 413;
  }

  get refusal(): string {
    return `A clip must be 1 byte to ${this.max / 1024 / 1024} MB`;
  }
}

export class NoClip extends Schema.TaggedError<NoClip>()("NoClip", {}) implements Refusable {
  get status(): number {
    return 400;
  }

  get refusal(): string {
    return "Send the clip as the body";
  }
}

export type UploadRefused = WrongMethod | NoTask | NotAFileType | FileTooLarge | BadLabel | ShortBody | NotRecorded;

export type MediaRefused = WrongMethod | NotAClip | ClipTooLarge | NoClip;
