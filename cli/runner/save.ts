/**
 * How a cloud runner's save travels (cli/runner/cloud.ts): `pack` streams the home's kept folders as
 * a tar.gz straight from tar, with no copy staged on disk, and `unpack` gives a save back to the
 * home only once all of it has arrived whole. Both run with GNU tar and macOS's bsdtar.
 */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** Why tar ended: its exit code, and its error output for a message. */
function ended(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: stderr.trim() }));
  });
}

/**
 * A tar.gz of `folders`, relative to `home`, without `excluded`: tar writes the tar, Node gzips it, so
 * the save is the same bytes under GNU tar and bsdtar (whose own `-z` pads its gzip with zeros to a
 * 10 KiB block). The stream fails if tar or gzip does, so whoever reads it never takes a cut archive
 * for a whole one. Exit 1 is accepted: to GNU tar, the container's, it means a file changed as tar
 * read it, as a task still running writes, and the archive is whole. (bsdtar also exits 1 for a file
 * it couldn't read, so on macOS a lost file passes: the tests can't see that case there.)
 */
export function pack(home: string, folders: readonly string[], excluded: readonly string[]): Readable {
  const args = ["-c", ...excluded.map((each) => `--exclude=${each}`), "-C", home, ...folders];
  const out = new PassThrough();
  const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  const gzip = createGzip();

  child.stdout.pipe(gzip).pipe(out, { end: false });
  // All of gzip's output has reached `out` by its end, which comes after tar's stdout ends.
  Promise.all([ended(child), finished(gzip)]).then(
    ([{ code, stderr }]) => (code === 0 || code === 1 ? out.end() : out.destroy(new Error(`tar ${args.join(" ")} exited ${code}: ${stderr}`))),
    (error: Error) => out.destroy(error)
  );
  // A reader gone: tar has no one to write to.
  out.on("close", () => {
    if (child.exitCode === null) child.kill();
    gzip.destroy();
  });

  return out;
}

/** Move everything under `from` into `to`, over what's there; a folder in both is merged. */
async function moveInto(from: string, to: string): Promise<void> {
  for (const name of await readdir(from)) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    const [have, want] = await Promise.all([lstat(target).catch(() => undefined), lstat(source)]);

    if (have?.isDirectory() && want.isDirectory()) {
      await moveInto(source, target);
      continue;
    }

    if (have) await rm(target, { recursive: true, force: true });
    await rename(source, target);
  }
}

/**
 * Give the home the save `archive`, a tar.gz; how many bytes it was, 0 for an empty body, which is
 * no save. It unpacks into a scratch folder in the home, on the same disk, and moves into place only
 * once gzip saw its whole stream (its length and CRC check out) and tar took all of it: a save cut
 * off or corrupted on its way here throws, and leaves the home as it was.
 */
export async function unpack(archive: AsyncIterable<Uint8Array>, home: string): Promise<number> {
  const chunks = archive[Symbol.asyncIterator]();
  const first = await chunks.next();

  if (first.done) return 0;
  let size = 0;
  const scratch = await mkdtemp(path.join(home, ".ky-restore-"));

  try {
    const child = spawn("tar", ["-xf", "-", "-C", scratch], { stdio: ["pipe", "ignore", "pipe"] });
    const exited = ended(child);

    const body = async function* () {
      for (let next: IteratorResult<Uint8Array> = first; !next.done; next = await chunks.next()) {
        size += next.value.byteLength;
        yield next.value;
      }
    };

    // Wait for tar either way, so no tar still writes into the scratch folder as it is removed.
    const [piped, { code, stderr }] = await Promise.all([pipeline(body, createGunzip(), child.stdin).then(() => undefined, (error: Error) => error), exited]);

    if (piped) throw new Error(`The save didn't arrive whole: ${piped.message} (tar exited ${code}: ${stderr})`);

    if (code !== 0) throw new Error(`tar couldn't unpack the save: exited ${code}: ${stderr}`);
    await moveInto(scratch, home);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return size;
}
