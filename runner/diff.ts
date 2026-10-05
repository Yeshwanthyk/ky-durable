/**
 * What `ky-diff` captures: a repository's changes as one git patch, from
 * where its branch left the default branch to the working copy, untracked
 * files included. Kept apart from the process so the tests can give it a
 * scripted git.
 */

/** Run git in the repository: its exit status and stdout. */
export type Git = (args: readonly string[]) => { status: number; stdout: string };

/** Git's empty tree: the base of a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Where the branch's work starts: the given base, else its fork from the default branch, else HEAD. */
function diffBase(git: Git, base?: string): string {
  if (base !== undefined) {
    const named = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);

    if (named.status !== 0) throw new Error(`No commit ${base}`);

    return named.stdout.trim();
  }

  if (git(["rev-parse", "--verify", "--quiet", "HEAD"]).status !== 0) return EMPTY_TREE;
  const remote = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).stdout.trim();

  for (const branch of [remote, "origin/main", "origin/master", "main", "master"]) {
    if (branch === "") continue;
    const fork = git(["merge-base", "HEAD", branch]);

    if (fork.status === 0) return fork.stdout.trim();
  }

  return "HEAD";
}

/** The patch from `base` to the working copy, new untracked files appended; empty when nothing changed. */
export function captureDiff(git: Git, base?: string): string {
  const from = diffBase(git, base);
  const flags = ["--no-color", "--no-ext-diff"];
  const tracked = git(["diff", ...flags, "--find-renames", from]);

  if (tracked.status !== 0) throw new Error("git diff failed");
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);

  // `--no-index` exits 1 when the files differ, which a new file always does.
  const added = untracked.map((file) => git(["diff", ...flags, "--no-index", "--", "/dev/null", file]).stdout);

  return [tracked.stdout, ...added].filter((part) => part !== "").join("");
}
