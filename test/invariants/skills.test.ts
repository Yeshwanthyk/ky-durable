import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ProviderInfo, SpecialistView } from "../../src/protocol";
import {
  AnswerAction,
  PinAction,
  REVIEW_ALLOWED,
  SkillAction,
  SkillChange,
  SpecialistAction,
  SpecialistInput,
  specialistOf,
  SubagentAction,
  SubagentInput,
  parse,
  type SkillRow,
  SKILL_TABLES,
  TOOLS
} from "../../src/skills/contract";
import { CHANGES, viewText } from "../../src/skills/skills";
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
    ["specialist", SpecialistAction, SpecialistInput.properties.action, MANAGE],
    ["subagent", SubagentAction, SubagentInput.properties.action, ACTIONS]
  ] as const)("gives every %s action a handler, and the tool takes only those", (_tool, union, input, handlers) => {
    expect(input).toBe(union);
    expect(Object.keys(handlers).sort()).toEqual(literals(union));
  });

  it("gives every skill_manage change a handler, and takes those plus pin, unpin and answer, which write no version", () => {
    expect(SkillChange.properties.action.anyOf).toEqual([SkillAction, PinAction, AnswerAction]);
    expect(Object.keys(CHANGES).sort()).toEqual(literals(SkillAction));
    expect(literals(PinAction)).toEqual(["pin", "unpin"]);
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
    expect(SKILL_TABLES).toEqual({
      skills: "ky_skills",
      skillVersions: "ky_skill_versions",
      skillReviews: "ky_skill_reviews",
      specialists: "ky_specialists",
      specialistSessions: "ky_specialist_sessions"
    });
    expect(Object.isFrozen(SKILL_TABLES)).toBe(true);
  });

  it("creates each table it names, only if missing, and never drops one", () => {
    const text = sources.map((source) => source.text).join("\n");
    const created = [...text.matchAll(/CREATE TABLE (IF NOT EXISTS )?\$\{SKILL_TABLES\.(\w+)\}/g)];

    expect(created.every((match) => match[1] !== undefined)).toBe(true);
    expect(created.map((match) => match[2]).sort()).toEqual(Object.keys(SKILL_TABLES).sort());
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
    models: [{ modelId: "claude", name: "Claude", featured: true, levels: ["off", "high"], images: true }]
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

describe("a skill's Needs", () => {
  const body = [
    "1. Book the room.",
    "",
    "## Needs",
    "- calendar: Which calendar holds work events? (Work | Personal)",
    "- tone: How formal should invites read?",
    "- calendar: asked twice, kept once",
    "- Bad Key: not a key",
    "- lone: (only | )",
    "",
    "## Members",
    "- weekly-groceries",
    "- `meal-plan`",
    "- weekly-groceries",
    "",
    "## Steps",
    "- calendar: not a need here"
  ].join("\n");

  it("reads each need once, with its choices, and each member once", () => {
    expect(parse(body)).toEqual({
      needs: [
        { key: "calendar", question: "Which calendar holds work events?", choices: ["Work", "Personal"] },
        { key: "tone", question: "How formal should invites read?", choices: [] },
        { key: "lone", question: "(only | )", choices: [] }
      ],
      members: ["weekly-groceries", "meal-plan"]
    });
  });

  it("never throws, and every need it reads has a key and a question", () => {
    const line = fc.oneof(fc.string(), fc.constantFrom("## Needs", "## Members", "# Title", "- a-key: q (x | y)", "- k:", "(|)", "\r"));

    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const { needs, members } = parse(lines.join("\n"));
        const keys = needs.map((need) => need.key);

        expect(new Set(keys).size).toBe(keys.length);
        expect(new Set(members).size).toBe(members.length);

        for (const need of needs) {
          expect(need.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
          expect(need.question.trim()).not.toBe("");
          expect(need.choices.length === 0 || need.choices.length >= 2).toBe(true);
        }
      })
    );
  });

  const skill: SkillRow = {
    name: "book-room",
    description: "Booking a meeting room",
    body,
    status: "active",
    uses: 0,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    pinned: false,
    created_by: "user",
    answers: { calendar: "Work", gone: "a need the skill no longer asks" }
  };

  it("shows a chat the answers and asks the open needs in one card", () => {
    const text = viewText(skill, { peer: false, chat: true });

    expect(text).toContain("## Answers\n- calendar: Work");
    expect(text).not.toContain("gone");
    expect(text).toMatch(/## Open needs\nAsk the user these .* one ui card[\s\S]*- tone: How formal should invites read\?/);
  });

  it("tells a run outside a chat not to ask, and shows a peer neither answers nor needs", () => {
    expect(viewText(skill, { peer: false, chat: false })).toContain("only the user can, from a chat");
    const peer = viewText(skill, { peer: true, chat: false });

    expect(peer).not.toContain("## Answers");
    expect(peer).not.toContain("## Open needs");
  });
});
