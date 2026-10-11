/**
 * `ky`: sets up ky on the user's own Cloudflare account and keeps it running. Run from a checkout
 * with `pnpm ky …` (after `pnpm compile` gathers the release), or as the compiled binary, which
 * carries its release (cli/binary.ts).
 */
import { overlayPath } from "./config.ts";
import { ky } from "./ky.ts";
import { loadRelease } from "./release.ts";
import { system } from "./runner/system.ts";

process.exitCode = await ky(process.argv.slice(2), {
  overlay: overlayPath(),
  release: loadRelease,
  // Imported when a command signs in: the cloud machine never does (cli/ky.ts).
  login: async () => (await import("./cloudflare.ts")).login(),
  print: (line) => console.log(line),
  fail: (line) => console.error(line),
  system: system(),
  env: process.env,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
});
