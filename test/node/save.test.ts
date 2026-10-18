import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pack, unpack } from "../../cli/runner/save.ts";

/**
 * A save's way through the runner (cli/runner/save.ts): `pack` streams the home's kept folders as a
 * tar.gz, and `unpack` gives them back. P4: a save that reaches a restore cut off or corrupted is
 * refused, and the home is left as it was; only a whole save changes it, to exactly what was saved.
 */

const FOLDERS = [".claude/projects", ".ky", "ky-work"];

/** What the home holds before a restore: what the image brings, and what a save leaves out. */
const BEFORE = { ".ky/bin/ky": "the image's ky", "ky-work/app/node_modules/dep/index.js": "", ".bashrc": "the image's" } satisfies Record<string, string>;

/** Every file under `root` and its content's hash, by its path relative to `root`; a symlink or directory isn't one. */
async function files(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const at = path.join(folder, entry.name);

      if (entry.isDirectory()) await walk(at);
      else found[path.relative(root, at)] = createHash("sha256").update(await readFile(at)).digest("hex");
    }
  };

  await walk(root);

  return found;
}

/** `size` bytes from `seed`, which compress no more than a work tree's binaries do. */
function bytes(seed: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed | 1;

  for (let at = 0; at < size; at++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[at] = x & 0xff;
  }

  return out;
}

async function write(root: string, contents: Record<string, Buffer | string>): Promise<void> {
  for (const [name, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

const collect = async (stream: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) chunks.push(chunk);

  return Buffer.concat(chunks);
};

/** A body as it reaches the runner: in pieces of up to 64 KiB. */
const arriving = (archive: Buffer) => Readable.from((function* () {
  for (let at = 0; at < archive.length; at += 65_536) yield archive.subarray(at, at + 65_536);
})());

const scratch: string[] = [];

const folder = async (name: string) => {
  const made = await mkdtemp(path.join(tmpdir(), `ky-save-${name}-`));

  scratch.push(made);

  return made;
};

afterAll(async () => {
  for (const made of scratch) await rm(made, { recursive: true, force: true });
});

/** A file's path in a kept folder: a few nested names of safe characters. */
const aName = fc
  .tuple(fc.constantFrom(...FOLDERS), fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,11}$/), { minLength: 1, maxLength: 3 }))
  .map(([kept, parts]) => path.join(kept, ...parts));

/** Mostly small files, a few up to 1.5 MiB, which take many gzip blocks. */
const aSize = fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 0, max: 4_096 }) }, { weight: 1, arbitrary: fc.integer({ min: 100_000, max: 1_500_000 }) });

/** Files whose names don't collide as file and folder. */
const aTree = fc
  .uniqueArray(fc.record({ name: aName, size: aSize, seed: fc.integer() }), { minLength: 1, maxLength: 12, selector: (file) => file.name })
  .filter((tree) => tree.every((file) => tree.every((other) => !other.name.startsWith(`${file.name}/`))));

/**
 * Where a save is cut off, if it is: anywhere, or in its last bytes, after tar's own data, where only
 * gzip's length and CRC show the save isn't whole.
 */
const aCut = fc.oneof(
  fc.constant(null),
  fc.record({ fraction: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }) }),
  fc.record({ short: fc.integer({ min: 1, max: 64 }) })
);

describe("a save's way through the runner", () => {
  let home: string;

  beforeAll(async () => {
    home = await folder("home");
    await write(home, { "ky-work/app/README.md": "# app\n", "ky-work/app/node_modules/dep/index.js": "", ".ky/bin/ky": "", ".ky/codex/m-1/auth.json": "{}" });
  });

  it("packs the kept folders as a stream, leaving out what's excluded", async () => {
    const archive = await collect(pack(home, FOLDERS.filter((kept) => kept !== ".claude/projects"), ["node_modules", ".ky/bin", ".ky/codex/*/auth.json"]));
    const into = await folder("into");

    await unpack(arriving(archive), into);

    expect(Object.keys(await files(into))).toEqual(["ky-work/app/README.md"]);
  });

  it("fails its stream when tar fails, rather than end it as a whole save", async () => {
    // A tar that writes part of an archive, then fails as a disk error would.
    const bin = await folder("bin");
    await writeFile(path.join(bin, "tar"), "#!/bin/sh\nprintf 'partial'\nexit 2\n");
    await chmod(path.join(bin, "tar"), 0o755);
    const was = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${was}`;

    try {
      await expect(collect(pack(home, FOLDERS, []))).rejects.toThrow(/tar .* exited 2/);
    } finally {
      process.env.PATH = was;
    }
  });

  it("restores nothing from an empty body: there was no save yet", async () => {
    const into = await folder("empty");

    await write(into, BEFORE);
    expect(await unpack(arriving(Buffer.alloc(0)), into)).toBe(0);
    expect(Object.keys(await files(into)).sort()).toEqual(Object.keys(BEFORE).sort());
  });

  it("P4: gives back a whole save exactly, and refuses a cut or corrupted one, leaving the home as it was", { timeout: 600_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        aTree,
        aCut,
        fc.option(fc.record({ at: fc.double({ min: 0, max: 1, noNaN: true }), xor: fc.integer({ min: 1, max: 255 }) })),
        async (tree, cut, flip) => {
          const source = await folder("source");
          const into = await folder("into");

          try {
            await write(source, Object.fromEntries(tree.map((file) => [file.name, bytes(file.seed, file.size)])));
            const whole = await collect(pack(source, FOLDERS.filter((kept) => tree.some((file) => file.name.startsWith(`${kept}/`))), []));
            const length = cut === null ? whole.length : "fraction" in cut ? Math.floor(cut.fraction * whole.length) : Math.max(0, whole.length - cut.short);
            const archive = Buffer.from(whole.subarray(0, length));

            if (flip && archive.length > 0) archive[Math.min(archive.length - 1, Math.floor(flip.at * archive.length))]! ^= flip.xor;
            await write(into, BEFORE);
            const before = await files(into);

            const restored = await unpack(arriving(archive), into).then(
              () => true,
              () => false
            );

            const after = await files(into);

            if (restored && length > 0) {
              // Only a whole save restores; a flip the gzip checks can't see (its header's time or OS) changes nothing that's kept.
              expect(length, "a cut save restored").toBe(whole.length);
              expect(after).toEqual({ ...before, ...(await files(source)) });
            } else {
              // Refused, or an empty body, which is no save: the home is as it was, with no scratch left in it.
              expect(after).toEqual(before);
              expect((await readdir(into)).filter((name) => name.startsWith(".ky-restore-"))).toEqual([]);
            }
          } finally {
            await rm(source, { recursive: true, force: true });
            await rm(into, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100, verbose: 1 }
    );
  });

  it("merges a save into the home's folders, keeping what the save leaves out", async () => {
    const source = await folder("merge-source");
    const into = await folder("merge-into");

    await write(source, { ".ky/codex/m-1/config.toml": "saved", "ky-work/app/README.md": "saved" });
    await write(into, { ...BEFORE, "ky-work/app/README.md": "older" });
    await unpack(arriving(await collect(pack(source, [".ky", "ky-work"], []))), into);

    expect(await readFile(path.join(into, "ky-work/app/README.md"), "utf8")).toBe("saved");
    expect(await readFile(path.join(into, ".ky/bin/ky"), "utf8")).toBe("the image's ky");
    expect((await lstat(path.join(into, ".ky/codex/m-1/config.toml"))).isFile()).toBe(true);
  });
});
