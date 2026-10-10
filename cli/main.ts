/**
 * `ky`: sets up ky on the user's own Cloudflare account and keeps it running. Run from a checkout
 * with `pnpm ky …` (after `pnpm compile` gathers the release), or as the compiled binary, which
 * carries its release (cli/binary.ts).
 */
import { login } from "./cloudflare.ts";
import { overlayPath } from "./config.ts";
import { ky } from "./ky.ts";
import { loadRelease } from "./release.ts";
import { system } from "./runner/system.ts";

process.exitCode = await ky(process.argv.slice(2), {
  overlay: overlayPath(),
  release: loadRelease,
  login,
  print: (line) => console.log(line),
  fail: (line) => console.error(line),
  system: system(),
  env: process.env,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
});
