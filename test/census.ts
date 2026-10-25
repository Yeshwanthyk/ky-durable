/**
 * `pnpm census <domain|all>`: each test file a domain's port touches, sorted by what it is, so the
 * port knows what to keep and what the prune ledger may take.
 *
 *   INVARIANT  a property or contract test (test/invariants, test/parity, fast-check): keep
 *   E2E        the real PiAgent (src/tests), the harness, Playwright: keep
 *   MOCK       vi.mock, vi.fn or vi.spyOn: delete, or rewrite as an invariant
 *   SCAN       reads src as text and matches it: becomes a lint rule
 *   SLEEP      waits on real time: TestClock, or delete
 *   COPY       Playwright matching the app's words: one per journey
 *   UNIT       imports a domain's internals: the parity runs cover it
 *   UNKNOWN    none of the above: a scout quotes it, the domain thread decides
 *
 * A file gets every class whose signal it shows, each with the first line that shows it, and one
 * verdict: a keep class wins over the prune classes, since an E2E test that sleeps is still kept.
 * Writes test-results/census/<domain>.json.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

const ROOTS = ["src/tests", "test/node", "test/invariants", "test/parity", "test/web", "test/harness"];

/** Which files belong to a domain: their path, or a module they import, matches. */
const DOMAINS = {
  deploy: /deploy|cloudflare|\binit\b|overlay|wrangler/i,
  automations: /automation|routine|schedul|check-?ins?/i,
  skills: /skill/i
} satisfies Record<string, RegExp>;

type Domain = keyof typeof DOMAINS;

const isDomain = (name: string): name is Domain => Object.hasOwn(DOMAINS, name);

const CLASSES = ["INVARIANT", "E2E", "MOCK", "SCAN", "SLEEP", "COPY", "UNIT"] as const;

type Class = (typeof CLASSES)[number];

const KEEP = new Set<Class>(["INVARIANT", "E2E"]);

/** Each class's signal, given the file's path and text. */
const SIGNALS: Record<Class, (file: string) => RegExp | boolean> = {
  INVARIANT: (file) => file.startsWith("test/invariants/") || file.startsWith("test/parity/") || /from "fast-check"/,
  E2E: (file) => file.startsWith("src/tests/") || file.startsWith("test/web/") || file.startsWith("test/harness/"),
  MOCK: () => /\bvi\.(mock|fn|spyOn)\(/,
  SCAN: () => /readFileSync\([^)]*\bsrc\b|readFileSync\(.*\.(ts|tsx)["'`]/,
  SLEEP: () => /\bsetTimeout\(|\bsleep\(|waitForTimeout\(/,
  COPY: (file) => (file.startsWith("test/web/") ? /getByText\(|toHaveText\(|toContainText\(/ : false),
  UNIT: (file) => (file.startsWith("test/node/") ? /from "\.\.\/\.\.\/(src|cli)\/(?!core\/)[^"]+"/ : false)
};

const TEST = /^\s*(?:it|test)(?:\.\w+)*\(\s*["'`]/gm;

function files(root: string): string[] {
  const dir = path.join(REPO, root);

  return readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) =>
    entry.isFile() && /\.(test|spec)\.tsx?$/.test(entry.name) ? [path.relative(REPO, path.join(entry.parentPath, entry.name))] : []
  );
}

type Row = { file: string; tests: number; verdict: Class | "UNKNOWN"; signals: { class: Class; line: number; quote: string }[] };

function classify(file: string, text: string): Row {
  const lines = text.split("\n");
  const signals: Row["signals"] = [];

  for (const each of CLASSES) {
    const signal = SIGNALS[each](file);

    if (signal === false) continue;

    if (signal === true) {
      signals.push({ class: each, line: 0, quote: file });
      continue;
    }

    const at = lines.findIndex((line) => signal.test(line));

    if (at !== -1) signals.push({ class: each, line: at + 1, quote: lines[at]!.trim().slice(0, 160) });
  }

  const kept = signals.find((signal) => KEEP.has(signal.class));
  const verdict = kept?.class ?? signals[0]?.class ?? "UNKNOWN";

  return { file, tests: text.match(TEST)?.length ?? 0, verdict, signals };
}

const wanted = process.argv[2] ?? "all";

if (wanted !== "all" && !isDomain(wanted)) {
  console.error(`usage: pnpm census <${Object.keys(DOMAINS).join("|")}|all>`);
  process.exit(2);
}

const domains = wanted === "all" ? Object.keys(DOMAINS).filter(isDomain) : [wanted];

const all = ROOTS.flatMap(files).map((file) => ({ file, text: readFileSync(path.join(REPO, file), "utf8") }));

mkdirSync(path.join(REPO, "test-results/census"), { recursive: true });

for (const domain of domains) {
  const imports = (text: string) => [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "").join("\n");
  const rows = all.flatMap(({ file, text }) => (DOMAINS[domain].test(file) || DOMAINS[domain].test(imports(text)) ? [classify(file, text)] : []));
  const tally = Object.fromEntries([...CLASSES, "UNKNOWN"].map((each) => [each, rows.filter((row) => row.verdict === each).length]));
  const out = path.join(REPO, "test-results/census", `${domain}.json`);

  writeFileSync(out, `${JSON.stringify({ domain, at: new Date().toISOString(), tally, rows }, null, 2)}\n`);
  console.log(`${domain.padEnd(12)} ${rows.length} files  ${Object.entries(tally).flatMap(([name, count]) => (count > 0 ? [`${name} ${count}`] : [])).join(", ")}  → ${path.relative(REPO, out)}`);
}
