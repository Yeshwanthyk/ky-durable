/**
 * Whether the cloud machine's image built from a commit is current for another (scripts/image/inputs.ts):
 *
 *   scripts/image/current.ts <source> [<head>]   prints current or stale, and why; exits 0 either way
 *   scripts/image/current.ts check               fails when container/image.inputs and the code disagree
 *
 * Run with `node --experimental-strip-types`; it needs `bun` and `git`. Both forms check the list
 * first, so a release never decides on a wrong one. In GitHub Actions it also writes `current=true`
 * or `current=false` to the step's outputs.
 */
import { appendFileSync } from "node:fs";
import { imageCurrent, imageInputs, mismatches, runtimeGraph } from "./inputs.ts";

const [source, head = "HEAD"] = process.argv.slice(2);

if (!source) {
  console.error("usage: scripts/image/current.ts <source> [<head>] | check");
  process.exit(2);
}

const { unlisted, unused } = mismatches(await runtimeGraph(), await imageInputs());

if (unlisted.length > 0 || unused.length > 0) {
  for (const file of unlisted) console.error(`container/image.inputs doesn't name ${file}, which the cloud machine loads`);

  for (const input of unused) console.error(`container/image.inputs names ${input}, which the cloud machine doesn't load`);

  process.exit(1);
}

if (source === "check") {
  console.log("container/image.inputs names what the cloud machine loads");
  process.exit(0);
}

const verdict = await imageCurrent(source, head);

if (verdict.current) console.log(`current: nothing the image runs changed between ${source} and ${head}`);
else {
  console.log(`stale: ${verdict.why}`);

  for (const file of verdict.changed) console.log(`  ${file}`);
}

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `current=${verdict.current}\n`);
