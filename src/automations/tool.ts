import { defineExtension, defineTool, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { toolReply as reply } from "../core/reply";
import { isRefusal } from "../core/refusal";
import { parseModel } from "../providers/contract";
import type { ModelChoice } from "../settings/contract";
import { KY } from "../skills/contract";
import {
  AUTOMATION_TOOL,
  type AutomationDraft,
  type AutomationRow,
  AutomationToolInput,
  type AutomationToolArgs,
  type AutomationView,
  type AutomationAction,
  CHECK_IN_TOOLS,
  EXTENSIONS,
  type ToolAction
} from "./contract";
import type { Automations } from "./wiring";

const CHECK_IN_ALLOWED: ReadonlySet<string> = new Set(CHECK_IN_TOOLS);

const GATE_PREVIEW_MAX = 500;

type Args = AutomationToolArgs;

function modelArg(args: Args, base: ModelChoice): ModelChoice | null | undefined {
  if (args.model === "worker") return null;

  if (args.model === undefined) return args.thinking === undefined ? undefined : { ...base, thinkingLevel: args.thinking };

  return parseModel(args.model, args.thinking ?? base.thinkingLevel);
}

function patchOf(args: Args, fallback: ModelChoice): Partial<AutomationDraft> {
  const patch: Partial<AutomationDraft> = {
    title: args.title,
    prompt: args.prompt,
    cron: args.cron,
    at: args.at === undefined ? undefined : Date.parse(args.at),
    model: modelArg(args, fallback),
    machine: args.machine === "cloud" ? null : args.machine,
    chat: args.chat === "main" ? ROOT_SESSION : args.chat,
    gate: args.gate === "none" || args.gate?.trim() === "" ? null : args.gate,
    post: args.post
  };

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

const runsAs = (owner: string) => (owner === KY ? "" : `, runs as @${owner}`);

const whose = (owner: string) => (owner === KY ? "ky's" : `@${owner}'s`);

/** Whose a new one is: the specialist's that asks, or ky's, or the specialist ky names for the user. */
function ownerOf(args: Args, by: string): { readonly owner: string } | { readonly refused: string } {
  const named = args.owner?.trim().replace(/^@/, "") || by;

  return by === KY || named === by ? { owner: named } : { refused: `You make automations for yourself only, @${by}.` };
}

async function create(automations: Automations, args: Args, call: Call): Promise<string> {
  const { fallback, caller, dream, by } = call;

  if (!args.title || !args.prompt) return "create needs a title and a prompt.";
  const chosen = ownerOf(args, by);

  if ("refused" in chosen) return chosen.refused;
  const { owner } = chosen;
  // A specialist answers in a conversation of its own, no chat the user has: its reports go to main unless it names a chat.
  const unset = { cron: null, at: null, model: null, machine: null, chat: by === KY ? caller : ROOT_SESSION, gate: null, owner };
  const asked = { ...unset, ...patchOf(args, fallback), title: args.title, prompt: args.prompt };
  const draft = dream ? { ...asked, model: null, machine: null, chat: ROOT_SESSION, post: false } : asked;
  const created = await automations.create(draft, dream ? "dream" : (args.createdBy ?? "user"));

  if (isRefusal(created)) return created.refused;

  return `Created automation ${created.id}, "${created.title}" (${scheduleOf(created, automations.checkIns().zone)}).${await gateTest(automations, created.gate)}`;
}

async function gateTest(automations: Automations, gate: string | null): Promise<string> {
  if (gate === null) return "";
  const check = await automations.checkGate(gate);

  if (check.kind === "nothing") return `\nGate test: returned nothing (${check.returned}), so a fire now would be skipped.`;

  if (check.kind === "error") return `\nGate test failed: ${check.text}. Fix it with update; three failed fires in a row pause it.`;
  const found = check.items === undefined ? "found something" : `found ${check.items} item${check.items === 1 ? "" : "s"}`;
  const preview = check.text.length > GATE_PREVIEW_MAX ? `${check.text.slice(0, GATE_PREVIEW_MAX)}… (${check.text.length} characters in all)` : check.text;

  return `\nGate test: ${found}, so a fire now would run with it before its prompt:\n${preview}`;
}

function scheduleOf(row: Pick<AutomationRow, "cron" | "at">, zone: string | null): string {
  return row.cron === null ? `once at ${new Date(row.at ?? 0).toISOString()}` : `cron ${row.cron} ${zone ?? "UTC"}`;
}

function lineOf(automations: Automations, view: AutomationView): string {
  const model = view.model ? `${view.model.provider}/${view.model.modelId} ${view.model.thinkingLevel}` : "worker model";
  const next = view.next_run === null ? "none" : new Date(view.next_run).toISOString();
  const last = view.last_run ? `${view.last_run.status}${view.last_run.summary ? `: ${view.last_run.summary}` : ""}` : "never";

  return [
    `${view.id} "${view.title}" [${view.status}] ${scheduleOf(view, view.zone)}, by ${view.created_by}${runsAs(view.owner)}`,
    `  model: ${model}; where: ${view.machine ?? "cloud"}; reports to: ${automations.chatLabel(view.chat)}${view.post ? ", posted as ky's message" : ""}`,
    `  next: ${next}; last run: ${last}`,
    ...(view.gate === null
      ? []
      : [`  gate: last check ${view.gate_checked_at === null ? "never" : `${new Date(view.gate_checked_at).toISOString()}, ${view.gate_note}`}`])
  ].join("\n");
}

async function list(automations: Automations, all: boolean, by: string): Promise<string> {
  const views = (await automations.list(all)).filter((view) => by === KY || view.owner === by);

  return views.length === 0 ? "No automations." : views.map((view) => lineOf(automations, view)).join("\n");
}

const BY_ID = {
  pause: (automations, id) => automations.pause(id),
  resume: (automations, id) => automations.resume(id),
  archive: (automations, id) => automations.archive(id),
  unarchive: (automations, id) => automations.unarchive(id),
  run: (automations, id) => automations.run(id),
  stop: (automations, id) => automations.stop(id),
  delete: (automations, id) => automations.delete(id)
} satisfies { readonly [Action in AutomationAction]: (automations: Automations, id: string) => Promise<string> | string };

type Call = {
  readonly action: ToolAction;
  readonly args: Args;
  readonly fallback: ModelChoice;
  readonly caller: string;
  readonly dream: boolean;
  /** Who is asking: "ky", or the specialist whose conversation it is. */
  readonly by: string;
};

/** Why `by` may not change automation `id`: a specialist changes only its own, and only the user moves one to another owner. */
function changeRefusal(automations: Automations, id: string, args: Args, by: string): string | undefined {
  if (args.owner !== undefined) return "Only the user moves an automation to another owner, in Settings.";
  const row = automations.get(id);

  return row === undefined || by === KY || row.owner === by ? undefined : `"${row.title}" is ${whose(row.owner)}; you may change only your own.`;
}

/** The automation `named` means: its id, or else the exact title of one `by` may change, so "@fin run monthly close" needs no list first. */
async function idOf(automations: Automations, named: string, by: string, action: ToolAction): Promise<{ readonly id: string } | { readonly refused: string }> {
  if (automations.get(named) !== undefined) return { id: named };
  const title = named.trim().toLowerCase();
  const archived = action === "unarchive";

  const matches = (await automations.list(true)).filter(
    (view) => (by === KY || view.owner === by) && view.title.toLowerCase() === title && (view.status === "archived") === archived
  );

  if (matches.length > 1) return { refused: `"${named}" names ${matches.length} automations; use its id (list shows them).` };

  return { id: matches[0]?.id ?? named };
}

async function dispatch(automations: Automations, call: Call): Promise<string> {
  const { action, args, fallback, dream, by } = call;

  if (action === "create") return create(automations, args, call);

  if (action === "list") return list(automations, args.all ?? false, by);

  if (dream) return "A dream may only create check-ins and list automations.";

  if (!args.id) return `${action} needs an id.`;
  const found = await idOf(automations, args.id, by, action);

  if ("refused" in found) return found.refused;
  const { id } = found;
  const refused = changeRefusal(automations, id, args, by);

  if (refused !== undefined) return refused;

  return action === "update" ? update(automations, id, args, fallback) : BY_ID[action](automations, id);
}

async function update(automations: Automations, id: string, args: Args, fallback: ModelChoice): Promise<string> {
  const patch = patchOf(args, automations.get(id)?.model ?? fallback);
  const updated = await automations.update(id, patch);

  if (isRefusal(updated)) return updated.refused;

  return `Updated "${updated.title}".${patch.gate === undefined ? "" : await gateTest(automations, updated.gate)}`;
}

export function automationExtension(
  automations: Automations,
  worker: () => ModelChoice,
  dreaming: (session: string) => boolean,
  /** Whose conversation `session` is: "ky", or a specialist's id (src/skills/profiles.ts). */
  whoseSession: (session: string) => string
): Extension {
  return defineExtension({
    name: EXTENSIONS.automations,
    tools: [
      defineTool({
        name: AUTOMATION_TOOL,
        description:
          "Schedule work to run later or on repeat, for the user or for yourself (to check back on something). " +
          "Each run is a fresh subagent, or a task on a machine, that knows only the prompt; its result is reported to this conversation, for you to pass on. " +
          "Crons are in the user's time zone (list shows it), so 9 AM is 0 9 * * *; they keep to it across daylight saving. " +
          "Actions: create (title, prompt, cron or at, model and thinking optional, machine optional, chat optional, createdBy: user when the user asked, ky when it is yours). " +
          "One a specialist creates is its own and runs as it, with its brief and its machines, and reports to main unless chat names another; ky makes one for a specialist with owner, only when the user asks for that. " +
          "Results go to this chat unless chat names another: main, or a side chat's session. " +
          "Every report goes to its chat in full, whether or not the user is around: a side chat archived by the time a run starts is brought back for it, and a deleted one's go to main. " +
          "A cloud run has the ui tool: a card it shows (a status, stats, a chart, facts, a table) is posted in its chat as ky's own, just before its report, once the run succeeds; " +
          "ask for one in the prompt when the report reads better as a card, like a daily forecast. It may ask the user something (a choice, buttons): their answer comes to you here as their next message. A machine run has none. " +
          "update (id, any of the create fields). list (all optional): each one's schedule, status, next and last run. " +
          "pause, resume, archive, unarchive, run, stop, delete (id): id may be the exact title instead, as in \"run monthly close\"; run fires it now, stop ends the run going and keeps the schedule; delete only when the user asks. " +
          "Pause or archive your own once they are no longer needed. " +
          "For \"tell me when X happens\" (new mail from someone, a PR review, a price), add a gate and a frequent cron like */15 * * * *: " +
          "the gate is an executor_execute program body run before each fire with no model, so a fire costs nothing until it finds something. " +
          "Return the matching items (a short list of what the run needs), or null when there are none. " +
          "Keep it narrow: only the window since the last fire (newer_than:15m for a 15-minute cron), only what the user cares about, read only. " +
          "Create and update test the gate once and tell you what it returned; fix it until that is what you meant. " +
          "Without a gate every fire runs.",
        parameters: AutomationToolInput,
        replay: "unsafe",
        execute: async (args, api) =>
          reply(
            await dispatch(automations, {
              action: args.action,
              args,
              fallback: worker(),
              caller: String(api.conversationId),
              dream: dreaming(String(api.conversationId)),
              by: whoseSession(String(api.conversationId))
            })
          )
      })
    ]
  });
}

export function checkInGuardExtension(automations: Automations): Extension {
  return defineExtension({
    name: EXTENSIONS.checkInGuard,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          if (CHECK_IN_ALLOWED.has(call.name) || !automations.checkInRun(String(api.conversationId))) return undefined;

          return { block: `A check-in may only call ${CHECK_IN_TOOLS.join(", ")}.` };
        }
      })
    ]
  });
}
