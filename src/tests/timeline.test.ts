import { describe, expect, it } from "vitest";
import type { TaskLogStep, TaskRow } from "../protocol";
import { endStep, pastTense, startStep, stepInput, stepSummary, stepTitle } from "../step-labels";
import type { PiMessage } from "../transcript";
import { taskTimeline, titleParts, turnTimeline } from "../ui/timeline-steps";

/** A task's steps read in plain words with the key result, as Muse shows them. */
describe("step titles", () => {
  it("say what a running tool is doing", () => {
    expect(stepTitle("read", { path: "gmail/CONNECTOR.md" }, "running")).toBe("Reading CONNECTOR.md");
    expect(stepTitle("executor_execute", { code: "return await tools.gmail.search({ q: 'card' })" }, "running")).toBe("Checking Gmail");
  });

  it("quote a command, cut to one row", () => {
    expect(stepTitle("Bash", { command: "pnpm test --run" }, "running")).toBe("Running `pnpm test --run`");
    expect(stepTitle("exec", { code: "const x = 1\nreturn x" }, "done")).toBe("Ran `const x = 1`");
    const long = stepTitle("Bash", { command: "x".repeat(80) }, "running");
    expect(long.endsWith("…`")).toBe(true);
    expect(long.length).toBeLessThan(70);
  });

  it("say what a done tool did, in the past tense", () => {
    expect(stepTitle("read", { path: "src/tasks.ts" }, "done", "a\nb")).toBe("Read tasks.ts");
    expect(stepTitle("write", { path: "notes.md" }, "done", "ok")).toBe("Wrote notes.md");
    expect(stepTitle("browse", { url: "https://www.github.com/x" }, "done", "<html>")).toBe("Browsed github.com");
    expect(stepTitle("memory_recall", {}, "done", "")).toBe("Recalled memory");
  });

  it("end on how many things a search or listing found", () => {
    expect(stepTitle("grep", { pattern: "TaskFeed" }, "done", "a.ts:1\nb.ts:2\n\nc.ts:9\n")).toBe("Searched files — 3 matches");
    expect(stepTitle("Grep", { pattern: "TaskFeed" }, "done", "Found 1 file\nsrc/a.ts")).toBe("Searched for TaskFeed — 1 match");
    expect(stepTitle("Glob", { pattern: "*.md" }, "done", "No files found")).toBe("Searched for *.md — 0 files");
    expect(stepTitle("ls", { path: "/" }, "done", "a\nb")).toBe("Listed files — 2 entries");
  });

  it("count a JSON list's results", () => {
    const code = "return await tools.gmail.search({ q: 'card' })";
    expect(stepTitle("executor_execute", { code }, "done", JSON.stringify({ messages: [{ subject: "Your order" }] }))).toBe(
      "Checked Gmail — 1 result"
    );
    expect(stepTitle("executor_execute", { code }, "done", "[1, 2]")).toBe("Checked Gmail — 2 results");
  });

  it("leave a failed tool's title without a result", () => {
    expect(stepTitle("grep", { pattern: "x" }, "failed", "a\nb")).toBe("Searched files");
  });

  it("keep unknown words as they are", () => {
    expect(pastTense("Delegating to researcher")).toBe("Delegated to researcher");
    expect(pastTense("multiply")).toBe("multiply");
  });
});

describe("step summaries", () => {
  it("are the first lines of what came back, on one line", () => {
    expect(stepSummary("Bash", "\n\u001b[32m✓ 12 tests passed\u001b[0m\nDone in 3s\nmore\n", true)).toBe("✓ 12 tests passed Done in 3s");
  });

  it("say why a tool failed", () => {
    expect(stepSummary("Bash", "\nError: ENOENT no such file\nat x", false)).toBe("Error: ENOENT no such file");
    expect(stepSummary("Bash", "", false)).toBe("Failed");
  });

  it("count a read file's lines", () => {
    expect(stepSummary("read", "a\nb\nc", true)).toBe("3 lines");
    expect(stepSummary("Read", "", true)).toBe("Empty");
  });

  it("read a JSON result's text values", () => {
    const output = JSON.stringify({ messages: [{ from: "Amazon.ca", subject: "Your card ending 1234", date: "Oct 14" }] });
    expect(stepSummary("executor_execute", output, true)).toBe("Amazon.ca · Your card ending 1234 · Oct 14");
  });

  it("fit in a line or two", () => {
    expect(stepSummary("Bash", "y".repeat(400), true).length).toBeLessThanOrEqual(160);
  });
});

describe("a step's raw call", () => {
  it("opens to the command or program it ran, else its arguments", () => {
    expect(stepInput("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(stepInput("executor_execute", { code: "return 1" })).toBe("return 1");
    expect(stepInput("read", { path: "a.ts" })).toBe('{\n  "path": "a.ts"\n}');
    expect(stepInput("status", {})).toBe("");
  });

  it("starts with a title and its input, and ends with what came back, cut to fit", () => {
    expect(startStep("Bash", { command: "pnpm build" })).toEqual({ text: "Running `pnpm build`", input: "pnpm build" });
    const end = endStep("Bash", { command: "pnpm build" }, `built\n${"z".repeat(5000)}\n\n`, true);
    expect(end).toMatchObject({ text: "Ran `pnpm build`", state: "done" });
    expect(end.detail.startsWith("built z")).toBe(true);
    expect(end.output.length).toBeLessThanOrEqual(4000);
    expect(endStep("Bash", { command: "false" }, "exit 1", false)).toMatchObject({ state: "failed", detail: "exit 1" });
  });
});

describe("titles in pieces", () => {
  it("split quoted commands out to show in mono", () => {
    expect(titleParts("Running `pnpm test` now")).toEqual([
      { text: "Running ", code: false },
      { text: "pnpm test", code: true },
      { text: " now", code: false }
    ]);
    expect(titleParts("Read a.ts")).toEqual([{ text: "Read a.ts", code: false }]);
  });
});

const task = (status: TaskRow["status"], steps: TaskRow["steps"] = []): TaskRow => ({
  id: "m-1",
  kind: "machine",
  source: "chat",
  worker: "mac",
  title: "Build it",
  status,
  summary: "",
  steps,
  session: null,
  agent: "claude",
  chat: null,
  created_at: 0,
  updated_at: 0,
  started_at: 0,
  finished_at: null,
  turns: null,
  cost_usd: null
});

const logged = (seq: number, fields: Partial<TaskLogStep>): TaskLogStep => ({
  seq,
  call: `c${seq}`,
  at: seq,
  ended_at: null,
  state: "done",
  text: `step ${seq}`,
  detail: "",
  input: "",
  output: "",
  ...fields
});

describe("a task's timeline", () => {
  it("shows the row's few steps until its log loads, the newest running while it works", () => {
    const steps = taskTimeline(task("working", [{ at: 1, text: "Reading a.ts" }, { at: 2, text: "Editing a.ts" }]), null);
    expect(steps.map((step) => [step.title, step.state])).toEqual([
      ["Reading a.ts", "done"],
      ["Editing a.ts", "running"]
    ]);
  });

  it("runs several tools at once, and says which failed", () => {
    const log = [logged(1, { state: "failed", detail: "exit 1" }), logged(2, { state: "running" }), logged(3, { state: "running" })];
    expect(taskTimeline(task("working"), log).map((step) => step.state)).toEqual(["failed", "running", "running"]);
  });

  it("shows a tool the task ended before it returned as stopped", () => {
    expect(taskTimeline(task("stopped"), [logged(1, { state: "running" })])[0]?.state).toBe("stopped");
  });

  it("treats words from an older runner as done once another step follows", () => {
    const log = [logged(1, { call: null }), logged(2, { call: null })];
    expect(taskTimeline(task("working"), log).map((step) => step.state)).toEqual(["done", "running"]);
    expect(taskTimeline(task("done"), log).map((step) => step.state)).toEqual(["done", "done"]);
  });

  it("shows an agent's words without their markdown, keeping quoted code for mono", () => {
    const log = [logged(1, { call: null, text: "working on: **Lint** the *web* app with `pnpm lint`" }), logged(2, { text: "Ran `a*b*`" })];
    expect(taskTimeline(task("done"), log).map((step) => step.title)).toEqual(["working on: Lint the web app with `pnpm lint`", "Ran `a*b*`"]);
  });
});

const message = (role: PiMessage["role"], parts: PiMessage["parts"], id: string = crypto.randomUUID()): PiMessage => ({ id, role, parts, timestamp: 0 });

describe("the main agent's turn as a timeline", () => {
  const earlier = [
    message("user", [{ type: "text", text: "before" }]),
    message("assistant", [{ type: "tool-call", id: "old", name: "ls", arguments: {} }])
  ];

  it("has only the newest turn's tools, titled by what each did", () => {
    const messages = [
      ...earlier,
      message("user", [{ type: "text", text: "find TaskFeed" }]),
      message("assistant", [
        { type: "text", text: "Looking." },
        { type: "tool-call", id: "g", name: "grep", arguments: { pattern: "TaskFeed" } },
        { type: "tool-call", id: "r", name: "read", arguments: { path: "src/tasks.ts" } }
      ]),
      message("tool", [
        { type: "tool-result", id: "g", name: "grep", content: [{ type: "text", text: "a.ts:1\nb.ts:2" }], error: false }
      ])
    ];

    const steps = turnTimeline({ messages, live: null, running: true, tools: [{ callId: "r", name: "read", output: "" }] });
    expect(steps.map((step) => [step.title, step.state, step.detail])).toEqual([
      ["Searched files — 2 matches", "done", "a.ts:1 b.ts:2"],
      ["Reading tasks.ts", "running", ""]
    ]);
  });

  it("shows the streaming message's calls, and calls cut off once the turn is over as stopped", () => {
    const live = message("assistant", [{ type: "tool-call", id: "b", name: "exec", arguments: { code: "print(1)" } }], "live");
    const turn = [message("user", [{ type: "text", text: "go" }])];
    expect(turnTimeline({ messages: turn, live, running: true, tools: [] })[0]).toMatchObject({ title: "Running `print(1)`", state: "running" });
    expect(turnTimeline({ messages: [...turn, live], live: null, running: false, tools: [] })[0]?.state).toBe("stopped");
  });
});
