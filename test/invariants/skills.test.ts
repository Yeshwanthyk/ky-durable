import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderInfo, SpecialistView } from "../../src/protocol";
import {
  REVIEW_ALLOWED,
  SkillAction,
  SkillChange,
  SpecialistAction,
  SpecialistInput,
  specialistOf,
  SubagentAction,
  SubagentInput,
  TABLES,
  TOOLS
} from "../../src/skills/contract";
import { CHANGES } from "../../src/skills/skills";
import { MANAGE } from "../../src/skills/specialists";
import { ACTIONS } from "../../src/skills/subagents";
import { specialistDraft } from "../../src/ui/Soul";

/** What the skills domain promises, whatever its code becomes: src/skills/contract.ts. */

const FOLDER = path.join(import.meta.dirname, "../../src/skills");

const sources = readdirSync(FOLDER)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(path.join(FOLDER, file), "utf8") }));

const literals = (union: { readonly anyOf: ReadonlyArray<{ readonly const: string }> }) => union.anyOf.map((each) => each.const).sort();

describe("each tool's actions", () => {
  it.each([
    ["skill_manage", SkillAction, SkillChange.properties.action, CHANGES],
    ["specialist", SpecialistAction, SpecialistInput.properties.action, MANAGE],
    ["subagent", SubagentAction, SubagentInput.properties.action, ACTIONS]
  ] as const)("gives every %s action a handler, and the tool takes only those", (_tool, union, input, handlers) => {
    expect(input).toBe(union);
    expect(Object.keys(handlers).sort()).toEqual(literals(union));
  });
});

describe("allowlists", () => {
  it("lets a review and a dream tend the library with this domain's own tools", () => {
    for (const kind of ["review", "dream"] as const) expect(REVIEW_ALLOWED[kind]).toEqual(expect.arrayContaining([TOOLS.skillView, TOOLS.skillManage]));
  });

  it("lets a dream do all a review may, and never manage specialists or subagents", () => {
    expect(REVIEW_ALLOWED.dream).toEqual(expect.arrayContaining([...REVIEW_ALLOWED.review]));

    for (const kind of ["review", "dream"] as const) {
      expect(REVIEW_ALLOWED[kind]).not.toContain(TOOLS.specialist);
      expect(REVIEW_ALLOWED[kind]).not.toContain(TOOLS.subagent);
    }
  });
});

describe("storage", () => {
  const stored = { id: "eng", description: "Builds.", machine: null, session: null, created_at: 1 };

  it("decodes a specialist's model column", () => {
    const model = { provider: "anthropic", modelId: "claude", thinkingLevel: "high" };
    expect(specialistOf({ ...stored, model: JSON.stringify(model) }).model).toEqual(model);
    expect(specialistOf({ ...stored, model: null }).model).toBeNull();
  });

  it.each(["{", "", "null", "[]", `{"provider":"anthropic"}`, `{"provider":"a","modelId":"b","thinkingLevel":"loud"}`])(
    "reads a corrupt model column %j as no model, so the worker's runs",
    (model) => {
      expect(specialistOf({ ...stored, model }).model).toBeNull();
    }
  );

  it("keeps the names of the tables it owns: a restore matches them by name", () => {
    expect(TABLES).toEqual({
      skills: "ky_skills",
      skillVersions: "ky_skill_versions",
      skillReviews: "ky_skill_reviews",
      specialists: "ky_specialists",
      specialistSessions: "ky_specialist_sessions"
    });
    expect(Object.isFrozen(TABLES)).toBe(true);
  });

  it("creates each table it names, only if missing, and never drops one", () => {
    const text = sources.map((source) => source.text).join("\n");
    const created = [...text.matchAll(/CREATE TABLE (IF NOT EXISTS )?\$\{TABLES\.(\w+)\}/g)];

    expect(created.every((match) => match[1] !== undefined)).toBe(true);
    expect(created.map((match) => match[2]).sort()).toEqual(Object.keys(TABLES).sort());
    expect(text).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("names its tables only through the contract", () => {
    for (const { file, text } of sources.filter((source) => source.file !== "contract.ts")) {
      expect({ file, names: text.match(/\bky_(skill|specialist)\w*/g) ?? [] }).toEqual({ file, names: [] });
    }
  });
});

describe("the panel's specialist sheet", () => {
  const model = { provider: "anthropic", modelId: "claude", thinkingLevel: "high" } as const;

  const specialist: SpecialistView = {
    id: "eng",
    description: "Builds.",
    model,
    machine: null,
    session: null,
    created_at: 1,
    brief: { body: "Be exact.", version: 1, updated_at: 1 }
  };

  const form = { id: "eng", description: "Builds things.", brief: "", machine: "", model: "anthropic/claude", thinking: "high" };

  const provider = (connected: boolean): ProviderInfo => ({
    id: "anthropic",
    kind: "api-key",
    name: "Anthropic",
    connected,
    models: [{ modelId: "claude", name: "Claude", levels: ["off", "high"], images: true }]
  });

  it("keeps the stored model when the user didn't change it, even with its provider disconnected", () => {
    expect(specialistDraft(form, [provider(false)], specialist)).toEqual({ description: "Builds things.", machine: null });
    expect(specialistDraft(form, [provider(true)], specialist)).toEqual({ description: "Builds things.", machine: null });
  });

  it("saves the model the user picked, or none", () => {
    expect(specialistDraft({ ...form, thinking: "off" }, [provider(true)], specialist).model).toEqual({ ...model, thinkingLevel: "off" });
    expect(specialistDraft({ ...form, model: "" }, [provider(true)], specialist)).toMatchObject({ model: null });
  });

  it("saves a new specialist's model and brief", () => {
    expect(specialistDraft({ ...form, brief: "Be exact." }, [provider(true)], undefined)).toEqual({
      description: "Builds things.",
      machine: null,
      model,
      brief: "Be exact."
    });
  });
});
