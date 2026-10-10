import { ROOT_SESSION } from "agents/harness/pi";
import type { Automations } from "./automations";
import type { Setup } from "./setup";
import type { Skills } from "./skills";
import type { Specialists } from "./specialists";

/**
 * What a new ky starts with, once, on its first start: starter skills, one
 * example specialist and starter automations. Everything that acts on its
 * own is off: the skills are archived and the automations paused, so the
 * owner turns on what they want from Skills and Activity.
 */

const SKILLS = [
  {
    name: "research-brief",
    description: "Research a question across the web and write a short, sourced brief.",
    body: [
      "When asked to research something:",
      "",
      "1. Restate the question in one line and note what would answer it.",
      "2. Search widely, then read the best three to five sources in full.",
      "3. Write a brief: the answer first, then the evidence, each claim linked to its source.",
      "4. End with what is still unknown and where to look next.",
      "",
      "Keep it under a page. Say plainly when sources disagree."
    ].join("\n")
  },
  {
    name: "inbox-triage",
    description: "Sort recent email into reply, read and ignore, through Executor.",
    body: [
      "When asked to triage email:",
      "",
      "1. Use Executor's email tools to list the last day's unread mail. If Executor has no email app, say so and stop.",
      "2. Sort each message into: needs a reply, worth reading, ignore.",
      "3. For each that needs a reply, draft one in the owner's voice from SOUL.md. Never send it.",
      "4. Report the three lists, most urgent first."
    ].join("\n")
  }
] as const;

const SPECIALIST = {
  id: "editor",
  description: "Edits writing for clarity and length without changing its meaning.",
  brief: [
    "You are an editor. You are given a draft and, sometimes, who it is for.",
    "Cut what doesn't earn its place, prefer short plain words, keep the author's voice and meaning.",
    "Return the edited text, then at most five lines on what you changed and why."
  ].join("\n")
};

const AUTOMATIONS = [
  {
    title: "Daily digest",
    cron: "0 8 * * *",
    prompt: [
      "Write my morning digest.",
      "Use Executor's calendar and email tools for today's meetings and anything urgent in my inbox; if Executor has neither, say so in one line.",
      "Then list what is due today. Keep the digest under fifteen lines."
    ].join(" ")
  },
  {
    title: "Weekly review",
    cron: "0 9 * * 1",
    prompt: [
      "Review the past week of ky's own upkeep.",
      "List the skills (skills) and read each one (skill_view).",
      "Report which look stale, overlapping or wrong, and propose one fix for each.",
      "Change nothing yourself; the owner decides."
    ].join(" ")
  }
] as const;

/** Seed a new ky; does nothing after its first start. */
export async function seed(setup: Setup, skills: Skills, specialists: Specialists, automations: Automations): Promise<void> {
  if (!setup.firstStart()) return;

  for (const skill of SKILLS) {
    if (skills.get(skill.name)) continue;
    skills.apply({ action: "create", ...skill }, "ky");
    skills.apply({ action: "archive", name: skill.name }, "ky");
  }

  if (!specialists.get(SPECIALIST.id)) {
    specialists.create(SPECIALIST.id, { description: SPECIALIST.description, brief: SPECIALIST.brief }, "ky");
  }

  for (const automation of AUTOMATIONS) {
    const created = await automations.create(
      { ...automation, at: null, model: null, machine: null, chat: ROOT_SESSION },
      "ky"
    );

    if (!("refused" in created)) await automations.pause(created.id);
  }
}
