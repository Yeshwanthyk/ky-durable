import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * Each domain folder has two doors. contract.ts holds its shapes, names and pure helpers, and imports
 * nothing else from the folder, so anything (the CLI and Node tests too) can load it. wiring.ts holds
 * the classes and routes the Worker runs. Code outside a domain comes in through one of those two, so a
 * domain's other files can change without the rest of ky noticing. The CLI runs in Node and takes only
 * contracts.
 */
const REPO = path.join(import.meta.dirname, "../..");

const DOMAINS = ["dreaming", "peers", "skills", "automations", "machines"];

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
      const target = path.relative(path.join(REPO, "src"), path.resolve(path.join(REPO, path.dirname(file)), specifier));
      const [domain = "", module = ""] = target.split(path.sep);

      if (!DOMAINS.includes(domain) || file.startsWith(path.join("src", domain) + path.sep)) return [];

      return [{ file, domain, module: module.replace(/\.tsx?$/, "") }];
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
  expect(crossings().filter(({ file, module }) => file.startsWith("cli") && module !== "contract")).toEqual([]);
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
    runtimeImports(path.join("src", domain, "contract.ts")).flatMap((module) =>
      runtimeImports(path.join("src", domain, `${module}.ts`)).map((next) => `${domain}/contract → ./${module} → ./${next}`)
    )
  );

  expect(deep).toEqual([]);
});
