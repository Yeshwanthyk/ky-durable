// ky: where everything runs today, the runner reconnect trap, and the planned node + automation primitives.
mx.scene({
  title: ["ky", "where everything runs"],
  highlight: ["one Durable Object,", "two ways.", "lands once.", "become a node.", "is your update."],
}, (s) => {
  // ─── act 1: the brain and what it reaches
  s.act("where it runs", 0);
  s.orb("brain", 'PiAgent "me"', { at: [5, 3], r: 90, status: "one Durable Object", enter: "Durable-0.2",
    inspect: { body: "The only brain: main chat, side chats and subagents are pi conversations in this one DO.", more: "Tools are durable tasks: safe tools replay, unsafe ones return interrupted after a crash.", cite: "src/server.ts:72-197" } });
  s.box("sqlite", "DO SQLite", { at: [5, 0.5], status: "every table", enter: "SQLite",
    inspect: { body: "pi_* · ky_tasks · ky_machine_inbox · ky_machines · ky_chats · ky_settings · memo_* · ky_files · workspace fs", cite: "src/tasks.ts:51-60 · src/machines.ts:84-89" } });
  s.wire("brain", "sqlite", { id: "bs", enter: "holds-0.2" });
  s.el("brain").set("table", { tone: "amber" });
  s.box("ui", "browser", { at: [0.7, 3], status: "holds nothing", enter: "browser-0.2",
    inspect: { body: "No durable state; on connect the DO sends a snapshot.", cite: "src/sockets.ts:225-256" } });
  s.box("worker", "Worker", { at: [2.6, 3], status: "auth · files", enter: "browser",
    inspect: { body: "Checks KY_TOKEN, routes to the DO named \"me\", serves /api/files from R2.", cite: "src/server.ts:380-404" } });
  s.wire("ui", "worker", { id: "uw", enter: "browser+0.2" });
  s.wire("worker", "brain", { id: "wb", enter: "browser+0.4", label: "WS" }).send("resyncs-0.2", "snapshot", { back: true });
  s.el("ui").set("socket", { status: "resynced", tone: "green" });
  s.box("sandbox", "exec sandbox", { at: [9, 1.4], status: "Dynamic Worker", enter: "sandbox-0.2",
    inspect: { body: "A fresh isolate per exec; its fs is the DO workspace. Git only, no shell, no network.", cite: "src/workspace.ts:25-65 · src/server.ts:96-108" } });
  s.box("kite", "Kitesurf", { at: [9, 4.6], status: "cloud browser", enter: "Kitesurf-0.2",
    inspect: { body: "Browser Rendering binding; the browse tool is for subagents only, 90s cap.", cite: "src/browse.ts:17-83 · src/server.ts:231-237" } });
  s.wire("brain", "sandbox", { id: "bx", enter: "sandbox" });
  s.wire("brain", "kite", { id: "bk", enter: "Kitesurf" });
  s.el("sandbox").set("bindings", { status: "binding LOADER", tone: "green" });
  s.el("kite").set("bindings", { status: "binding BROWSER", tone: "green" });
  s.box("memory", "memory", { at: [2.6, 5.2], status: "memo_log · memo_tree", enter: "Memory-0.2",
    inspect: { body: "OptMem over DO SQLite; rendered as a section in main conversations only.", cite: "src/memory.ts:145-149, 373-431" } });
  s.wire("memory", "brain", { id: "mb", enter: "module" });
  s.el("memory").set("inside", { status: "a module, not a service", tone: "amber" });

  // ─── act 2: the Mac today, the reconnect trap, rewind, fix
  s.act("the mac today", "Mac-0.3", { tone: "coral" });
  for (const id of ["ui", "worker", "sandbox", "kite", "memory", "wb", "uw", "bx", "bk", "mb"]) s.el(id).exit("Mac-0.3", { dur: 0.3 });
  s.el("brain").set("Mac", { status: "main chat", tone: "ink" });
  s.box("vp", "VibeProxy", { at: [9, 1.2], status: "Claude (sub)", enter: "tunnel-0.3",
    inspect: { body: "Anthropic Messages at 127.0.0.1:8317 on the Mac, reached over a Workers VPC tunnel. Probe 3s, cached 30s; on failure the turn runs on the fallback slot.", cite: "src/vibeproxy.ts:21-27, 65-129" } });
  s.wire("brain", "vp", { id: "tun", enter: "tunnel-0.2", label: "VPC tunnel" }).send("streams-0.3", "messages", { back: true });
  s.box("runner", "ky-runner", { at: [8.4, 4.6], status: "node \"mac\"", enter: "runner-0.3",
    inspect: { body: "Dials out over WS ?runner=mac. Its outbox and handled seqs live in memory.", cite: "runner/ky-runner.ts:129-139, 278-318" } });
  s.box("cc", "Claude Code", { at: [11, 4.6], status: "claude -p", enter: "Claude-0.2",
    inspect: { body: "Child process, stream-json, bypassPermissions by default, KY_TOKEN in env.", cite: "runner/ky-runner.ts:145-222" } });
  s.wire("brain", "runner", { id: "ws", enter: "runner-0.2", label: "WS" }).send("down-0.2", "run #41");
  s.wire("runner", "cc", { id: "rc", enter: "Claude" });
  s.el("cc").set("Code+0.2", { status: "working", spin: true, tone: "amber" });
  s.el("cc").set("reconnect-0.2", { status: "done", spin: "ok", tone: "green" });
  s.el("runner").set("reconnect", { status: "outbox: result", tone: "amber" });
  s.el("ws").send("sends", "hello active:[]", { back: true });
  s.el("ws").fail("interrupted-0.3");
  s.el("brain").set("interrupted", { status: "report #1: interrupted", tone: "coral" });
  s.callout("brain", "false report", "random operationId, no dedupe", { side: "left", enter: "interrupted+0.2", exit: "again+0.3" });
  s.el("ws").send("real-0.2", "result", { back: true, tone: "coral" });
  s.el("brain").set("again", { status: "report #2: done", tone: "coral" });
  s.el("sqlite").set("again", { status: "failed → done", tone: "coral" });

  s.rewind("again+0.5", "reconnect+0.6", { dur: 0.9 });
  s.act("the fix", "fix", { tone: "green" });
  s.el("runner").set("outbox#2", { status: "outbox → hello", tone: "green" });
  s.el("ws").send("outbox#2", "result", { back: true, tone: "green" });
  s.el("brain").set("lands", { status: "one report", tone: "green" });
  s.el("sqlite").set("lands", { status: "done", tone: "green" });

  // ─── act 3: nodes (planned)
  s.act("nodes", "Next-0.3", { tone: "blue" });
  for (const id of ["cc", "vp", "tun", "rc"]) s.el(id).exit("Next-0.3", { dur: 0.3 });
  s.el("brain").set("Next", { status: "main chat", tone: "ink" });
  s.el("sqlite").set("Next", { status: "ky_machines", tone: "ink" });
  s.el("runner").set("manifest", { status: "darwin · reminders", tone: "blue" });
  s.el("ws").send("carries-0.4", "hello {os, tools}", { back: true, tone: "blue" });
  s.el("sqlite").set("models", { status: "manifest saved", tone: "blue" });
  s.box("rem", "apple_reminders", { at: [11, 4.6], status: "node tool", tone: "blue", enter: "reminders-0.2",
    inspect: { body: "Planned. Schema in the DO via nodeTool({name, os}); handler in runner/tools via osascript. Main-only.", more: "If the DO crashes mid-wait, pi-durable hands the model an interrupted result.", cite: "planned: src/nodes.ts · pi-durable README:168" } });
  s.wire("runner", "rem", { id: "rr", enter: "reminders" });
  s.el("ws").send("call", "call #7", { tone: "blue" });
  s.el("brain").set("waits", { status: "awaiting #7", spin: true, tone: "blue" });
  s.gauge("deadline", "deadline", 90, { at: [6.7, 5.6], unit: "s", enter: "deadline-0.6",
    inspect: { body: "The tool races the return against a deadline and the abort signal; abort sends stop-call.", cite: "planned: src/nodes.ts" } })
    .set("deadline", { value: 88 }, { dur: 1.2 });
  s.el("rem").set("deadline", { status: "created", tone: "green" });
  s.el("ws").send("deadline+0.3", "return #7", { back: true, tone: "green" });
  s.el("brain").set("second-0.3", { status: "tool result", spin: false, tone: "green" });
  s.box("box", "ky-runner", { at: [8.4, 1.4], status: "node \"box\"", tone: "blue", enter: "second",
    inspect: { body: "Same runner, own name and token. Today a missing machine name is refused once two are online; same names double-send.", cite: "src/machines.ts:138-150, 324-325" } });
  s.box("lm", "local model", { at: [11, 1.4], status: "ollama / ChatGPT proxy", tone: "blue", enter: "serves",
    inspect: { body: "Its own vpc_services entry plus vibeProxy({binding, origin, api}). Model traffic never rides the runner socket.", cite: "seam: src/vibeproxy.ts:54-60 · wrangler.jsonc:27-34" } });
  s.wire("box", "lm", { id: "bl", enter: "serves+0.2" });
  s.wire("brain", "lm", { id: "tun2", shape: "curve", label: "tunnel #2", enter: "tunnel#2-0.3" }).send("tunnel#2", "stream", { back: true, tone: "blue" });

  // ─── act 4: automations (planned)
  s.act("automations", "Automations-0.3", { tone: "blue" });
  for (const id of ["box", "lm", "tun2", "rem", "deadline", "runner", "ws", "rr", "bl"]) s.el(id).exit("Automations-0.3", { dur: 0.3 });
  s.el("brain").set("Automations", { status: "main chat", tone: "ink" });
  s.el("sqlite").set("Automations", { status: "schedule rows", tone: "ink" });
  s.box("sched", "Scheduler", { at: [9, 3], status: "0 8 * * *", tone: "blue", enter: "scheduler-0.2",
    inspect: { body: "Agents SDK Scheduler on the existing Lifecycle: cron, interval, retry. Marked experimental. Missed slots are not backfilled.", cite: "agents/schedules · src/server.ts:195-197" } });
  s.wire("sched", "brain", { id: "fire", enter: "scheduler" }).send("fire-0.3", "fire 08:00", { back: true, tone: "blue" });
  s.callout("brain", "operationId", "automation:7:08:00", { side: "left", enter: "fixed", exit: "reply" });
  s.el("brain").set("submits", { status: "followUp · main chat", tone: "blue" });
  s.el("fire").send("duplicate-0.4", "fire 08:00", { back: true, tone: "coral" });
  s.el("brain").set("dropped", { status: "deduped", tone: "green" });
  s.box("chat", "main chat", { at: [1.4, 3], status: "", enter: "reply-0.3",
    inspect: { body: "The automation's reply is the update; no separate post-to-chat path.", cite: "agents/harness/pi index.d.ts:57-70 (operationId)" } });
  s.wire("brain", "chat", { id: "out", enter: "reply-0.2" }).send("reply", "8:00 summary", { tone: "green" });
  s.el("chat").set("update", { status: "8:00 summary", tone: "green" });
});
