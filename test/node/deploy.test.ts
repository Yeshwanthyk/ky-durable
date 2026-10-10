import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPES } from "../../cli/cloudflare.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const read = (file: string) => readFile(path.join(REPO, file), "utf8");

/** Every file under `dir`, as paths from the repo. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(REPO, dir), { withFileTypes: true, recursive: true });

  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(REPO, path.join(entry.parentPath, entry.name)));
}

/**
 * The deploy workflow (.github/workflows/deploy.yml) that ships a merged self-edit: its Cloudflare token is
 * a repo secret, never ky's. The workflow itself runs only on GitHub; actionlint checks its syntax.
 */
describe("the deploy workflow", () => {
  it("deploys main on a merge, and a commit of main on a dispatch, with the token from the repo's secrets", async () => {
    const workflow = await read(".github/workflows/deploy.yml");

    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(workflow).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+sha:/);
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(workflow).toContain("KY_OVERLAY: ${{ secrets.KY_OVERLAY }}");
    expect(workflow.match(/CLOUDFLARE_API_TOKEN:/g)).toHaveLength(1);
    // The image pulls with the run's own token, so a private ky-cloud package deploys.
    expect(workflow).toContain("KY_GHCR_TOKEN: ${{ github.token }}");
    expect(workflow).toMatch(/permissions:\n\s+contents: read\n\s+packages: read/);
    // A rollback goes back along main, never to a branch that wasn't merged.
    expect(workflow).toContain('git merge-base --is-ancestor "$commit" origin/main');
    expect(workflow).toContain("run: pnpm ky deploy");
    expect(workflow).toContain("persist-credentials: false");

    // The header names every permission `ky deploy` asks a token for.
    for (const scope of SCOPES.split(", ")) expect(workflow).toContain(scope);
  });

  it("is the only place ky's code names the Cloudflare token: the Worker and the agent's prompt never do", async () => {
    const worker = [...(await files("src")), "wrangler.jsonc"];

    for (const file of worker) expect(await read(file), file).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(await read("src/prompt.ts")).not.toMatch(/wrangler|pnpm run deploy/);
  });
});
