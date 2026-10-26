import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageCurrent, imageInputs, mismatches, REPO, runtimeGraph } from "../../scripts/image/inputs.ts";

/** What image.yml's `paths` and release.yml's check named before the list narrowed to the runner. */
const BEFORE = ["container/Dockerfile", "cli/", "src/runner-protocol.ts", "src/files.ts", "src/tool-labels.ts", "src/access.ts", "pnpm-lock.yaml"];

describe("container/image.inputs", () => {
  it("names every file the cloud machine loads, and none it doesn't", async () => {
    const graph = await runtimeGraph();

    expect(mismatches(graph, await imageInputs())).toEqual({ unlisted: [], unused: [] });
    // The runner and what it imports; none of the commands the cloud machine never runs.
    expect(graph).toEqual(expect.arrayContaining(["cli/binary.ts", "cli/runner/cloud.ts", "cli/runner/forward.ts", "cli/runner/share.ts", "src/machines/runner-protocol.ts"]));

    for (const never of ["cli/init.ts", "cli/backup.ts", "cli/deploy/deployer.ts", "cli/commands.ts", "cli/cloudflare.ts", "cli/image.ts", "src/access/contract.ts"]) expect(graph).not.toContain(never);
  }, 30_000);

  it("is caught when the code and the list drift apart", () => {
    expect(mismatches(["cli/binary.ts", "cli/runner/run.ts", "cli/init.ts"], ["cli/binary.ts", "cli/runner/", "src/files.ts", "container/Dockerfile"])).toEqual({
      unlisted: ["cli/init.ts"],
      unused: ["src/files.ts"]
    });
  });
});

describe("whether the pinned image is current", () => {
  it("says current across a release that changed nothing the image runs", async () => {
    // 0.1.1's release commit, against the commit its image was built from.
    expect(await imageCurrent("aca5dce", "d91e46e")).toEqual({ current: true });
  });

  it("says stale when the runner, the protocol or the Dockerfile changed", async () => {
    expect(await imageCurrent("aca5dce^", "aca5dce")).toMatchObject({ current: false, changed: expect.arrayContaining(["cli/runner/forward.ts", "cli/runner/runner.ts"]) });
    // The protocol was src/runner-protocol.ts then, before it moved into src/machines/.
    expect(await imageCurrent("b9fc9b7^", "b9fc9b7", REPO, [...(await imageInputs()), "src/runner-protocol.ts"])).toMatchObject({ current: false, changed: ["src/runner-protocol.ts"] });
    expect(await imageCurrent("1093fe4^", "1093fe4")).toMatchObject({ current: false, changed: ["container/Dockerfile"] });
  });

  it("says stale for a source this repository doesn't have", async () => {
    expect(await imageCurrent("0".repeat(40), "HEAD")).toMatchObject({ current: false, why: expect.stringContaining("isn't in this repository's history") });
  });

  describe("on commits that change one file", () => {
    let clone: string;
    const git = (...args: string[]) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

    /** A commit on the clone that adds a line to `file`. */
    async function touching(file: string): Promise<string> {
      git("checkout", "-q", "--detach", "base");
      await appendFile(path.join(clone, file), "\n// touched\n");
      git("commit", "-qam", `touch ${file}`);

      return git("rev-parse", "HEAD");
    }

    beforeAll(async () => {
      clone = await mkdtemp(path.join(tmpdir(), "ky-image-"));
      execFileSync("git", ["clone", "-q", "--shared", REPO, clone]);
      git("tag", "base", "HEAD");
    });

    afterAll(() => rm(clone, { recursive: true, force: true }));

    it("says current for a change to ky init, which used to make a new image", async () => {
      const inputs = await imageInputs();
      const commit = await touching("cli/init.ts");

      expect(await imageCurrent("base", commit, clone, inputs)).toEqual({ current: true });
      expect(await imageCurrent("base", commit, clone, BEFORE)).toMatchObject({ current: false, changed: ["cli/init.ts"] });

      for (const file of ["cli/backup.ts", "cli/deploy/deployer.ts", "src/access.ts"]) expect(await imageCurrent("base", await touching(file), clone, inputs)).toEqual({ current: true });
    });

    it("says stale for a change to the runner", async () => {
      const commit = await touching("cli/runner/forward.ts");

      expect(await imageCurrent("base", commit, clone, await imageInputs())).toMatchObject({ current: false, changed: ["cli/runner/forward.ts"] });
    });
  });
});

describe("scripts/image/last.sh", () => {
  const NEWER = `ghcr.io/owner/ky-cloud@sha256:${"b".repeat(64)}`;
  let bin: string;

  /** last.sh's lines, with a `gh` that lists `releases` (newest first, as GitHub does) and a `curl` that fails. */
  async function last(releases: { tag: string; draft?: boolean; image?: string }[], ...args: string[]): Promise<Record<string, string>> {
    const listed = releases.map(({ tag, draft }) => JSON.stringify({ tag_name: tag, draft: draft ?? false })).join(",");
    const images = releases.map(({ tag, image }) => `    ${tag}) ${image ? `echo '{"image":"${image}"}'` : "exit 1"} ;;`).join("\n");

    await writeFile(
      path.join(bin, "gh"),
      `#!/bin/sh
if [ "$1" = api ]; then echo '[${listed}]' | jq -r '.[] | select(.draft | not) | .tag_name'; exit 0; fi
if [ "$1 $2" = "release download" ]; then
  case "$3" in
${images}
    *) exit 1 ;;
  esac
fi
exit 1
`,
      { mode: 0o755 }
    );
    await writeFile(path.join(bin, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
    const out = execFileSync(path.join(REPO, "scripts/image/last.sh"), args, { encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });

    return Object.fromEntries(out.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  }

  beforeAll(async () => {
    bin = await mkdtemp(path.join(tmpdir(), "ky-last-"));
  });

  afterAll(() => rm(bin, { recursive: true, force: true }));

  it("with no tag, as deploy.yml runs it, is the newest published release's image, which may be newer than the pin", async () => {
    const pin = (await readFile(path.join(REPO, "container/image.digest"), "utf8")).split("\n").find((line) => line.startsWith("ghcr.io/"));

    expect(await last([{ tag: "v9.0.1", draft: true, image: `ghcr.io/owner/ky-cloud@sha256:${"c".repeat(64)}` }, { tag: "v9.0.0" }, { tag: "v8.0.0", image: NEWER }])).toEqual({
      ref: NEWER,
      source: "",
      from: "v8.0.0, the newest release that names one"
    });
    expect(NEWER).not.toBe(pin);
  });

  it("falls back to container/image.digest when no release names an image", async () => {
    expect(await last([{ tag: "v1.0.0" }])).toMatchObject({ from: "container/image.digest", ref: expect.stringMatching(/^ghcr\.io\/.+@sha256:[0-9a-f]{64}$/) });
  });

  it("still takes a tag's own release first, as release.yml runs it", async () => {
    expect(await last([{ tag: "v2.0.0", image: NEWER }, { tag: "v1.0.0", image: `ghcr.io/owner/ky-cloud@sha256:${"a".repeat(64)}` }], "v1.0.0")).toMatchObject({
      ref: `ghcr.io/owner/ky-cloud@sha256:${"a".repeat(64)}`,
      from: "v1.0.0 (this tag's release: a rerun)"
    });
  });
});
