import { ROOT_SESSION } from "agents/harness/pi";
import { AVATAR_TOOL, EXAMPLES } from "./contract";
import type { Automations } from "../automations/contract";
import type { Skills, Specialists } from "../skills/contract";
import type { Setup } from "./wiring";

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

export const DEFAULT_SKILLS = [
  {
    name: "delegate",
    description: "How to brief subagents, machines and specialists so their work comes back right, and how to check it before telling the user.",
    body: [
      "When you hand work to a subagent, a machine or a specialist:",
      "1. Brief it fully. It knows nothing you don't write: give the task, why it matters, what is in and out of scope, the inputs (links, names, earlier findings), and what proof you expect back (sources, file paths, a diff, a screenshot).",
      "2. One writer per target. Never give two workers the same file, repo branch, document or account to change at once.",
      "3. Name it for its job (researcher, flight-check) and give it a 3-6 word title, so the user can follow it in Activity.",
      "4. Don't wait or poll: answers arrive as messages. Keep talking to the user meanwhile.",
      "5. When an answer arrives, check it against the brief, not against its own summary: open the source, the file or the diff it names. Missing proof means it is not done; send it back with what is missing.",
      "6. Account for every worker before you answer: done, failed (why), or still running. Never report a stopped or failed worker's work as done."
    ].join("\n")
  },
  {
    name: "fan-out",
    description: "Split a big question across several subagents, or race a few on the same task, then combine one checked answer.",
    body: [
      "Use when a task splits into independent parts, or when you want several attempts at one hard question.",
      "1. Say what done looks like before you start: the exact answer or artifact, and how you will check it.",
      "2. Pick a shape. Partition: each subagent gets its own non-overlapping slice (sources, dates, regions, files). Race: each gets the same brief; decide first whether you take the first good answer, rank all, or combine the best parts.",
      "3. Spawn them together, each with the full brief and its slice. Each must answer PASS, ISSUES or BLOCKED with evidence.",
      "4. Gather every answer. Note which failed or were blocked; don't hide gaps.",
      "5. Check the claims that matter yourself. Merge duplicates. For a race, compare whole answers against your done check, pick the best as the base and add at most one or two parts from the others. If the answers disagree wildly, the brief was unclear: rewrite it and run again rather than averaging.",
      "6. Tell the user the combined answer, what was checked, and what is still unknown."
    ].join("\n")
  },
  {
    name: "orchestrate",
    description: "Run multi-step work where later steps need earlier results: order the steps, pass real results forward, checkpoint, and keep every worker accounted for.",
    body: [
      "Use for work with steps that depend on each other, over many turns or days.",
      "1. Write the steps, what each needs from earlier ones, and how each is checked. Start independent steps together.",
      "2. Give a dependent step the actual result of the step before it (the text, links, file paths), not just \"continue from before\".",
      "3. One writer per file, branch or document at a time. Stop or finish an old worker before starting its replacement.",
      "4. After each step, keep a short checkpoint (memory_note or the task title): the goal, decisions made, what is done with its evidence, and the next action.",
      "5. Check each finished step against its artifacts before starting the next one that depends on it. A changed result means re-checking what relied on it.",
      "6. You are done when every step is finished and checked, or you can name the exact blocker. Tell the user both, and account for every worker."
    ].join("\n")
  },
  {
    name: "challenge",
    description: "Before a costly or one-way decision, have independent reviewers try to break the plan, then judge on evidence.",
    body: [
      "Use before something hard to undo (money, sending, deleting, a big plan) or when the user asks \"are we sure?\".",
      "1. State the plan or claim and what it must achieve in one paragraph.",
      "2. Get two or three independent views: subagent discuss with specialists, or separate subagents given the same paragraph and sources, each told to find what is wrong, missing or risky, with evidence.",
      "3. Don't count votes. Check each objection against the facts; keep a strong objection even if only one reviewer raised it, and drop agreement that has no evidence.",
      "4. Tell the user what to fix, what to decide, and what you dismissed and why."
    ].join("\n")
  },
  {
    name: "sharpen",
    description: "Before a vague or large task, work out the real goal, how an expert would do it, and what is over- or underspecified, then do the work.",
    body: [
      "Before starting a vague or large task, answer for yourself:",
      "1. How would a top expert do this? Their sources, their method, and how they would know the result is right.",
      "2. What is the user really after? The goal behind the words.",
      "3. Is it over- or underspecified? Drop constraints that don't serve the goal; leave choices that are the user's for the user. Ask one question only if the answer changes the work.",
      "Fold in only what makes the work better, not bigger. Keep one outside check that the result is right. Then do the work; don't show the user this framing."
    ].join("\n")
  },
  {
    name: "prove-it",
    description: "Before saying something is done or true, check it on the real thing, and check delegated work through what it produced.",
    body: [
      "Before you tell the user something is done, fixed, booked, sent or true:",
      "1. Check the real thing the claim is about: open the page, read the file, look at the diff, find the confirmation. A worker saying it worked is not proof.",
      "2. Check where the claim lives. \"The site is up\" means loading the site, not seeing that the upload finished.",
      "3. Say how you know: checked it yourself, read it in a source (link), or only inferred. Say what you did not check.",
      "4. When a check fails, first suspect the check, then the work. Fix and check again on the same path.",
      "5. Stop checking once the claim is proven."
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

export async function seed(setup: Setup, skills: Skills, specialists: Specialists, automations: Automations): Promise<void> {
  for (const skill of [MAKE_AVATAR, MAKE_SKILL]) {
    if (!skills.get(skill.name)) skills.apply({ action: "create", ...skill }, "ky");
  }

  for (const skill of DEFAULT_SKILLS) {
    if (skills.get(skill.name)) continue;
    skills.apply({ action: "create", ...skill }, "ky");
    skills.apply({ action: "pin", name: skill.name }, "ky");
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
