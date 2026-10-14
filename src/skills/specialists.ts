import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  defineExtension,
  defineTask,
  defineTool,
  type Extension,
  GenerationTask,
  hook,
  type TaskId,
  ToolTask,
  type Tx
} from "@earendil-works/pi-durable";
import { Versioned, versionLine } from "../dreaming/soul";
import { summarize, type TaskFeed } from "../automations/tasks";
import { must } from "../core/must";
import {
  type SessionKind,
  type SpecialistAction,
  type SpecialistDraft,
  SpecialistInput,
  SpecialistSession,
  SpecialistStored,
  type SpecialistRow,
  type SpecialistView,
  specialistOf,
  TABLES,
  textOf,
  TOOLS
} from "./contract";
import { rows } from "./rows";

/**
 * Specialists: standing bots the user sets up, like @engineer or @researcher.
 * Each is a subagent with a name you can @, a brief (its persona and standing
 * instructions, versioned like SOUL.md), an optional model and an optional
 * preferred machine. It gets better through its brief and the skills.
 *
 * A specialist has one home conversation, shared by the main chat and the
 * side chats, so it keeps its history across asks. When a peer consults it,
 * or it joins a discussion, it answers in a fresh conversation instead: the
 * same brief and tools, so it is never steered off its own work, and what
 * it may do there follows from the conversation alone (see `rules`).
 *
 * When the user talks to it in a chat, with a leading @id or in a group chat
 * (src/peers/group.ts), it answers in its seat for that chat: a conversation of
 * its own per chat, whose answers are posted to the chat as its own
 * messages. A seat cannot ask other specialists, so no reply leads to another.
 *
 * Specialists never write memory; they may search it.
 */

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ID_CHARS = 32;

const DESCRIPTION_CHARS = 200;

/** Asks a specialist may make in one turn of its home conversation. */
const ASK_CAP = 3;

export const DISCUSS_MIN = 2;

export const DISCUSS_MAX = 4;

/** Each answer in a discussion's transcript is cut to this. */
const ANSWER_CHARS = 3_000;

/** Tools that write memory: specialists read it only. */
const MEMORY_WRITES = new Set(["memory_note", "memory_forget"]);

/** Each specialist, and every conversation one answers in: its home, or a consult. */
const CREATE = [
  `CREATE TABLE IF NOT EXISTS ${TABLES.specialists} (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    model TEXT,
    machine TEXT,
    session TEXT,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${TABLES.specialistSessions} (
    session TEXT PRIMARY KEY,
    specialist TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL)`
];

export class Specialists {
  readonly #sql: SqlStorage;
  readonly #briefs = new Map<string, Versioned>();
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;

    for (const table of CREATE) sql.exec(table);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  list(): SpecialistRow[] {
    return rows(this.#sql.exec(`SELECT * FROM ${TABLES.specialists} ORDER BY id`), SpecialistStored, "a stored specialist").map(specialistOf);
  }

  get(id: string): SpecialistRow | undefined {
    const row = rows(this.#sql.exec(`SELECT * FROM ${TABLES.specialists} WHERE id = ?`, id), SpecialistStored, "a stored specialist")[0];

    return row && specialistOf(row);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  views(): SpecialistView[] {
    return this.list().map((row) => ({ ...row, brief: this.brief(row.id).view() }));
  }

  /** A specialist's brief, versioned like SOUL.md. */
  brief(id: string): Versioned {
    let brief = this.#briefs.get(id);

    if (!brief) {
      brief = new Versioned(this.#sql, `specialist:${id}`, `@${id}'s brief`);
      brief.onChange(() => this.#emit());
      this.#briefs.set(id, brief);
    }

    return brief;
  }

  create(id: string, draft: SpecialistDraft, actor: string, conversation: string | null = null): string {
    if (!ID.test(id) || id.length > ID_CHARS) {
      throw new Error(`A specialist's id is lowercase-with-hyphens, at most ${ID_CHARS} characters, like engineer.`);
    }

    if (this.has(id)) throw new Error(`@${id} already exists.`);

    if (draft.brief === undefined) throw new Error("A new specialist needs a brief.");
    const description = this.#description(draft.description);
    this.brief(id).apply({ action: "edit", body: draft.brief }, actor, conversation);
    this.#sql.exec(
      `INSERT INTO ${TABLES.specialists} (id, description, model, machine, session, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
      id,
      description,
      draft.model ? JSON.stringify(draft.model) : null,
      draft.machine || null,
      Date.now()
    );
    this.#emit();

    return `Created @${id}.`;
  }

  /** Change a specialist's description, model or machine; its brief changes through brief(). */
  set(id: string, draft: SpecialistDraft): string {
    const row = this.#need(id);
    this.#sql.exec(
      `UPDATE ${TABLES.specialists} SET description = ?, model = ?, machine = ? WHERE id = ?`,
      draft.description === undefined ? row.description : this.#description(draft.description),
      draft.model === undefined ? (row.model && JSON.stringify(row.model)) : draft.model && JSON.stringify(draft.model),
      draft.machine === undefined ? row.machine : draft.machine || null,
      id
    );
    this.#emit();

    return `Saved @${id}.`;
  }

  /** Record a conversation as one of `id`'s; a home one becomes its shared conversation. */
  attach(session: string, id: string, kind: SessionKind): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO ${TABLES.specialistSessions} (session, specialist, kind, created_at) VALUES (?, ?, ?, ?)`,
      session,
      id,
      kind,
      Date.now()
    );

    if (kind === "home") {
      this.#sql.exec(`UPDATE ${TABLES.specialists} SET session = ? WHERE id = ?`, session, id);
      this.#emit();
    }
  }

  /** The specialist a conversation belongs to, and how it is used. */
  bySession(session: string): { specialist: SpecialistRow; kind: SessionKind } | undefined {
    const found = rows(
      this.#sql.exec(`SELECT specialist, kind FROM ${TABLES.specialistSessions} WHERE session = ?`, session),
      SpecialistSession,
      "a specialist's conversation"
    )[0];

    const specialist = found && this.get(found.specialist);

    return specialist && { specialist, kind: found.kind };
  }

  #need(id: string): SpecialistRow {
    const row = this.get(id);

    if (!row) throw new Error(`No specialist @${id}.`);

    return row;
  }

  #description(text: string | undefined): string {
    const line = (text ?? "").trim();

    if (line === "" || line.includes("\n") || line.length > DESCRIPTION_CHARS) {
      throw new Error(`A specialist's description is one line under ${DESCRIPTION_CHARS} characters.`);
    }

    return line;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

const roster = (specialists: readonly SpecialistRow[], except?: string) =>
  specialists.flatMap((each) => (each.id === except ? [] : [`- @${each.id}: ${each.description}`])).join("\n");

const ROSTER_RULES = `Specialists are standing bots the user set up, each with its own brief and model; they share your skills and tools and can search your memory but never write it. Delegate to one with subagent ask when the work is in its line. A specialist keeps one conversation across asks, so it remembers earlier work you gave it, but it does not see this chat: give it the context it needs.
The user talks to specialists in this chat directly: a message that starts with @id, or one a group chat's specialists took up, goes to them, and each posts its own reply here, shown as [@id replied to the user]. Those were answered already: do not answer them again or repeat what a specialist said, but use them as context. A question for you that wants several views is subagent discuss with those specialists. When a discussion comes back, give the user where they agree, where they disagree, and your recommendation.`;

/** In every chat, even with no specialists yet, so ky knows it can make them. */
const MANAGE_RULES = `You create and manage specialists yourself with the specialist tool: their id, description, machine and brief. Create one when the user asks, and offer one when the user keeps giving you the same kind of work. Improve a brief when a specialist's answers show a standing instruction is missing or wrong. Every brief change is versioned and can be reverted; tell the user what you changed.`;

/** The specialist's own section: who it is, its brief, and what it may do in this conversation. */
function own(specialists: Specialists, id: string, kind: SessionKind): string {
  const row = must(specialists.get(id), `No specialist @${id}.`);
  const peers = roster(specialists.list(), id);

  const how: Record<SessionKind, string> = {
    home:
      `Your answer goes back to whoever asked you, usually ky. You may consult another specialist with subagent ask (at most ${ASK_CAP} per task); their answer comes back to you as a message.`,
    consult:
      "Another specialist is consulting you. Answer them directly and completely; you cannot ask other specialists.",
    discuss:
      "You are in a discussion with other specialists. You have no tools here: reason from your brief and what you know, and be concise.",
    group:
      "The user is talking to you in one of their chats, with ky and maybe other specialists there. Your reply is posted to the chat as your own message, to the user directly. Other specialists may answer the same message; you do not see their replies and cannot ask them. Answer only what is in your line, concisely."
  };

  return [
    `You are @${id}, one of the user's specialists, working for ky, the user's main agent. ${row.description}`,
    `<brief>\n${specialists.brief(id).current().body.trim()}\n</brief>`,
    "Your brief is your standing instructions; the user or ky may refine it.",
    how[kind],
    "You can search the user's memory with memory_recall and memory_zoom, but you never write it: put anything worth keeping in your answer.",
    row.machine ? `For work on a machine, use ${row.machine} unless told otherwise.` : "",
    peers && (kind === "home" || kind === "consult") ? `Other specialists:\n${peers}` : ""
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

type DiscussInput = {
  readonly topic: string;
  readonly ids: readonly string[];
  readonly sessions: readonly ConversationId[];
  readonly rounds: 1 | 2;
  readonly feedId: string;
};

type DiscussState =
  | { phase: "round"; round: number; answers: string[][] }
  | { phase: "report"; report?: string };

/** A new discussion: one fresh conversation per specialist, set up by `prepare`. */
export type DiscussRequest = { topic: string; ids: readonly string[]; rounds: 1 | 2; feedId: string };

export type Specialist = {
  /** Sections and rules for every conversation, and the discussion task. */
  extension: Extension;
  /** The specialist tool, for the main chat and side chats. */
  manage: Extension;
  /** Start a discussion inside a commit on `owner`, the conversation the result is reported to. */
  discuss: (tx: Tx, owner: ConversationId, request: DiscussRequest, prepare: (tx: Tx, id: string) => Promise<ConversationId>) => Promise<TaskId>;
};

const cut = (text: string) => (text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS - 1)}…` : text);

const background = (conversationId: ConversationId) =>
  ({ ownership: { kind: "conversation" }, conversationId, background: true }) as const;

/** The transcript so far, one `### @id` heading per answer. */
function transcript(ids: readonly string[], answers: readonly string[][]): string {
  return answers
    .map((round, index) => [`## Round ${index + 1}`, ...round.map((answer, at) => `### @${ids[at]}\n${answer}`)].join("\n\n"))
    .join("\n\n");
}

function roundPrompt(input: DiscussInput, at: number, round: number, answers: readonly string[][]): string {
  const others = input.ids.filter((_, index) => index !== at).map((id) => `@${id}`).join(", ");

  if (round === 0) {
    return `A discussion with ${others}. Topic:\n\n${input.topic}\n\nGive your view as @${input.ids[at]}, from your specialty, in at most 200 words. Say where you are unsure.`;
  }

  const peers = (answers[round - 1] ?? [])
    .map((answer, index) => (index === at ? "" : `### @${input.ids[index]}\n${answer}`))
    .filter((part) => part !== "")
    .join("\n\n");

  return `Round ${round + 1}. The others answered:\n\n${peers}\n\nReply in at most 150 words: where you agree, where you disagree and why, and what you would change in your view.`;
}

export function specialistExtension(
  specialists: Specialists,
  feed: TaskFeed,
  /** The main chat and side chats: they see the roster and may manage specialists. */
  chat: (session: string) => boolean,
  /** Whether a task's work is still wanted; checked before each round and before the report. */
  wanted: (feedId: string) => boolean
): Specialist {
  /** Asks in each home conversation's current turn. In memory: an eviction only resets the count. */
  const asks = new Map<string, number>();

  const Discuss = defineTask<DiscussInput, DiscussState, null>({
    name: "ky.discuss",
    version: 1,
    initial: () => ({ phase: "round", round: 0, answers: [] }),
    phases: {
      round: async (task, runtime, context) => {
        const { input } = task;
        const { round, answers } = task.state.checkpoint;

        if (!wanted(input.feedId)) {
          feed.update(input.feedId, { status: "stopped", summary: "Stopped" });

          return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        }

        feed.step(input.feedId, `Round ${round + 1}`);

        const settled = await Promise.all(
          input.sessions.map(async (session, at) => {
            const conversation = must(await runtime.conversation(session, context), "A discussion's conversation is gone.");

            const submission = await conversation.submit(
              {
                type: "input",
                content: roundPrompt(input, at, round, answers),
                whenBusy: "followUp",
                requestId: `discuss:${task.id}:${round}`
              },
              context
            );

            return submission.wait(context);
          })
        );

        return runtime.commit(async (tx) => {
          const said = await Promise.all(
            settled.map(async (each) => {
              if (each.status === "unanswered") return `(no answer: ${each.reason})`;

              if (each.type !== "input") return "(no answer)";
              // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
              const message = (await tx.entry(AssistantEntry, each.answer))?.model?.[0] as AssistantMessage | undefined;

              return cut(textOf(message).trim() || "(no answer)");
            })
          );

          const next = [...answers, said];

          if (next.length < input.rounds) {
            return { status: "running", checkpoint: { phase: "round", round: round + 1, answers: next } } as const;
          }

          const body = transcript(input.ids, next);
          feed.update(input.feedId, { status: "done", summary: `${input.ids.length} views, ${next.length} rounds` });
          feed.describe(input.feedId, body);

          const who = input.ids.map((id) => `@${id}`).join(", ");

          return {
            status: "running",
            checkpoint: {
              phase: "report",
              report: `[discussion ${who} result: tell the user where they agree, where they disagree, and your recommendation]\n\nTopic: ${input.topic}\n\n${body}`
            }
          } as const;
        }, context);
      },
      report: async (task, runtime, context) => {
        const { report } = task.state.checkpoint;

        if (report !== undefined && wanted(task.input.feedId)) {
          const owner = must(await runtime.conversation(runtime.conversationId, context), "A discussion's owner is gone.");
          await owner.submit(
            { type: "input", content: report, whenBusy: "steer", requestId: `discuss-report:${task.id}` },
            context
          );
        }

        return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      }
    },
    abort: (task, runtime, context) => {
      feed.update(task.input.feedId, { status: "stopped" });

      return runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    }
  });

  const extension = defineExtension({
    name: "specialists",
    tasks: [Discuss],
    sections: [
      {
        key: "specialist",
        // Read fresh each request, so a brief edit shows on the specialist's next turn.
        render: (input) => {
          const found = specialists.bySession(String(input.conversationId));

          return found && own(specialists, found.specialist.id, found.kind);
        },
        tag: false
      },
      {
        key: "specialists",
        render: (input) => {
          const all = specialists.list();

          if (!chat(String(input.conversationId))) return undefined;

          return all.length === 0 ? `${MANAGE_RULES}\n\nThere are no specialists yet.` : `${ROSTER_RULES}\n${MANAGE_RULES}\n\nSpecialists:\n${roster(all)}`;
        },
        tag: false
      }
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          const session = String(api.conversationId);
          const found = specialists.bySession(session);

          if (!found) return undefined;

          if (found.kind === "discuss") return { block: "No tools in a discussion: reason from your brief and what you know." };

          if (MEMORY_WRITES.has(call.name)) return { block: "Specialists search memory but never write it: put it in your answer." };

          if (call.name !== "subagent") return undefined;

          if (found.kind === "group") return { block: "In a chat you answer the user yourself; you cannot ask or start other agents here." };

          if (found.kind === "consult") return { block: "You are being consulted: answer directly, without asking others." };

          if (call.arguments.action !== "ask") return { block: "Specialists may only ask another specialist (subagent ask)." };
          const count = asks.get(session) ?? 0;

          if (count >= ASK_CAP) return { block: `You have asked ${ASK_CAP} specialists this task; answer with what you have.` };
          asks.set(session, count + 1);

          return undefined;
        }
      }),
      hook(GenerationTask, {
        onYield: (_answer, api) => {
          asks.delete(String(api.conversationId));

          return undefined;
        }
      })
    ]
  });

  const manage = defineExtension({
    name: "specialist-manage",
    tools: [
      defineTool({
        name: TOOLS.specialist,
        description:
          "Create and change the user's specialists: standing bots, each with an id you @, a one-line description, and a brief " +
          "(its persona and standing instructions). Every brief change is kept as a version. Actions: list; view (id); history (id); " +
          "create (id, description, brief; machine optional); set (id; description and/or machine); " +
          "edit (id, brief: replaces it); patch (id, old, new: replace one exact passage of the brief); revert (id, version). " +
          "Change a brief when the user asks, or when a specialist's answers show a standing instruction is missing or wrong; tell the user what changed.",
        parameters: SpecialistInput,
        replay: "unsafe",
        execute: async (input, api) => reply(MANAGE[input.action](specialists, input, String(api.conversationId)))
      })
    ]
  });

  const discuss: Specialist["discuss"] = async (tx, owner, { topic, ids, rounds, feedId }, prepare) => {
    const sessions: ConversationId[] = [];

    for (const id of ids) sessions.push(await prepare(tx, id));

    return tx.createTask(Discuss, { topic, ids, sessions, rounds, feedId }, background(owner));
  };

  return { extension, manage, discuss };
}

/** One line for a task card from a discussion's topic. */
export const discussionTitle = (topic: string) => summarize(`Discuss: ${topic}`).slice(0, 60);

/** One specialist tool action, by the agent in `conversation`; returns what happened. */
type Manage = (specialists: Specialists, input: SpecialistInput, conversation: string) => string;

/** An action on one specialist: refused without an id, or for an id that isn't one (but create). */
const one =
  (act: (specialists: Specialists, id: string, input: SpecialistInput, conversation: string, row: SpecialistRow) => string, create = false): Manage =>
  (specialists, input, conversation) => {
    const { action, id } = input;

    if (id === undefined) return `${action} needs an id.`;

    if (create) return act(specialists, id, input, conversation, NO_ROW);
    const row = specialists.get(id);

    return row ? act(specialists, id, input, conversation, row) : `No specialist @${id}.`;
  };

/** create's stand-in for the row it doesn't have yet. */
const NO_ROW: SpecialistRow = { id: "", description: "", model: null, machine: null, session: null, created_at: 0 };

/** One handler per action: the record's type makes it exhaustive, so no action falls through to another. */
export const MANAGE: Readonly<Record<SpecialistAction, Manage>> = {
  list: (specialists) => roster(specialists.list()) || "No specialists yet.",
  create: one(
    (specialists, id, { description, brief, machine }, conversation) => specialists.create(id, { description, brief, machine }, "agent", conversation),
    true
  ),
  view: one(
    (specialists, id, _input, _conversation, row) =>
      `@${id}: ${row.description}${row.machine ? `\nmachine: ${row.machine}` : ""}\n\n${specialists.brief(id).current().body}`
  ),
  history: one((specialists, id) => specialists.brief(id).history().map(versionLine).join("\n")),
  set: one((specialists, id, { description, machine }) => specialists.set(id, { description, machine })),
  edit: one((specialists, id, { brief }, conversation) => specialists.brief(id).apply({ action: "edit", body: brief }, "agent", conversation)),
  patch: one((specialists, id, input, conversation) =>
    specialists.brief(id).apply({ action: "patch", old: input.old, new: input.new }, "agent", conversation)
  ),
  revert: one((specialists, id, { version }, conversation) =>
    specialists.brief(id).apply({ action: "revert", version }, "agent", conversation)
  )
};
