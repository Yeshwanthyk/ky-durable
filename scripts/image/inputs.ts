/**
 * What the cloud machine's image runs (container/image.inputs), and whether an image built from
 * one commit is still current for another: whether any of those files changed between them.
 * .github/workflows/release.yml asks scripts/image/current.ts, and builds a new image only when
 * the last one is stale. A new image is a new digest, and a new digest makes `ky upgrade` roll the
 * cloud machine out (cli/deploy/deployer.ts), so an image is rebuilt only when what it runs changed.
 *
 * The list is checked against the code itself: Bun's own module graph of cli/binary.ts, the
 * compiled `ky`'s entry, following what the cloud machine's commands load (cli/ky.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "../..");

const LIST = "container/image.inputs";

/** The compiled `ky`'s entry. */
const ENTRY = "cli/binary.ts";

/**
 * Modules whose dynamic imports are commands, and of those, the ones the cloud machine runs: `ky
 * runner cloud`, `ky attach` and `ky diff`. Every other dynamic import is followed.
 */
const DISPATCH = new Map([
  ["cli/ky.ts", ["cli/runner/commands.ts"]],
  ["cli/main.ts", []]
]);

/** The paths container/image.inputs names; a folder ends in /. */
export async function imageInputs(repo = REPO): Promise<string[]> {
  return (await readFile(path.join(repo, LIST), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

type Meta = { inputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }> };

/** Every file of the repo the cloud machine loads, from Bun's module graph of the entry. */
export async function runtimeGraph(repo = REPO): Promise<string[]> {
  const out = await mkdtemp(path.join(tmpdir(), "ky-image-graph-"));

  try {
    // Packages are the lockfile's, and the embedded release is a file, not code.
    execFileSync("bun", ["build", ENTRY, "--target=bun", "--packages=external", "--external", "*.pack", `--outdir=${path.join(out, "build")}`, `--metafile=${path.join(out, "meta.json")}`], {
      cwd: repo,
      stdio: ["ignore", "ignore", "inherit"]
    });
    const meta: Meta = JSON.parse(await readFile(path.join(out, "meta.json"), "utf8"));
    // Bun names an import by its absolute path, or relative to the importer.
    const resolve = (from: string, to: string) => path.relative(repo, path.isAbsolute(to) ? to : path.resolve(repo, path.dirname(from), to));
    const seen = new Set<string>();

    const walk = (file: string) => {
      if (seen.has(file)) return;
      const module = meta.inputs[file];

      if (!module) throw new Error(`Bun's graph of ${ENTRY} has no ${file}`);
      seen.add(file);

      for (const { path: to, kind, external } of module.imports) {
        if (external) continue;
        const target = resolve(file, to);

        const commands = DISPATCH.get(file);

        if (kind === "dynamic-import" && commands && !commands.includes(target)) continue;
        walk(target);
      }
    };

    walk(ENTRY);

    return [...seen].sort();
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** What the list names that builds the image and its binary, which nothing imports. */
const BUILDS = new Set(["cli/compile.ts", ".github/actions/cloud-image/"]);

const covers = (input: string, file: string) => (input.endsWith("/") ? file.startsWith(input) : file === input);

/** What the list gets wrong: code the cloud machine loads that it doesn't name, and code it names that nothing loads. */
export type Mismatches = { unlisted: string[]; unused: string[] };

/** Where container/image.inputs and the cloud machine's module graph disagree. */
export function mismatches(graph: string[], inputs: string[]): Mismatches {
  const code = (input: string) => input.endsWith("/") || /\.[cm]?[jt]sx?$/.test(input);

  return {
    unlisted: graph.filter((file) => !inputs.some((input) => covers(input, file))),
    unused: inputs.filter((input) => code(input) && !BUILDS.has(input) && !graph.some((file) => covers(input, file)))
  };
}

/** Whether `commit` is in the repo's history. */
function known(repo: string, commit: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo, stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

export type Verdict = { current: true } | { current: false; why: string; changed: string[] };

/**
 * Whether an image built from `source` runs what `head` would: none of `inputs` changed between
 * them in `repo`'s history.
 */
export async function imageCurrent(source: string, head = "HEAD", repo = REPO, inputs?: string[]): Promise<Verdict> {
  if (!known(repo, source)) return { current: false, why: `${source} isn't in this repository's history`, changed: [] };
  inputs ??= await imageInputs(repo);
  const changed = execFileSync("git", ["diff", "--name-only", source, head, "--", ...inputs], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);

  return changed.length === 0 ? { current: true } : { current: false, why: `what the image runs changed since ${source}`, changed };
}
