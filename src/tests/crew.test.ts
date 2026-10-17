import { describe, expect, it } from "vitest";
import type { TaskRow } from "../protocol";
import { gazeOf } from "../ui/Crew";
import { crewOf } from "../ui/crew-of";

const task = (worker: string, status: TaskRow["status"], times: { started: number; finished?: number }, chat: string | null = "1"): TaskRow => ({
  id: `${worker}-${times.started}`,
  kind: "cloud",
  source: "chat",
  worker,
  title: "x",
  status,
  summary: "",
  steps: [],
  session: null,
  agent: null,
  chat,
  created_at: times.started,
  updated_at: times.finished ?? times.started,
  started_at: times.started,
  finished_at: times.finished ?? null,
  turns: null,
  cost_usd: null
});

const faces = (tasks: TaskRow[], members: string[] = []) => crewOf(tasks, "1", members).faces.map((face) => `${face.id}:${face.state}`);

/** The specialists the agent pill sits beside ky while they work for the open chat. */
describe("a chat's crew", () => {
  it("is the specialists working for this chat, and only this chat", () => {
    const crew = crewOf([task("@chef", "working", { started: 10 }), task("@critic", "working", { started: 10 }, "7")], "1", []);

    expect(crew.faces).toEqual([{ id: "chef", state: "working" }]);
    expect(crew.line).toBe("@chef answering");
  });

  it("seats a group chat's other members to watch, and counts who of them answers", () => {
    const crew = crewOf([task("@chef", "working", { started: 10 })], "1", ["chef", "critic", "nutritionist"]);

    expect(crew.faces.map((face) => `${face.id}:${face.state}`)).toEqual(["chef:working", "critic:idle", "nutritionist:idle"]);
    expect([crew.working, crew.members]).toEqual([1, 3]);
  });

  it("keeps who finished while others still work, drooping one that failed", () => {
    const tasks = [task("@chef", "working", { started: 10 }), task("@critic", "failed", { started: 11, finished: 20 }), task("@baker", "done", { started: 12, finished: 21 })];

    expect(faces(tasks)).toEqual(["chef:working", "critic:failed", "baker:idle"]);
  });

  it("leaves out what finished before this stretch of work began", () => {
    expect(faces([task("@chef", "working", { started: 50 }), task("@critic", "failed", { started: 1, finished: 5 })])).toEqual(["chef:working"]);
  });

  it("splits a discussion into its specialists, and leaves out subagents, machines and consults", () => {
    const machine = { ...task("webmac", "working", { started: 10 }), kind: "machine" as const };
    const tasks = [task("@a, @b", "working", { started: 10 }), task("helper", "working", { started: 10 }), machine, task("@a → @c", "working", { started: 10 }, null)];

    expect(faces(tasks)).toEqual(["a:working", "b:working"]);
    expect(crewOf(tasks, "1", []).line).toBe("@a, @b answering");
  });

  it("is nobody at work once the stretch ends, with its last states kept for the landing", () => {
    const crew = crewOf([task("@chef", "done", { started: 10, finished: 30 }), task("@critic", "failed", { started: 12, finished: 25 })], "1", []);

    expect(crew.working).toBe(0);
    expect(crew.line).toBeNull();
    expect(crew.faces).toEqual([
      { id: "chef", state: "idle" },
      { id: "critic", state: "failed" }
    ]);
  });

  it("names two in its line, then counts the rest", () => {
    const tasks = ["@a", "@b", "@c", "@d"].map((worker) => task(worker, "working", { started: 10 }));

    expect(crewOf(tasks, "1", []).line).toBe("@a, @b +2 answering");
  });
});

describe("where a face looks", () => {
  it("is toward whoever the row watches, and its own way for the one watched", () => {
    expect(gazeOf(0, 2)?.[0]).toBeGreaterThan(0);
    expect(gazeOf(3, 2)?.[0]).toBeLessThan(0);
    expect(gazeOf(2, 2)).toBeNull();
  });
});
