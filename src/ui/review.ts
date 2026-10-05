import type { FileDiffMetadata } from "@pierre/diffs";
import { DIFF_TYPE, type FileRow } from "../files";

/**
 * A machine task's code changes: the newest patch its `ky-diff` shared, how
 * big each file's change is, and the user's line comments on it, written up
 * as one message for the task.
 */

/** The task's newest patch; files arrive newest first. */
export function latestDiff(files: readonly FileRow[], task: string): FileRow | undefined {
  return files.find((file) => file.task === task && file.type === DIFF_TYPE);
}

export type Counts = { readonly additions: number; readonly deletions: number };

export function countsOf(files: readonly FileDiffMetadata[]): Counts {
  let additions = 0;
  let deletions = 0;

  for (const file of files) {
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }

  return { additions, deletions };
}

/** A comment on one line: `side` is "deletions" for a removed line, numbered in the old file. */
export type LineComment = {
  readonly file: string;
  readonly line: number;
  readonly side: "additions" | "deletions";
  /** The line's code, as the user saw it. */
  readonly code: string;
  readonly text: string;
};

const CODE_CHARS = 160;

/** Every comment as one message, in file and line order, each with its file:line and code. */
export function feedbackMessage(comments: readonly LineComment[]): string {
  const sorted = [...comments].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.side.localeCompare(b.side)
  );

  const notes = sorted.map((comment) => {
    const where = `${comment.file}:${comment.line}${comment.side === "deletions" ? " (removed line)" : ""}`;
    const code = comment.code.trim();
    const quoted = code.length > CODE_CHARS ? `${code.slice(0, CODE_CHARS - 1)}…` : code;

    return [where, ...(quoted ? [`> ${quoted}`] : []), comment.text.trim()].join("\n");
  });

  const count = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;

  return `Review of your changes (${count}). Address each, then run ky-diff again.\n\n${notes.join("\n\n")}`;
}
