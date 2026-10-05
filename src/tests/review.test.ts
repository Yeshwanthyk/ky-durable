import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { captureDiff, type Git } from "../../runner/diff.ts";
import type { FileRow } from "../files";
import { countsOf, feedbackMessage, latestDiff } from "../ui/review";

/**
 * A task's code changes: what ky-diff captures from git, and how the UI
 * counts them and writes the user's line comments up for the task.
 */

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
`;

const NEW_FILE = `diff --git a/notes.md b/notes.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes.md
@@ -0,0 +1 @@
+hello
`;

/** A git that answers from a script, keyed by its arguments, and records what it was asked. */
function scripted(answers: Record<string, { status: number; stdout: string }>) {
  const asked: string[] = [];

  const git: Git = (args) => {
    const key = args.join(" ");
    asked.push(key);

    return answers[key] ?? { status: 128, stdout: "" };
  };

  return { git, asked };
}

const ok = (stdout: string) => ({ status: 0, stdout });

describe("capturing a task's diff", () => {
  it("diffs from where the branch left the default branch, with new untracked files", () => {
    const { git, asked } = scripted({
      "rev-parse --verify --quiet HEAD": ok("head\n"),
      "symbolic-ref --quiet --short refs/remotes/origin/HEAD": ok("origin/trunk\n"),
      "merge-base HEAD origin/trunk": ok("fork\n"),
      "diff --no-color --no-ext-diff --find-renames fork": ok(PATCH),
      "ls-files --others --exclude-standard -z": ok("notes.md\0"),
      "diff --no-color --no-ext-diff --no-index -- /dev/null notes.md": { status: 1, stdout: NEW_FILE }
    });

    expect(captureDiff(git)).toBe(PATCH + NEW_FILE);
    expect(asked).toContain("merge-base HEAD origin/trunk");
  });

  it("falls back to HEAD with no default branch, and to the empty tree with no commits", () => {
    const noRemote = scripted({
      "rev-parse --verify --quiet HEAD": ok("head\n"),
      "diff --no-color --no-ext-diff --find-renames HEAD": ok(PATCH),
      "ls-files --others --exclude-standard -z": ok("")
    });

    expect(captureDiff(noRemote.git)).toBe(PATCH);

    const fresh = scripted({
      "rev-parse --verify --quiet HEAD": { status: 1, stdout: "" },
      "diff --no-color --no-ext-diff --find-renames 4b825dc642cb6eb9a060e54bf8d69288fbee4904": ok(""),
      "ls-files --others --exclude-standard -z": ok("")
    });

    expect(captureDiff(fresh.git)).toBe("");
  });

  it("takes a base the task names, and refuses one that is not a commit", () => {
    const { git } = scripted({
      "rev-parse --verify --quiet HEAD~2^{commit}": ok("base\n"),
      "diff --no-color --no-ext-diff --find-renames base": ok(PATCH),
      "ls-files --others --exclude-standard -z": ok("")
    });

    expect(captureDiff(git, "HEAD~2")).toBe(PATCH);
    expect(() => captureDiff(git, "nope")).toThrow("No commit nope");
  });
});

describe("reviewing a task's diff", () => {
  it("counts each file's added and removed lines", () => {
    const files = parsePatchFiles(PATCH + NEW_FILE).flatMap((patch) => patch.files);

    expect(files.map((file) => file.name)).toEqual(["src/a.ts", "notes.md"]);
    expect(countsOf(files)).toEqual({ additions: 3, deletions: 1 });
    expect(countsOf([files[0]!])).toEqual({ additions: 2, deletions: 1 });
  });

  it("shows the task's newest patch, not its screenshots", () => {
    const file = (id: string, type: string, task = "m-1"): FileRow => ({ id, task, type, name: id, size: 1, caption: null, created_at: 0 });
    const files = [file("shot", "image/png"), file("other", "text/x-diff", "m-2"), file("new", "text/x-diff"), file("old", "text/x-diff")];

    expect(latestDiff(files, "m-1")?.id).toBe("new");
    expect(latestDiff(files, "m-3")).toBeUndefined();
  });

  it("writes every comment up as one message, in file and line order, with file:line and the code", () => {
    const message = feedbackMessage([
      { file: "src/b.ts", line: 9, side: "additions", code: "  return x;", text: "Handle null here." },
      { file: "src/a.ts", line: 2, side: "deletions", code: "const b = 2;", text: "Why remove this?" },
      { file: "src/a.ts", line: 3, side: "additions", code: "x".repeat(200), text: " Too long. " }
    ]);

    expect(message).toBe(
      [
        "Review of your changes (3 comments). Address each, then run ky-diff again.",
        "",
        "src/a.ts:2 (removed line)",
        "> const b = 2;",
        "Why remove this?",
        "",
        "src/a.ts:3",
        `> ${"x".repeat(159)}…`,
        "Too long.",
        "",
        "src/b.ts:9",
        "> return x;",
        "Handle null here."
      ].join("\n")
    );
  });
});
