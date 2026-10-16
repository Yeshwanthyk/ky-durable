import type { TaskRow } from "../protocol";

/** One specialist in the topbar's crew, and what it is doing for this chat. */
export type CrewFace = {
  readonly id: string;
  readonly state: "working" | "idle" | "failed";
};

/**
 * The specialists of the open chat's latest stretch of work, sat beside ky in the agent pill: those
 * working, those that finished while they did, and the chat's other members watching. The pill shows
 * it while `working` is above 0, and a moment after. `members` is how many the chat has as a group
 * chat, for the "1/3" count; 0 in a chat with none.
 */
export type Crew = {
  readonly faces: readonly CrewFace[];
  readonly working: number;
  readonly members: number;
  /** The line under the name while they work: "@chef, @nutritionist answering". */
  readonly line: string | null;
};

export const NO_CREW: Crew = { faces: [], working: 0, members: 0, line: null };

/** Whether two crews draw the same: tasks change with every step, a crew seldom. */
export const sameCrew = (a: Crew, b: Crew) =>
  a.working === b.working &&
  a.members === b.members &&
  a.line === b.line &&
  a.faces.length === b.faces.length &&
  a.faces.every((face, index) => face.id === b.faces[index]?.id && face.state === b.faces[index]?.state);

const live = (task: TaskRow) => task.status === "working" || task.status === "queued";

/** The specialists a task is for: "@chef", or "@chef, @critic" for a discussion; none for a subagent or a machine. */
function idsOf(task: TaskRow): string[] {
  if (task.kind !== "cloud") return [];

  const names = task.worker.split(", ");

  return names.every((name) => /^@[a-z0-9-]+$/.test(name)) ? names.map((name) => name.slice(1)) : [];
}

function lineOf(ids: readonly string[]): string {
  const named = ids.map((id) => `@${id}`);

  return `${named.length > 2 ? `${named.slice(0, 2).join(", ")} +${named.length - 2}` : named.join(", ")} answering`;
}

const startOf = (task: TaskRow) => task.started_at ?? task.created_at;

/**
 * The crew of chat `session`, from the tasks: its specialists' newest task each, those in the latest
 * stretch of work (still going, or finished since it began), then the chat's other members. While
 * nothing works, the stretch is the one that ended last, so its answers can still be shown landing.
 */
export function crewOf(tasks: readonly TaskRow[], session: string, members: readonly string[]): Crew {
  const newest = new Map<string, TaskRow>();

  for (const task of tasks) {
    if (task.chat !== session) continue;

    for (const id of idsOf(task)) {
      const seen = newest.get(id);

      // A live task wins over a finished one, so a discussion still going isn't hidden by a newer ask that ended.
      if (seen === undefined || (!live(seen) && live(task))) newest.set(id, task);
    }
  }

  const all = [...newest];
  const going = all.flatMap(([, task]) => (live(task) ? [task] : []));
  const working = all.flatMap(([id, task]) => (live(task) ? [id] : []));
  const last = all.toSorted(([, a], [, b]) => (b.finished_at ?? 0) - (a.finished_at ?? 0))[0]?.[1];

  if (last === undefined) return { ...NO_CREW, members: members.length };

  const since = going.length > 0 ? Math.min(...going.map(startOf)) : startOf(last);
  const finished = all.flatMap(([id, task]) => (!live(task) && (task.finished_at ?? 0) >= since ? [id] : []));

  const stateOf = (id: string): CrewFace["state"] => {
    if (working.includes(id)) return "working";

    return finished.includes(id) && newest.get(id)?.status === "failed" ? "failed" : "idle";
  };

  return {
    faces: [...new Set([...working, ...finished, ...members])].map((id) => ({ id, state: stateOf(id) })),
    working: working.length,
    members: members.length,
    line: working.length > 0 ? lineOf(working) : null
  };
}
