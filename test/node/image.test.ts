import { execFileSync } from "node:child_process";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
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
    expect(graph).toEqual(expect.arrayContaining(["cli/binary.ts", "cli/runner/cloud.ts", "cli/runner/forward.ts", "cli/runner/share.ts", "src/runner-protocol.ts"]));

    for (const never of ["cli/init.ts", "cli/backup.ts", "cli/deployer.ts", "cli/commands.ts", "cli/cloudflare.ts", "cli/image.ts", "src/access.ts"]) expect(graph).not.toContain(never);
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
    expect(await imageCurrent("b9fc9b7^", "b9fc9b7")).toMatchObject({ current: false, changed: ["src/runner-protocol.ts"] });
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

      for (const file of ["cli/backup.ts", "cli/deployer.ts", "src/access.ts"]) expect(await imageCurrent("base", await touching(file), clone, inputs)).toEqual({ current: true });
    });

    it("says stale for a change to the runner", async () => {
      const commit = await touching("cli/runner/forward.ts");

      expect(await imageCurrent("base", commit, clone, await imageInputs())).toMatchObject({ current: false, changed: ["cli/runner/forward.ts"] });
    });
  });
});
