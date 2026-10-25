import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ProviderInfo, SpecialistView } from "../../src/protocol";
import {
  AnswerAction,
  kitsOf,
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
import { CHANGES, skillsExtension, viewText } from "../../src/skills/skills";
import { MANAGE } from "../../src/skills/specialists";
import { ACTIONS } from "../../src/skills/subagents";
import { Reviews, Skills } from "../../src/skills/wiring";
import { specialistDraft } from "../../src/ui/Soul";
import { blockOf, HOST, storageOf } from "../parity/skills/storage";

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
    answers: { calendar: "Work", gone: "a need the skill no longer asks" },
    kind: "skill"
  };

  const none = () => undefined;

  it("shows a chat the answers and asks the open needs in one card", () => {
    const text = viewText(skill, { peer: false, chat: true, find: none });

    expect(text).toContain("## Answers\n- calendar: Work");
    expect(text).not.toContain("gone");
    expect(text).toMatch(/## Open needs\nAsk the user these .* one ui card[\s\S]*- tone: How formal should invites read\?/);
  });

  it("tells a run outside a chat not to ask, and shows a peer neither answers nor needs", () => {
    expect(viewText(skill, { peer: false, chat: false, find: none })).toContain("only the user can, from a chat");
    const peer = viewText(skill, { peer: true, chat: false, find: none });

    expect(peer).not.toContain("## Answers");
    expect(peer).not.toContain("## Open needs");
  });
});

describe("a kit's Members", () => {
  const row = (name: string, extra: Partial<SkillRow> = {}): SkillRow => ({
    name,
    description: `Doing ${name}`,
    body: "",
    status: "active",
    uses: 0,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    pinned: false,
    created_by: "user",
    answers: {},
    kind: "skill",
    ...extra
  });

  const members = (...names: string[]) => `Ship a change.\n\n## Members\n${names.map((name) => `- ${name}`).join("\n")}`;

  it("names each skill's active kits, never a kit as its own, and ignores Members on a plain skill", () => {
    const skills = [
      row("ship-change", { kind: "kit", body: members("plan-change", "pr-kit", "ship-change") }),
      row("pr-kit", { kind: "kit", body: members("open-pr", "plan-change") }),
      row("old-kit", { kind: "kit", status: "archived", body: members("open-pr") }),
      row("notes", { body: members("open-pr") })
    ];

    expect(Object.fromEntries(kitsOf(skills))).toEqual({ "plan-change": ["ship-change", "pr-kit"], "pr-kit": ["ship-change"], "open-pr": ["pr-kit"] });
  });

  it("never lists a kit among its own kits, whatever the bodies say", () => {
    const name = fc.constantFrom("a", "b", "c", "d");

    fc.assert(
      fc.property(fc.array(fc.tuple(name, fc.boolean(), fc.array(name, { maxLength: 5 })), { maxLength: 6 }), (specs) => {
        const skills = specs.map(([each, kit, named]) => row(each, { kind: kit ? "kit" : "skill", body: members(...named) }));

        for (const [member, kits] of kitsOf(skills)) {
          expect(kits).not.toContain(member);

          for (const kit of kits) expect(skills.some((skill) => skill.name === kit && skill.kind === "kit")).toBe(true);
        }
      })
    );
  });

  it("lists a kit's members in order, marking a kit, a missing name and an archived skill", () => {
    const known = new Map([
      ["plan-change", row("plan-change")],
      ["pr-kit", row("pr-kit", { kind: "kit" })],
      ["old-lint", row("old-lint", { status: "archived" })]
    ]);

    const kit = row("ship-change", { kind: "kit", body: members("plan-change", "pr-kit", "gone", "old-lint") });
    const text = viewText(kit, { peer: false, chat: true, find: (name) => known.get(name) });

    expect(text).toContain("# ship-change (kit)");
    expect(text).toContain("- plan-change: Doing plan-change\n- pr-kit (kit): Doing pr-kit\n- gone (missing)\n- old-lint (archived)");
    expect(viewText(row("lone", { kind: "kit" }), { peer: true, chat: false, find: () => undefined })).toContain("## Members\nNone yet");
  });

  it("shows a kit's Members once, resolved, and keeps the sections after it", () => {
    const kit = row("ship-change", { kind: "kit", body: `${members("plan-change")}\n\n## Done when\nMerged.` });
    const text = viewText(kit, { peer: true, chat: false, find: () => undefined });

    expect(text.match(/## Members/g)).toHaveLength(1);
    expect(text).toContain("Ship a change.\n\n## Done when\nMerged.");
    expect(text).toContain("- plan-change (missing)");
  });
});

describe("stored skills", () => {
  const corrupt = fc.constantFrom("{", "", "[]", '["a"]', "null", '{"a":1}', '{"a":null}', "7");

  const aStoredSkill = fc.record({
    name: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: fc.string(),
    body: fc.string(),
    status: fc.constantFrom("active", "archived"),
    uses: fc.nat(),
    created_at: fc.nat(),
    updated_at: fc.nat(),
    last_used_at: fc.option(fc.nat(), { nil: null }),
    pinned: fc.constantFrom(0, 1),
    created_by: fc.constantFrom("user", "agent", "review", "dream"),
    answers: fc.oneof(fc.constant(null), fc.dictionary(fc.string(), fc.string()).map((answers) => JSON.stringify(answers)), corrupt),
    kind: fc.constantFrom("skill", "kit")
  });

  /** What a row's answers column reads as: an object of strings as it is, anything else as none. */
  function answersIn(column: string | null): Record<string, string> {
    if (column === null) return {};

    try {
      const parsed: unknown = JSON.parse(column);

      return Schema.is(Schema.Record(Schema.String, Schema.String))(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  it("reads back every skill row it stores, a kit as a kit, and answers that aren't an object of strings as none", () => {
    fc.assert(
      fc.property(fc.uniqueArray(aStoredSkill, { selector: (row) => row.name, maxLength: 5 }), (rows) => {
        const db = new DatabaseSync(":memory:");
        const skills = new Skills(storageOf(db));

        for (const row of rows) {
          const columns = Object.keys(row);
          db.prepare(`INSERT INTO ${SKILL_TABLES.skills} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
        }

        const read = rows.map((row) => ({ ...row, pinned: row.pinned === 1, answers: answersIn(row.answers) }));

        for (const each of read) expect(skills.get(each.name)).toEqual(each);
        expect(skills.all()).toEqual([...read].sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || (a.name < b.name ? -1 : 1)));
        db.close();
      })
    );
  });

  it("keeps what a change saved, as the next read and the history give it", () => {
    const aText = (max: number) => fc.string({ minLength: 1, maxLength: max }).filter((text) => text.trim() !== "");

    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,63}$/),
        aText(200),
        fc.string({ maxLength: 500 }),
        fc.constantFrom("skill", "kit"),
        fc.constantFrom("user", "agent", "review", "dream"),
        (name, description, body, kind, actor) => {
          const db = new DatabaseSync(":memory:");
          const skills = new Skills(storageOf(db));

          skills.apply({ action: "create", name, description, body, kind }, actor);

          expect(skills.get(name)).toMatchObject({ name, description, body, kind, status: "active", created_by: actor, pinned: false, answers: {} });
          expect(skills.history(name)).toEqual([expect.objectContaining({ name, action: "create", actor, description, body, status: "active" })]);
          db.close();
        }
      )
    );
  });
});

describe("a background run's tools", () => {
  const KINDS = ["review", "dream", "episode", "look"] as const;

  const known = [...new Set(Object.values(REVIEW_ALLOWED).flat()), ...Object.values(TOOLS), "memory_write", "bash"];

  it("lets a fork call only the tools its kind's allowlist names, and blocks nothing in a conversation that isn't one", async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.constantFrom(...KINDS), { nil: undefined }), fc.oneof(fc.constantFrom(...known), fc.string()), async (kind, name) => {
        const db = new DatabaseSync(":memory:");
        const skills = new Skills(storageOf(db));
        const reviews = new Reviews(storageOf(db));

        if (kind !== undefined) reviews.add("2", "1", kind);
        const block = await blockOf(skillsExtension(skills, reviews, HOST, () => false), name, "2");

        if (kind === undefined || REVIEW_ALLOWED[kind].includes(name)) expect(block).toBeNull();
        else expect(block).toContain(`may only call ${REVIEW_ALLOWED[kind].join(", ")}.`);
        db.close();
      })
    );
  });
});

describe("a skill's guards", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const MACHINES = ["review", "dream"];
  const steep = { description: "When the user wants tea.", body: "Steep for three minutes." };

  it("leaves a pinned skill as it is, whatever a background run asks", () => {
    const aChange = fc.constantFrom<SkillChange>(
      { action: "edit", name: "tea", body: "Steep again." },
      { action: "patch", name: "tea", old: "two", new: "four" },
      { action: "archive", name: "tea", absorbed_into: "coffee" },
      { action: "revert", name: "tea", version: 1 }
    );

    fc.assert(
      fc.property(aChange, fc.constantFrom(...MACHINES), (change, machine) => {
        const skills = new Skills(storageOf(new DatabaseSync(":memory:")));

        skills.apply({ action: "create", name: "tea", ...steep }, "agent");
        skills.apply({ action: "edit", name: "tea", body: "Steep for two minutes." }, "agent");
        skills.apply({ action: "create", name: "coffee", ...steep }, "agent");
        skills.apply({ action: "pin", name: "tea" }, "user");
        const was = { skill: skills.get("tea"), history: skills.history("tea") };

        expect(() => skills.apply(change, machine)).toThrow("tea is pinned");
        expect({ skill: skills.get("tea"), history: skills.history("tea") }).toEqual(was);
      })
    );
  });

  it("sweeps as stale exactly the unpinned skills ky made that nobody opened in 60 days", () => {
    const aSkill = fc.record({ actor: fc.constantFrom("user", "ky", "agent", ...MACHINES), pinned: fc.boolean(), opened: fc.boolean() });

    fc.assert(
      fc.property(fc.array(aSkill, { maxLength: 6 }), fc.integer({ min: 0, max: 120 }), (made, days) => {
        const skills = new Skills(storageOf(new DatabaseSync(":memory:")));

        made.forEach(({ actor, pinned, opened }, at) => {
          skills.apply({ action: "create", name: `skill-${at}`, ...steep }, actor);

          if (pinned) skills.apply({ action: "pin", name: `skill-${at}` }, "user");

          if (opened) skills.view(`skill-${at}`);
        });

        const stale = made.flatMap(({ actor, pinned }, at) => (!pinned && ["agent", ...MACHINES].includes(actor) && days >= 60 ? [`skill-${at}`] : []));

        expect(skills.stale("run-1", Date.now() + days * DAY)).toEqual(stale);
        expect(skills.list("archived").map((skill) => skill.name)).toEqual(stale);
      })
    );
  });

  it("keeps a skill's other answers when the user answers one, and clears one answered blank", () => {
    const anAnswer = fc.dictionary(fc.constantFrom("city", "budget"), fc.constantFrom("paris", " rome ", "10", "", " "), { minKeys: 1 });

    fc.assert(
      fc.property(fc.array(anAnswer, { maxLength: 5 }), (replies) => {
        const skills = new Skills(storageOf(new DatabaseSync(":memory:")));
        const kept: Record<string, string> = {};

        skills.apply({ action: "create", name: "plan-trip", description: "When planning a trip.", body: "## Needs\n- city: Which city?\n- budget: How much?\n\nBook it." }, "user");

        for (const reply of replies) {
          skills.apply({ action: "answer", name: "plan-trip", answers: reply }, "user");

          for (const [key, value] of Object.entries(reply)) {
            if (value.trim() === "") delete kept[key];
            else kept[key] = value.trim();
          }
        }

        expect(skills.get("plan-trip")?.answers).toEqual(kept);
      })
    );
  });
});
