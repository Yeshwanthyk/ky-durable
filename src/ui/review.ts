import type { FileDiffMetadata } from "@pierre/diffs";
import { DIFF_TYPE, type FileRow } from "../files";

/**
 * A machine task's code changes: the newest patch its `ky diff` shared, how
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

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

type Tally = { gitFiles: number; plainFiles: number; additions: number; deletions: number; oldLeft: number; newLeft: number };

/** One line inside a hunk: an added, removed or context line, or a "\\ No newline" note. */
function hunkLine(tally: Tally, line: string) {
  if (line.startsWith("+")) {
    tally.additions++;
    tally.newLeft--;
  } else if (line.startsWith("-")) {
    tally.deletions++;
    tally.oldLeft--;
  } else if (!line.startsWith("\\")) {
    tally.oldLeft--;
    tally.newLeft--;
  }
}

/** One line between hunks: a hunk's header, or a file's. */
function headerLine(tally: Tally, line: string) {
  const hunk = HUNK.exec(line);

  if (hunk) {
    tally.oldLeft = Number(hunk[1] ?? 1);
    tally.newLeft = Number(hunk[2] ?? 1);
  } else if (line.startsWith("diff --git ")) {
    tally.gitFiles++;
  } else if (line.startsWith("+++ ")) {
    tally.plainFiles++;
  }
}

/**
 * How many files a unified patch touches and its added and removed lines,
 * read from the text so the collapsed row needs no diff library. Each hunk's
 * header says how many old and new lines follow, so a line that only looks
 * like a header (`+++`, `---`, `diff --git`) inside a hunk is counted as code.
 */
export function patchSummary(patch: string): Counts & { readonly files: number } {
  const tally: Tally = { gitFiles: 0, plainFiles: 0, additions: 0, deletions: 0, oldLeft: 0, newLeft: 0 };

  for (const line of patch.split("\n")) {
    const inHunk = tally.oldLeft > 0 || tally.newLeft > 0;

    if (inHunk) hunkLine(tally, line);
    else headerLine(tally, line);
  }

  return { files: tally.gitFiles || tally.plainFiles, additions: tally.additions, deletions: tally.deletions };
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

  return `Review of your changes (${count}). Address each, then run ky diff again.\n\n${notes.join("\n\n")}`;
}

/** A line the user picked and is still writing a comment for. */
export type Draft = Omit<LineComment, "text">;

/** What a diff line carries: a saved comment, with its place in the list, or the draft. */
export type Note = { comment: LineComment; index: number } | { draft: Draft };

/** The notes on one file's lines: its comments, then the draft if it is on this file. */
export function notesOn(file: string, comments: readonly LineComment[], draft: Draft | null): Note[] {
  const notes: Note[] = comments.flatMap((comment, index) => (comment.file === file ? [{ comment, index }] : []));

  if (draft?.file === file) notes.push({ draft });

  return notes;
}

/** A file's name, with where it moved from if it was renamed. */
export function fileLabel(file: Pick<FileDiffMetadata, "name" | "prevName">): string {
  return file.prevName && file.prevName !== file.name ? `${file.prevName} → ${file.name}` : file.name;
}
