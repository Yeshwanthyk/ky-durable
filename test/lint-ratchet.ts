/**
 * `pnpm lint`: oxlint, type-aware, held to lint-baseline.json.
 *
 * The baseline counts the findings each file had when a rule was turned on, by rule. A file may
 * only go down: one more finding of a rule than its baseline fails, and so does any finding in a
 * file or rule the baseline doesn't list, so new code is held to every rule from its first line.
 * When a file improves, `pnpm lint --record` shrinks its entry; the run says when one could shrink.
 * The goal is an empty baseline: each refactor that touches a file clears it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Type from "typebox";
import { parseAs } from "../src/core/decode.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const BASELINE = path.join(REPO, "lint-baseline.json");

const Report = Type.Object({
  diagnostics: Type.Array(
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      filename: Type.String(),
      labels: Type.Array(Type.Object({ span: Type.Object({ line: Type.Number(), column: Type.Number() }) }))
    })
  )
});

/** Findings by file, then by rule. */
const Counts = Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer({ minimum: 1 })));

type Counts = Record<string, Record<string, number>>;

// Only oxlint.config.ts applies: vendor/effect carries its own .oxlintrc.json with plugins ky doesn't install.
const run = spawnSync("pnpm", ["exec", "oxlint", "--type-aware", "--disable-nested-config", "--format", "json", ...process.argv.slice(2).filter((arg) => arg !== "--record")], {
  cwd: REPO,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024
});

const { diagnostics } = parseAs(Report, run.stdout, "oxlint's JSON report");

const found: Counts = {};

for (const { filename, code } of diagnostics) {
  const file = (found[filename] ??= {});
  file[code] = (file[code] ?? 0) + 1;
}

if (process.argv.includes("--record")) {
  const sorted = Object.fromEntries(
    Object.keys(found)
      .sort()
      .map((file) => [file, Object.fromEntries(Object.entries(found[file] ?? {}).sort(([a], [b]) => a.localeCompare(b)))])
  );

  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`lint-baseline.json: ${diagnostics.length} findings in ${Object.keys(sorted).length} files.`);
  process.exit(0);
}

const baseline = parseAs(Counts, readFileSync(BASELINE, "utf8"), "lint-baseline.json");

let failed = 0;
let shrinkable = 0;

for (const { filename, code, message, labels } of diagnostics) {
  const allowed = baseline[filename]?.[code] ?? 0;
  const count = found[filename]?.[code] ?? 0;

  if (count > allowed) {
    const at = labels[0]?.span;
    console.error(`${filename}:${at?.line ?? 0}:${at?.column ?? 0} ${code}: ${message}${allowed > 0 ? ` (${count} now, baseline ${allowed})` : ""}`);
    failed++;
  }
}

for (const [file, rules] of Object.entries(baseline)) {
  for (const [code, allowed] of Object.entries(rules)) {
    if ((found[file]?.[code] ?? 0) < allowed) shrinkable++;
  }
}

if (shrinkable > 0) console.log(`${shrinkable} baseline entries can shrink: run \`pnpm lint --record\` and commit lint-baseline.json.`);

if (failed > 0) {
  console.error(`\n${failed} lint findings beyond lint-baseline.json.`);
  process.exit(1);
}

console.log(`lint: ${diagnostics.length} findings, none beyond lint-baseline.json.`);
