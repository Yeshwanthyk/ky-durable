import { ROOT_SESSION } from "agents/harness/pi";
import { AVATAR_TOOL, EXAMPLES } from "./avatar-spec";
import type { Automations } from "./automations/contract";
import type { Setup } from "./setup";
import type { Skills, Specialists } from "./skills/contract";

/**
 * What a new ky starts with, once, on its first start: starter skills, one
 * example specialist and starter automations. Everything that acts on its
 * own is off: the skills are archived and the automations paused, so the
 * owner turns on what they want from Skills and Activity. make-avatar and
 * make-skill are the exceptions: on, and added to a ky that predates them.
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

/**
 * How to make a bloub avatar, on from the start: it runs only when asked. A ky from before it gets it
 * on its next start; once there, the owner's edits and archiving stand.
 */
const MAKE_AVATAR = {
  name: "make-avatar",
  description: "Design a cute animated avatar (a bloub) for ky or a specialist, show options, and save the one the user picks.",
  body: [
    "When asked to make, change or pick an avatar (for ky, or for a specialist):",
    "",
    "1. Ask who it is for and what it should feel like, unless the user said. One question, not a form.",
    `2. Design three different bloubs and show them together: ${AVATAR_TOOL} preview with specs. If the user wants random ones, ${AVATAR_TOOL} roll.`,
    "3. Ask which one, or what to change (colour, eyes, what sits on top, rounder or squarer). Preview again until they like one.",
    `4. Save it: ${AVATAR_TOOL} set, for "ky" or the specialist's id. Never save one the user hasn't picked.`,
    "",
    "A bloub is parts, never SVG: body { w, h: 80 to 124; corner: 0 square to half the side round; color }, eyes { count: 1 or 2; size },",
    "top { kind: none, antenna, leaf, ears, sprout or tuft; color }, cheeks and feet (true or false), and an optional name.",
    "",
    "What makes one cute:",
    "- One saturated body colour. A pale one (cream, butter) reads soft; keep strong colours for the accent on top.",
    "- Big eyes: one eye at 24 to 30 is bold and funny; two eyes at 12 to 17 are sweet. Small eyes look sleepy.",
    "- Round it: a corner of a third of the side or more. Square bodies stay friendly with cheeks and feet.",
    "- A contrasting top colour: yellow on red, pink on teal, green on blue. Ears take the body's colour.",
    "- Make the three options differ in shape and eyes, not just colour.",
    "",
    "Good ones, to learn from:",
    ...Object.values(EXAMPLES).map((spec) => JSON.stringify(spec))
  ].join("\n")
};

/**
 * How to make a skill when the owner asks for one, on from the start like make-avatar. The bar it drafts to
 * is SKILL_CRAFT, in every conversation's skills rules; a skill review and the dream write to it too.
 */
const MAKE_SKILL = {
  name: "make-skill",
  description: "Make or rework a skill when the user asks for one. Not for the skills ky saves on its own after a task.",
  body: [
    "When asked to make a skill, to remember how to do something, or to improve a skill:",
    "",
    "1. Find the job: the class of task, what starts it, and what it is not for. Ask at most two questions, only what the conversation doesn't already say. If the user describes two jobs, propose two skills.",
    "2. Check the skill list. When one covers the class, open it with skill_view and extend it: a near-twin splits the uses between two skills and neither gets better.",
    '3. Draft it to the bar in your skills rules. Name it by the class of task (like "weekly-grocery-order"), never by today\'s details.',
    "4. Show the draft, then walk one real example through it step by step, from this conversation or one the user gives. Where the walk-through stalls or has to guess, fix that step.",
    "5. Save it with skill_manage (create, or edit when extending) only once the user says yes. Offer to pin it if they want ky's reviews and dreams to leave it as it is.",
    "",
    "Pitfalls:",
    "- A step that only restates the request. A skill is the how: the order, the checks, the preferences.",
    "- Facts about the user or this one task: those belong to memory.",
    "- Steps from the first draft that the walk-through never used.",
    "",
    "Done when the user has approved it, it is saved, and the walk-through needed no guessing."
  ].join("\n")
};

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
  for (const skill of [MAKE_AVATAR, MAKE_SKILL]) {
    if (!skills.get(skill.name)) skills.apply({ action: "create", ...skill }, "ky");
  }

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
      { ...automation, at: null, model: null, machine: null, chat: ROOT_SESSION, gate: null },
      "ky"
    );

    if (!("refused" in created)) await automations.pause(created.id);
  }
}
