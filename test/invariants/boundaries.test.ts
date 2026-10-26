import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * Each domain folder has two doors. contract.ts holds its shapes, names and pure helpers, and imports
 * nothing else from the folder, so anything (the CLI and Node tests too) can load it. wiring.ts holds
 * the classes and routes the Worker runs. Code outside a domain comes in through one of those two, so a
 * domain's other files can change without the rest of ky noticing. The CLI runs in Node and takes only
 * the Worker's contracts. Deploy is the CLI's own domain (cli/deploy), with the same two doors.
 */
const REPO = path.join(import.meta.dirname, "../..");

const DOMAINS = ["src/dreaming", "src/peers", "src/skills", "src/automations", "src/machines", "src/settings", "src/access", "src/sites", "cli/deploy"];

function sources(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "tests" || entry.name === "node_modules" ? [] : sources(at);

    return /\.tsx?$/.test(entry.name) ? [at] : [];
  });
}

/** Each import of a domain file from outside that domain, as `file → domain/module`. */
function crossings(): { file: string; domain: string; module: string }[] {
  return [...sources("src"), ...sources("cli")].flatMap((file) => {
    const text = readFileSync(path.join(REPO, file), "utf8");

    return [...text.matchAll(/from "(\.[^"]+)"/g)].flatMap(([, specifier = ""]) => {
      const target = path.relative(REPO, path.resolve(path.join(REPO, path.dirname(file)), specifier));
      const domain = DOMAINS.find((root) => path.dirname(target) === root);

      if (domain === undefined || file.startsWith(domain + path.sep)) return [];

      return [{ file, domain, module: path.basename(target).replace(/\.tsx?$/, "") }];
    });
  });
}

it("finds the imports it checks", () => {
  expect(crossings().length).toBeGreaterThan(20);
});

it("enters a domain only through its contract or its wiring", () => {
  expect(crossings().filter(({ module }) => module !== "contract" && module !== "wiring")).toEqual([]);
});

it("lets the CLI, which runs in Node, take only contracts", () => {
  expect(crossings().filter(({ file, domain, module }) => file.startsWith("cli") && domain.startsWith("src") && module !== "contract")).toEqual([]);
});

it("enters deploy only through its contract or its wiring", () => {
  expect(crossings().some(({ domain }) => domain === "cli/deploy")).toBe(true);
});

/** The folder modules a file loads when it runs: its `./` imports and re-exports, less type-only ones. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(path.join(REPO, file), "utf8");

  return [...text.matchAll(/^(import|export)( type)?\b[^;]*?from "\.\/([^"]+)"/gms)].flatMap(([, , typeOnly, module = ""]) =>
    typeOnly ? [] : [module.replace(/\.tsx?$/, "")]
  );
}

it("loads each contract without loading the folder's classes: what it runs is a leaf", () => {
  const deep = DOMAINS.flatMap((domain) =>
    runtimeImports(path.join(domain, "contract.ts")).flatMap((module) =>
      runtimeImports(path.join(domain, `${module}.ts`)).map((next) => `${domain}/contract → ./${module} → ./${next}`)
    )
  );

  expect(deep).toEqual([]);
});
