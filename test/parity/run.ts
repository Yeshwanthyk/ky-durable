/**
 * `pnpm parity <domain> [--mutant <name>] [--runs N] [--steps N] [--seed S]`: a domain's proof at the
 * bar, or with a known-bad patch applied, which must fail it.
 *
 * The proof is the domain's tests below: its invariants, and its parity runs while it's being ported.
 * Every test must pass at 500 runs of up to 30 steps. With --mutant, after that clean proof the patch
 * `test/parity/<domain>/mutants/<name>.patch` is applied to the working tree, the proof runs again, the
 * patch is taken back out, and the mutant counts as caught only if a test that held clean failed: a
 * proof no mutant can break proves nothing. `--mutant all` runs every mutant of the domain.
 *
 * Each run writes test-results/parity/<domain>/<run>.json: the seed, the tool versions, the outcome
 * and the first counterexample, so a failure can be replayed with --seed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Type from "typebox";
import { parseAs } from "../../src/core/decode.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

/** Each domain's proof: the test files `pnpm parity` runs. */
const PROOFS = {
  toy: ["test/parity/toy/toy.test.ts"],
  deploy: ["test/invariants/deploy.test.ts"],
  automations: ["test/invariants/automations.test.ts"],
  skills: ["test/invariants/skills.test.ts"]
} satisfies Record<string, string[]>;

const isDomain = (name: string | undefined): name is keyof typeof PROOFS => name !== undefined && Object.hasOwn(PROOFS, name);

const Report = Type.Object({
  success: Type.Boolean(),
  testResults: Type.Array(
    Type.Object({
      name: Type.String(),
      assertionResults: Type.Array(Type.Object({ fullName: Type.String(), status: Type.String(), failureMessages: Type.Array(Type.String()) }))
    })
  )
});

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);

  return at === -1 ? undefined : argv[at + 1];
}

const domain = argv[0];

if (!isDomain(domain)) {
  console.error(`usage: pnpm parity <${Object.keys(PROOFS).join("|")}> [--mutant <name|all>] [--runs N] [--steps N] [--seed S]`);
  process.exit(2);
}

const proof = PROOFS[domain];

const MUTANTS = path.join(REPO, "test/parity", domain, "mutants");

const OUT = path.join(REPO, "test-results/parity", domain);

const runs = Number(flag("runs") ?? 500);

const steps = Number(flag("steps") ?? 30);

const seed = Number(flag("seed") ?? Date.now() % 2 ** 31);

function git(...args: string[]) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function version(name: string): string {
  const manifest = parseAs(Type.Object({ version: Type.String() }), readFileSync(path.join(REPO, "node_modules", name, "package.json"), "utf8"), name);

  return manifest.version;
}

type Outcome = { passed: boolean; held: string[]; failures: { test: string; message: string }[] };

/** Runs the domain's proof at the budget; whether it passed, and each failing test's first lines. */
function prove(label: string): Outcome {
  mkdirSync(OUT, { recursive: true });
  const report = path.join(OUT, `${label}.vitest.json`);

  const run = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "test/invariants/vitest.config.ts", "--reporter=json", `--outputFile=${report}`, ...proof], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, KY_RUNS: String(runs), KY_STEPS: String(steps), KY_SEED: String(seed) },
    maxBuffer: 64 * 1024 * 1024
  });

  if (!existsSync(report)) throw new Error(`vitest wrote no report (exit ${run.status}):\n${run.stderr.slice(-2000)}`);
  const { success, testResults } = parseAs(Report, readFileSync(report, "utf8"), report);

  const failures = testResults.flatMap((file) =>
    file.assertionResults.flatMap((test) => (test.status === "failed" ? [{ test: test.fullName, message: (test.failureMessages[0] ?? "").split("\n").slice(0, 12).join("\n") }] : []))
  );

  const held = testResults.flatMap((file) => file.assertionResults.flatMap((test) => (test.status === "passed" ? [test.fullName] : [])));

  return { passed: success && run.status === 0, held, failures };
}

/** The proof with `mutant` applied; the working tree is put back however the run ends. */
function withMutant(mutant: string): Outcome {
  const patch = path.join(MUTANTS, `${mutant}.patch`);

  if (!existsSync(patch)) throw new Error(`No mutant ${mutant}: there's no ${path.relative(REPO, patch)}`);
  const touched = git("apply", "--numstat", patch).stdout.split("\n").flatMap((line) => line.split("\t")[2] ?? []);
  const dirty = touched.filter((file) => git("status", "--porcelain", "--", file).stdout.trim() !== "");

  // Taking the patch back out with `git apply -R` would also take out edits it can't tell from its own.
  if (dirty.length > 0) throw new Error(`Commit or set aside your changes to ${dirty.join(", ")} first: the mutant patches them`);
  const applied = git("apply", patch);

  if (applied.status !== 0) throw new Error(`${mutant} no longer applies (the code moved): ${applied.stderr}`);

  try {
    return prove(`mutant-${mutant}`);
  } finally {
    git("checkout", "--", ...touched);
  }
}

const mutant = flag("mutant");

const mutants = mutant === "all" ? readdirSync(MUTANTS).flatMap((file) => (file.endsWith(".patch") ? [file.slice(0, -".patch".length)] : [])) : mutant ? [mutant] : [];

const tools = { node: process.version, vitest: version("vitest"), "fast-check": version("fast-check"), effect: version("effect"), commit: git("rev-parse", "HEAD").stdout.trim() };

let failed = false;

// A mutant is caught only by a test that held without it, so a mutant run starts with the clean proof:
// a compile error, a flake or a test already red can't pass for a catch.
const clean = prove("proof");

writeFileSync(path.join(OUT, "proof.json"), `${JSON.stringify({ domain, mutant: null, runs, steps, seed, tools, at: new Date().toISOString(), holds: clean.passed, failures: clean.failures }, null, 2)}\n`);

console.log(`${clean.passed ? "PASS" : "FAIL"}  ${domain}: ${runs} runs of up to ${steps} steps, seed ${seed}`);

if (!clean.passed) {
  for (const failure of clean.failures) console.log(`\n${failure.test}\n${failure.message}`);

  if (mutants.length > 0) console.log("No mutant runs: a mutant can only be caught by a proof that holds without it.");
  failed = true;
}

for (const each of clean.passed ? mutants : []) {
  const outcome = withMutant(each);
  const caughtBy = outcome.failures.filter((failure) => clean.held.includes(failure.test));
  const holds = caughtBy.length > 0;

  writeFileSync(path.join(OUT, `mutant-${each}.json`), `${JSON.stringify({ domain, mutant: each, runs, steps, seed, tools, at: new Date().toISOString(), holds, caughtBy: caughtBy.map((failure) => failure.test), failures: outcome.failures }, null, 2)}\n`);
  console.log(`${holds ? "PASS" : "FAIL"}  ${domain} --mutant ${each}: ${holds ? `caught by ${caughtBy.map((failure) => failure.test).join("; ")}` : "no test that held without it failed with it: the proof can't see this break"}`);
  failed ||= !holds;
}

console.log(`Evidence: ${path.relative(REPO, OUT)}/`);

process.exit(failed ? 1 : 0);
