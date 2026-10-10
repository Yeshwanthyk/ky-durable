import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IDENTITY } from "../../cli/ky.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

/** What the computer's PATH needs for install.sh: sh, tar, curl, a sha-256 tool, and nothing named ky. */
const SYSTEM = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Stands in for the owner's other `ky`, "Ky 0.1 — local agent harness". */
const OTHER = '#!/bin/sh\necho "Ky 0.1 — local agent harness"\n';

let dir: string;

/** A release as scripts/release/package.sh lays it out, of a `ky` that only says its version. */
let release: string;

async function sh(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, 0o755);
}

const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ky-install-"));
  release = path.join(dir, "release");
  await sh(path.join(dir, "build/ky"), `#!/bin/sh\necho "ky 0.1.0 (${IDENTITY})"\n`);
  await mkdir(release);
  const sums: string[] = [];

  for (const platform of PLATFORMS) {
    const archive = path.join(release, `ky-${platform}.tar.gz`);

    execFileSync("tar", ["-czf", archive, "-C", path.join(dir, "build"), "ky"]);
    sums.push(`${await sha256(archive)}  ky-${platform}.tar.gz`);
  }

  await writeFile(path.join(release, "checksums.txt"), `${sums.join("\n")}\n`);
});

/** install.sh as `curl … | sh` runs it, in a home of its own, with `env` added. */
function install(env: Record<string, string> = {}, PATH = SYSTEM) {
  const run = spawnSync("sh", [path.join(REPO, "install.sh")], {
    env: { HOME: path.join(dir, "home"), PATH, KY_INSTALL_BASE: release, ...env },
    encoding: "utf8"
  });

  return { code: run.status, out: run.stdout, err: run.stderr };
}

const bin = () => path.join(dir, "home/.local/bin");

const version = (file: string) => execFileSync(file, ["--version"], { encoding: "utf8" }).trim();

describe("install.sh", () => {
  it("installs the release's ky in ~/.local/bin, checked against checksums.txt, and installs it again over itself", async () => {
    const first = install();

    expect(first).toMatchObject({ code: 0, err: "" });
    expect(first.out).toContain(`Installed ky 0.1.0 (${IDENTITY}) to ${bin()}/ky`);
    expect(first.out).toContain(`${bin()} isn't on your PATH`);
    expect(version(path.join(bin(), "ky"))).toBe(`ky 0.1.0 (${IDENTITY})`);

    const again = install({}, `${bin()}:${SYSTEM}`);

    expect(again.code).toBe(0);
    expect(again.out).toContain("Next: ky init");
  });

  it("refuses a release whose tarball doesn't match its checksums.txt, and installs nothing", async () => {
    await writeFile(path.join(release, "checksums.txt"), PLATFORMS.map((platform) => `${"0".repeat(64)}  ky-${platform}.tar.gz`).join("\n"));
    const run = install();

    expect(run.code).toBe(1);
    expect(run.err).toMatch(/ky install: ky-[a-z0-9-]+\.tar\.gz doesn't match the release's checksums\.txt/);
    expect(existsSync(path.join(bin(), "ky"))).toBe(false);
  });

  it("never replaces another program named ky: it says what it found and how to go on, and KY_INSTALL_FORCE=1 keeps it as ky.replaced", async () => {
    // As on the owner's Mac: ~/.local/bin/ky, a link to another program.
    await sh(path.join(dir, "other/ky"), OTHER);
    await mkdir(bin(), { recursive: true });
    await symlink(path.join(dir, "other/ky"), path.join(bin(), "ky"));
    const refused = install({}, `${bin()}:${SYSTEM}`);

    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(refused.err).toContain("there's already a ky that isn't this one, where this one would go:");
    expect(refused.err).toContain(`${bin()}/ky -> ${dir}/other/ky`);
    expect(refused.err).toContain("KY_INSTALL_DIR=");
    expect(refused.err).toContain("KY_INSTALL_FORCE=1");
    expect(version(path.join(bin(), "ky"))).toBe("Ky 0.1 — local agent harness");

    const forced = install({ KY_INSTALL_FORCE: "1" }, `${bin()}:${SYSTEM}`);

    expect(forced.code).toBe(0);
    expect(forced.out).toContain(`Moved the other ky to ${bin()}/ky.replaced`);
    expect(version(path.join(bin(), "ky"))).toBe(`ky 0.1.0 (${IDENTITY})`);
    expect(lstatSync(path.join(bin(), "ky.replaced")).isSymbolicLink()).toBe(true);
    expect(version(path.join(bin(), "ky.replaced"))).toBe("Ky 0.1 — local agent harness");
  });

  it("installs to KY_INSTALL_DIR beside another ky, and says that one comes first on the PATH", async () => {
    await sh(path.join(dir, "other/ky"), OTHER);
    const elsewhere = path.join(dir, "home/ky-cli/bin");
    const run = install({ KY_INSTALL_DIR: `${elsewhere}/` }, `${dir}/other:${elsewhere}:${SYSTEM}`);

    expect(run.code).toBe(0);
    expect(run.out).toContain(`Installed ky 0.1.0 (${IDENTITY}) to ${elsewhere}/ky`);
    expect(run.out).toContain(`Another program named ky comes first on your PATH:\n  ${dir}/other/ky`);
    expect(run.out).toContain(`${elsewhere}/ky init`);
    expect(version(path.join(dir, "other/ky"))).toBe("Ky 0.1 — local agent harness");
  });
});

describe("the brew formula", () => {
  it("points each platform at its tarball on the release, with the checksum the release lists", async () => {
    const formula = execFileSync(path.join(REPO, "scripts/release/formula.sh"), ["0.1.0", path.join(release, "checksums.txt")], { encoding: "utf8" });
    const sums = new Map<string, string>();

    for (const line of (await readFile(path.join(release, "checksums.txt"), "utf8")).trim().split("\n")) {
      const [sum = "", name = ""] = line.split("  ");

      sums.set(name, sum);
    }

    expect(formula).toContain('version "0.1.0"');

    for (const platform of PLATFORMS) {
      expect(formula).toContain(`url "https://github.com/Yeshwanthyk/ky-durable/releases/download/v0.1.0/ky-${platform}.tar.gz"\n      sha256 "${sums.get(`ky-${platform}.tar.gz`)}"`);
    }

    expect(formula).toContain(`assert_match "ky #{version} (${IDENTITY})"`);
  });

  it("is refused for a release missing a platform", async () => {
    await writeFile(path.join(release, "checksums.txt"), "abc  ky-darwin-arm64.tar.gz\n");
    const run = spawnSync(path.join(REPO, "scripts/release/formula.sh"), ["0.1.0", path.join(release, "checksums.txt")], { encoding: "utf8" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("has no ky-darwin-x64.tar.gz");
  });
});
