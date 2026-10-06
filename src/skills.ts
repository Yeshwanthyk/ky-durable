import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  hook,
  ToolTask
} from "@earendil-works/pi-durable";
import { summarize, type TaskFeed } from "./tasks";

/**
 * Skills: the agent's procedural memory, after Hermes Agent's skills and
 * background review. OptMem holds who the user is and what happened; a
 * skill holds how to do one class of task for this user.
 *
 * Every conversation sees the index (name and one line each) and can open a
 * skill with `skill_view`. After a turn of the main chat or a side chat that
 * used at least `reviewAfter` tool calls, ky forks the conversation and asks
 * the fork to update the library. Writes apply at once, from the agent or a
 * review; every write keeps a version, so any change can be reverted.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DESCRIPTION_CHARS = 200;

const BODY_CHARS = 20_000;

/** A turn with at least this many tool calls is reviewed for skills. */
const REVIEW_AFTER = 5;

/** The tools a review may call; it is a fork, so it is offered all of them. */
const REVIEW_TOOLS = new Set(["skill_view", "skill_manage"]);

export type SkillStatus = "active" | "archived";

export type SkillRow = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly status: SkillStatus;
  readonly uses: number;
  readonly created_at: number;
  readonly updated_at: number;
};

export type SkillVersion = {
  readonly id: number;
  readonly name: string;
  readonly action: string;
  /** "agent", "review", or "user". */
  readonly actor: string;
  readonly description: string;
  readonly body: string;
  readonly status: SkillStatus;
  readonly created_at: number;
};

export type SkillChange =
  | { action: "create"; name: string; description: string; body: string }
  | { action: "edit"; name: string; description?: string; body?: string }
  | { action: "patch"; name: string; old: string; new: string }
  | { action: "archive" | "restore"; name: string }
  | { action: "revert"; name: string; version: number };

function checkName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`Bad skill name "${name}": lowercase letters, digits and hyphens, at most 64.`);
  }
}

function checkText(description: string, body: string): void {
  if (description.trim() === "") throw new Error("A skill needs a description.");

  if (description.length > DESCRIPTION_CHARS) {
    throw new Error(`The description is ${description.length} characters; keep it under ${DESCRIPTION_CHARS}.`);
  }

  if (body.length > BODY_CHARS) throw new Error(`The body is ${body.length} characters; keep it under ${BODY_CHARS}.`);
}

/** The skill library in the Durable Object's SQLite, with every version kept. */
export class Skills {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<() => void>();
  /** A turn with at least this many tool calls is reviewed. */
  reviewAfter = REVIEW_AFTER;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      uses INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_skill_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(name: string): SkillRow | undefined {
    return this.#sql.exec<SkillRow>("SELECT * FROM ky_skills WHERE name = ?", name).toArray()[0];
  }

  list(status: SkillStatus = "active"): SkillRow[] {
    return this.#sql.exec<SkillRow>("SELECT * FROM ky_skills WHERE status = ? ORDER BY name", status).toArray();
  }

  /** Every skill, active ones first, for the panel. */
  all(): SkillRow[] {
    return this.#sql.exec<SkillRow>("SELECT * FROM ky_skills ORDER BY status = 'archived', name").toArray();
  }

  history(name: string): SkillVersion[] {
    return this.#sql
      .exec<SkillVersion>("SELECT * FROM ky_skill_versions WHERE name = ? ORDER BY id DESC", name)
      .toArray();
  }

  /** The prompt's index: one line per active skill. */
  index(): string {
    return this.list()
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join("\n");
  }

  /** Open a skill for use, and count the use. */
  view(name: string): SkillRow {
    const skill = this.get(name);

    if (!skill) throw new Error(`No skill named ${name}.`);
    this.#sql.exec("UPDATE ky_skills SET uses = uses + 1 WHERE name = ?", name);

    return skill;
  }

  /** Apply one change and record the result as a new version; returns what happened. */
  apply(change: SkillChange, actor: string): string {
    checkName(change.name);
    const was = this.get(change.name);

    if (change.action === "create") {
      if (was) throw new Error(`${change.name} exists; edit or patch it.`);
      checkText(change.description, change.body);

      return this.#save(change.name, "create", actor, change.description, change.body, "active");
    }

    if (!was) throw new Error(`No skill named ${change.name}.`);

    switch (change.action) {
      case "edit": {
        const description = change.description ?? was.description;
        const body = change.body ?? was.body;
        checkText(description, body);

        return this.#save(change.name, "edit", actor, description, body, was.status);
      }

      case "patch": {
        const count = was.body.split(change.old).length - 1;

        if (change.old === "" || count === 0) throw new Error(`The text to replace is not in ${change.name}.`);

        if (count > 1) throw new Error(`The text to replace appears ${count} times in ${change.name}; quote more of it.`);
        const body = was.body.replace(change.old, () => change.new);
        checkText(was.description, body);

        return this.#save(change.name, "patch", actor, was.description, body, was.status);
      }

      case "archive":
      case "restore":
        return this.#save(
          change.name,
          change.action,
          actor,
          was.description,
          was.body,
          change.action === "archive" ? "archived" : "active"
        );

      case "revert": {
        const version = this.history(change.name).find((each) => each.id === change.version);

        if (!version) throw new Error(`${change.name} has no version ${change.version}.`);

        return this.#save(change.name, "revert", actor, version.description, version.body, version.status);
      }
    }
  }

  #save(name: string, action: string, actor: string, description: string, body: string, status: SkillStatus): string {
    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO ky_skills (name, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, body = excluded.body,
         status = excluded.status, updated_at = excluded.updated_at`,
      name,
      description,
      body,
      status,
      now,
      now
    );

    const { id } = this.#sql
      .exec<{ id: number }>(
        `INSERT INTO ky_skill_versions (name, action, actor, description, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        name,
        action,
        actor,
        description,
        body,
        status,
        now
      )
      .one();

    for (const listener of this.#listeners) listener();

    return `${action === "create" ? "Created" : `Saved ${action} of`} ${name} (version ${id}).`;
  }
}

/** The review conversations: forks of a turn, asked to update the library. */
class Reviews {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_skill_reviews (
      conversation TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  has(conversation: string): boolean {
    return this.#sql.exec("SELECT 1 FROM ky_skill_reviews WHERE conversation = ?", conversation).toArray().length > 0;
  }

  add(conversation: string, parent: string): void {
    this.#sql.exec(
      "INSERT INTO ky_skill_reviews (conversation, parent, created_at) VALUES (?, ?, ?)",
      conversation,
      parent,
      Date.now()
    );
  }
}

const PROMPT = `Skills are your procedures: how to do one class of task for this user, written by you from experience. The <skills> section lists them. Memory is who the user is and what happened; a skill is how to do something.

Before a task, check the list. When a skill fits, open it with skill_view and follow it. When it turned out wrong or missing a step, or the user corrects how you did that kind of task, fix it with skill_manage. When the user asks you to remember how to do something, that is a skill.

Machines cannot see your skills. When you hand a machine a task a skill covers, open the skill with skill_view, put its steps and pitfalls in the task, and steer the machine by it while it works.

After a busy turn, a review of the turn may update skills for you; you will see the changes in the list.`;

const REVIEW = `[skill review] Review the conversation above and update the skill library with skill_view and skill_manage. You may call only those two tools; do not continue the user's task and do not answer the user.

A skill is how to do one class of task for this user: steps, pitfalls, the user's preferences for that kind of work. Facts about the user and what happened belong to memory, which the main agent keeps; leave those out.

Signals that warrant a change:
- The user corrected your approach, sequence, style or format for this kind of task.
- A non-trivial technique, workaround, or tool-usage pattern worked and would help next time.
- A skill used in this conversation was wrong, missing a step, or outdated.
- The same kind of task has come up before (check the skill list and the conversation).

Prefer, in order: patch a skill used in this conversation; extend an existing skill that covers the class; create a new skill. Name skills by the class of task (like "weekly-grocery-order"), never by today's details. Read a skill with skill_view before you change it. Keep each skill short: a trigger line, steps, pitfalls.

If nothing is worth keeping, answer "Nothing to save." Otherwise answer with one line per change.`;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

/** Where a review runs and reports. */
export type ReviewHost = {
  readonly conversation: (session: string) => Promise<Conversation>;
  readonly feed: TaskFeed;
  /** Run work in the background of the current request, like `ctx.waitUntil`. */
  readonly later: (work: Promise<void>) => void;
  readonly context: Context;
};

/** The skills extension, for every conversation; only `reviewable` ones are reviewed after a turn. */
export function skillsExtension(
  skills: Skills,
  sql: SqlStorage,
  host: ReviewHost,
  /** Whether a conversation's turns are reviewed: the main chat and side chats. */
  reviewable: (session: string) => boolean
): Extension {
  const reviews = new Reviews(sql);
  /** Tool calls in each conversation's current turn. In memory: an eviction only skips a review. */
  const calls = new Map<string, number>();
  /** Conversations whose review is running, so a quick next turn does not start another. */
  const reviewing = new Set<string>();

  const actor = (conversation: string) => (reviews.has(conversation) ? "review" : "agent");

  async function review(session: string): Promise<void> {
    const { context, feed } = host;
    const id = crypto.randomUUID();
    reviewing.add(session);

    try {
      const conversation = await host.conversation(session);
      await conversation.waitForIdle(context);
      const latest = (await conversation.entries({}, 1, undefined, context)).items[0];

      if (!latest) return;
      // The fork keeps the parent's agent, so its requests share the parent's prompt cache.
      const fork = await conversation.fork(latest.id, { ownership: { kind: "ownerless" } }, context);
      reviews.add(String(fork.id), session);
      feed.create({ id, kind: "cloud", worker: "skills", title: "Skill review", status: "working", session: String(fork.id) });

      const submission = await fork.submit(
        { type: "input", content: REVIEW, requestId: `skill-review:${id}` },
        context
      );

      const settled = await submission.wait(context);

      if (settled.status === "unanswered") {
        feed.update(id, { status: "failed", summary: `Failed: ${settled.reason}` });

        return;
      }

      const answer =
        settled.type === "input"
          ? await fork.commit(
              // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
              async (tx) => (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined,
              context
            )
          : undefined;

      feed.update(id, { status: "done", summary: summarize(textOf(answer)) || "Done" });
    } catch (error) {
      console.warn("skill review failed", error);
      feed.update(id, { status: "failed", summary: summarize(String(error)) });
    } finally {
      reviewing.delete(session);
    }
  }

  return defineExtension({
    name: "skills",
    sections: [
      { key: "skills-rules", render: () => PROMPT, tag: false },
      // Re-rendered each request: pi places a changed section after the context, so a new skill shows at once.
      { key: "skills", render: () => skills.index() || "No skills yet." }
    ],
    hooks: [
      hook(GenerationTask, {
        afterTools: (_assistant, results, api) => {
          const conversation = String(api.conversationId);
          calls.set(conversation, (calls.get(conversation) ?? 0) + results.length);
        },
        onYield: (_answer, api) => {
          const conversation = String(api.conversationId);
          const count = calls.get(conversation) ?? 0;
          calls.delete(conversation);

          if (count >= skills.reviewAfter && reviewable(conversation) && !reviewing.has(conversation)) {
            host.later(review(conversation));
          }

          return undefined;
        }
      }),
      // A review is a fork, offered every tool its parent has; it may only touch skills.
      hook(ToolTask, {
        beforeTool: (call, api) =>
          reviews.has(String(api.conversationId)) && !REVIEW_TOOLS.has(call.name)
            ? { block: "A skill review may only call skill_view and skill_manage." }
            : undefined
      })
    ],
    tools: [
      defineTool({
        name: "skill_view",
        description: "Open a skill to follow it. history: true lists its versions instead, newest first.",
        parameters: Type.Object({
          name: Type.String(),
          history: Type.Optional(Type.Boolean())
        }),
        replay: "safe",
        execute: async ({ name, history }) => {
          if (history) {
            const versions = skills.history(name);

            return text(
              versions.length === 0
                ? `No skill named ${name}.`
                : versions
                    .map((each) => `v${each.id} ${new Date(each.created_at).toISOString()} ${each.action} by ${each.actor}`)
                    .join("\n")
            );
          }

          const skill = skills.view(name);

          return text(
            `# ${skill.name}${skill.status === "archived" ? " (archived)" : ""}\n${skill.description}\n\n${skill.body}`
          );
        }
      }),
      defineTool({
        name: "skill_manage",
        description:
          "Change the skill library; every change is kept as a version. Actions: " +
          "create (name, description, body); edit (name; description and/or body replace them); " +
          "patch (name, old, new: replace one exact passage of the body); archive (name); restore (name); " +
          "revert (name, version: back to that version's content, from skill_view history). " +
          `Names are lowercase-with-hyphens, by class of task. The description is one line under ${DESCRIPTION_CHARS} characters saying when to use it.`,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("create"),
            Type.Literal("edit"),
            Type.Literal("patch"),
            Type.Literal("archive"),
            Type.Literal("restore"),
            Type.Literal("revert")
          ]),
          name: Type.String(),
          description: Type.Optional(Type.String()),
          body: Type.Optional(Type.String()),
          old: Type.Optional(Type.String()),
          new: Type.Optional(Type.String()),
          version: Type.Optional(Type.Number())
        }),
        replay: "unsafe",
        execute: async (args, api) => {
          const { action, name } = args;
          let change: SkillChange;

          switch (action) {
            case "create":
              if (args.description === undefined || args.body === undefined) {
                return text("create needs a description and a body.");
              }

              change = { action, name, description: args.description, body: args.body };
              break;
            case "edit":
              change = { action, name, description: args.description, body: args.body };
              break;
            case "patch":
              if (args.old === undefined || args.new === undefined) return text("patch needs old and new.");
              change = { action, name, old: args.old, new: args.new };
              break;
            case "revert":
              if (args.version === undefined) return text("revert needs a version.");
              change = { action, name, version: args.version };
              break;
            default:
              change = { action, name };
          }

          return text(skills.apply(change, actor(String(api.conversationId))));
        }
      })
    ]
  });
}
