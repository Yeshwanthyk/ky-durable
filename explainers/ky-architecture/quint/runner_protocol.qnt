// ky machine protocol: MachineHub (src/machines.ts) + TaskFeed (src/tasks.ts)
// on the Durable Object, ky-runner (runner/ky-runner.ts) on the machine.
// One task, several turns (start + send). Each fix is a constant so the
// same model checks the current code (all false) and the fixed protocol.
module runner {
  // Runner sends its outbox BEFORE hello (today: hello first, ky-runner.ts:286-288).
  const FLUSH_FIRST: bool
  // Reports carry the turn; the server drops reports for an already-closed
  // turn and submits with operationId task:turn (today: random uuid, machines.ts:267).
  const FENCED: bool
  // Runner persists the set of handled seqs (today: in-memory Set, ky-runner.ts:129).
  const DURABLE_HANDLED: bool
  // stop() withdraws only runs never sent to the runner and finishes early
  // only if no open turn ever reached the runner; the runner queues a run
  // that arrives for a task it is stopping instead of steering into it.
  const SAFE_STOP: bool
  // hello closes an open task (queued OR working) that is not active only
  // when none of its run rows are still unacked: the socket is FIFO, so every
  // run the runner had seen when it sent hello was acked before it. Today: any
  // working task not in active, queued never (machines.ts:210-216).
  const RECONCILE: bool
  // #enqueue re-sends every pending row in seq order, not just the new one
  // (today: only the new row, machines.ts:135; older unacked rows wait for a hello).
  const ORDERED_DELIVERY: bool

  pure val MAX_SEQ = 5
  pure val MAX_TURN = 3
  pure val MAX_RESTARTS = 2
  pure val TURNS = 1.to(MAX_TURN)

  type Cmd = { seq: int, kind: str, turn: int, sent: bool }
  type Msg = { kind: str, seq: int, turn: int, outcome: str, active: bool }
  type Run = { has: bool, turn: int, pending: int, stopped: bool, sessionSent: bool, next: int }
  type Report = { turn: int, outcome: str }

  type Srv = { status: str, curTurn: int, closed: int, maxSentTurn: int,
               inbox: List[Cmd], nextSeq: int, reports: List[Report] }
  type Net = { conn: bool, down: List[Cmd], up: List[Msg] }
  type Rn  = { job: Run, handled: Set[int], outbox: List[Msg], restarts: int }
  type Ghost = { execs: List[int], execTurns: Set[int], revived: bool, flip: bool, falseInterrupt: bool, maxExecTurn: int, outOfOrder: bool,
                 stoppedEarly: Set[int], steerLost: bool }

  pure val NoRun: Run = { has: false, turn: 0, pending: 0, stopped: false, sessionSent: false, next: 0 }
  pure val NoMsg: Msg = { kind: "", seq: 0, turn: 0, outcome: "", active: false }

  var srv: Srv
  var net: Net
  var rn: Rn
  var g: Ghost
  var act: str // last action, for readable traces

  pure def imax(a: int, b: int): int = if (a > b) a else b
  pure def terminal(s: str): bool = Set("done", "failed", "stopped").contains(s)
  pure def open(s: str): bool = Set("queued", "working").contains(s)

  // ---------------- server (DO) ----------------

  // #enqueue + #deliver: INSERT into inbox, send now if a socket is open.
  pure def enqueue(s: Srv, n: Net, kind: str, turn: int): { s: Srv, n: Net } =
    val c = { seq: s.nextSeq, kind: kind, turn: turn, sent: n.conn }
    val sentTurn = if (n.conn and kind == "run") imax(s.maxSentTurn, turn) else s.maxSentTurn
    val inbox1 = s.inbox.append(c)
    val batch = if (ORDERED_DELIVERY) inbox1 else List(c)
    val sentTurn2 = if (ORDERED_DELIVERY and n.conn)
                      inbox1.foldl(sentTurn, (acc, x) => if (x.kind == "run") imax(acc, x.turn) else acc)
                    else sentTurn
    { s: { ...s, inbox: if (ORDERED_DELIVERY and n.conn) inbox1.foldl(List(), (l, x) => l.append({ ...x, sent: true })) else inbox1,
           nextSeq: s.nextSeq + 1, maxSentTurn: sentTurn2 },
      n: if (n.conn) { ...n, down: n.down.concat(batch) } else n }

  // #finish: set terminal status, harness.submit a report.
  // Today: no check of prior status; operationId random => every call posts.
  pure def finish(s: Srv, gh: Ghost, outcome: str, turn: int): { s: Srv, g: Ghost } =
    if (FENCED and turn <= s.closed) { s: s, g: gh }
    else {
      s: { ...s, status: outcome, closed: imax(s.closed, turn),
           reports: s.reports.append({ turn: turn, outcome: outcome }) },
      g: { ...gh, flip: gh.flip or turn <= s.closed }
    }

  pure def runRows(s: Srv): List[Cmd] = s.inbox.select(c => c.kind == "run")

  // Would a hello with active = false close this task?
  pure def helloCloses(s: Srv): bool =
    if (RECONCILE) open(s.status) and runRows(s).length() == 0
    else s.status == "working"

  // onReport
  pure def handle(s: Srv, n: Net, gh: Ghost, m: Msg): { s: Srv, n: Net, g: Ghost } =
    if (m.kind == "hello") {
      val closes = not(m.active) and helloCloses(s)
      // ghost: the runner's real result is already queued right behind this hello
      val behind = n.up.select(x => x.kind == "result" and x.turn == s.curTurn).length() > 0
      val gh1 = { ...gh, falseInterrupt: gh.falseInterrupt or (closes and behind) }
      val f = if (closes) finish(s, gh1, "failed", s.curTurn) else { s: s, g: gh1 }
      // re-deliver every pending row (machines.ts:222)
      val anyRun = f.s.inbox.foldl(f.s.maxSentTurn, (acc, c) => if (c.kind == "run") imax(acc, c.turn) else acc)
      if (n.conn)
        { s: { ...f.s, inbox: f.s.inbox.foldl(List(), (l, c) => l.append({ ...c, sent: true })),
               maxSentTurn: anyRun },
          n: { ...n, down: n.down.concat(f.s.inbox) }, g: f.g }
      else { s: f.s, n: n, g: f.g }
    } else if (m.kind == "ack") {
      { s: { ...s, inbox: s.inbox.select(c => c.seq != m.seq) }, n: n, g: gh }
    } else if (m.kind == "session" or m.kind == "progress") {
      if (FENCED and m.turn <= s.closed) { s: s, n: n, g: gh }
      else { s: { ...s, status: "working" }, n: n,
             g: { ...gh, revived: gh.revived or (terminal(s.status) and m.turn <= s.closed) } }
    } else { // result
      val f = finish(s, gh, m.outcome, m.turn)
      { s: f.s, n: n, g: f.g }
    }

  action ServerRecv = all {
    net.up.length() > 0,
    val r = handle(srv, { ...net, up: net.up.tail() }, g, net.up.head())
    all { srv' = r.s, net' = r.n, g' = r.g, rn' = rn },
  }

  // ---------------- user / main agent (machine tool, task list) ----------------

  action UserStart = all {
    srv.status == "none",
    val s1 = { ...srv, status: "queued", curTurn: 1 }
    val e = enqueue(s1, net, "run", 1)
    all { srv' = e.s, net' = e.n, rn' = rn, g' = g },
  }

  // send(): steer (stays working) or resume (queued) with a new run turn.
  action UserSend = all {
    srv.status != "none", srv.curTurn < MAX_TURN, srv.nextSeq < MAX_SEQ,
    val t = srv.curTurn + 1
    val s1 = { ...srv, curTurn: t, status: if (srv.status == "working") "working" else "queued" }
    val e = enqueue(s1, net, "run", t)
    all { srv' = e.s, net' = e.n, rn' = rn, g' = g },
  }

  // stop(): withdraw queued runs; "Stopped before it started" if any were withdrawn.
  pure def withdrawable(c: Cmd): bool = c.kind == "run" and (not(SAFE_STOP) or not(c.sent))

  action UserStop = all {
    open(srv.status), srv.nextSeq < MAX_SEQ,
    val withdrawn = srv.inbox.select(c => withdrawable(c)).length()
    val s1 = { ...srv, inbox: srv.inbox.select(c => not(withdrawable(c))) }
    val early = if (SAFE_STOP) withdrawn > 0 and srv.maxSentTurn <= srv.closed
                else srv.status == "queued" and withdrawn > 0
    val f = finish(s1, g, "stopped", srv.curTurn)
    val e = enqueue(s1, net, "stop", srv.curTurn)
    all {
      srv' = if (early) f.s else e.s,
      net' = if (early) net else e.n,
      rn' = rn,
      g' = if (early) { ...f.g, stoppedEarly: f.g.stoppedEarly.union(Set(srv.curTurn)) } else g,
    }
  }

  // ---------------- runner (machine) ----------------

  // report(): send if open, else outbox unless progress/ack (ky-runner.ts:136-139)
  pure def report(n: Net, r: Rn, m: Msg): { n: Net, r: Rn } =
    if (n.conn) { n: { ...n, up: n.up.append(m) }, r: r }
    else if (m.kind == "progress" or m.kind == "ack") { n: n, r: r }
    else { n: n, r: { ...r, outbox: r.outbox.append(m) } }

  // onCommand (ky-runner.ts:247-274)
  action RunnerRecv = all {
    net.conn, net.down.length() > 0,
    val c = net.down.head()
    val n1 = { ...net, down: net.down.tail(), up: net.up.append({ ...NoMsg, kind: "ack", seq: c.seq }) }
    if (rn.handled.contains(c.seq)) all { net' = n1, rn' = rn, srv' = srv, g' = g }
    else {
      val r1 = { ...rn, handled: rn.handled.union(Set(c.seq)) }
      if (c.kind == "stop") {
        all { net' = n1, srv' = srv, g' = g,
              rn' = if (r1.job.has) { ...r1, job: { ...r1.job, stopped: true } } else r1 }
      } else if (r1.job.has and SAFE_STOP and r1.job.stopped) {
        // fixed: start it after the stopping session exits
        all { net' = n1, srv' = srv, rn' = { ...r1, job: { ...r1.job, next: c.turn } },
              g' = { ...g, execs: g.execs.append(c.seq), execTurns: g.execTurns.union(Set(c.turn)),
                     maxExecTurn: imax(g.maxExecTurn, c.turn), outOfOrder: g.outOfOrder or c.turn < g.maxExecTurn } }
      } else if (r1.job.has) {
        // steer into the live session
        all { net' = n1, srv' = srv,
              rn' = { ...r1, job: { ...r1.job, pending: r1.job.pending + 1, turn: c.turn } },
              g' = { ...g, execs: g.execs.append(c.seq), execTurns: g.execTurns.union(Set(c.turn)),
                     maxExecTurn: imax(g.maxExecTurn, c.turn), outOfOrder: g.outOfOrder or c.turn < g.maxExecTurn,
                     steerLost: g.steerLost or r1.job.stopped } }
      } else {
        all { net' = n1, srv' = srv,
              rn' = { ...r1, job: { has: true, turn: c.turn, pending: 1, stopped: false, sessionSent: false, next: 0 } },
              g' = { ...g, execs: g.execs.append(c.seq), execTurns: g.execTurns.union(Set(c.turn)),
                     maxExecTurn: imax(g.maxExecTurn, c.turn), outOfOrder: g.outOfOrder or c.turn < g.maxExecTurn } }
      }
    }
  }

  action RunSession = all {
    rn.job.has, not(rn.job.sessionSent),
    val o = report(net, { ...rn, job: { ...rn.job, sessionSent: true } }, { ...NoMsg, kind: "session", turn: rn.job.turn })
    all { net' = o.n, rn' = o.r, srv' = srv, g' = g },
  }

  action RunProgress = all {
    rn.job.has,
    val o = report(net, rn, { ...NoMsg, kind: "progress", turn: rn.job.turn })
    all { net' = o.n, rn' = o.r, srv' = srv, g' = g },
  }

  // Claude Code emits a result event (or the child exits).
  action RunResult(ok: str): bool = all {
    rn.job.has,
    if (rn.job.pending > 1) {
      val o = report(net, { ...rn, job: { ...rn.job, pending: rn.job.pending - 1 } },
                     { ...NoMsg, kind: "progress", turn: rn.job.turn })
      all { net' = o.n, rn' = o.r, srv' = srv, g' = g }
    } else {
      val outcome = if (rn.job.stopped) "stopped" else ok
      val after = if (rn.job.next > 0) { ...NoRun, has: true, turn: rn.job.next, pending: 1 } else NoRun
      val o = report(net, { ...rn, job: after }, { ...NoMsg, kind: "result", turn: rn.job.turn, outcome: outcome })
      all { net' = o.n, rn' = o.r, srv' = srv, g' = g }
    }
  }

  // Socket drops. In-flight commands are lost; in-flight reports may or may not arrive.
  action Disconnect(keepUp: bool): bool = all {
    net.conn,
    all { net' = { conn: false, down: List(), up: if (keepUp) net.up else List() },
          srv' = srv, rn' = rn, g' = g },
  }

  // open: hello{active}, then outbox (today) or outbox, then hello (fixed).
  action Connect = all {
    not(net.conn),
    val hello = { ...NoMsg, kind: "hello", active: rn.job.has }
    val msgs = if (FLUSH_FIRST) rn.outbox.append(hello) else List(hello).concat(rn.outbox)
    all { net' = { ...net, conn: true, up: net.up.concat(msgs) },
          rn' = { ...rn, outbox: List() }, srv' = srv, g' = g },
  }

  // 30s keepalive hello (ky-runner.ts:316-318)
  action Keepalive = all {
    net.conn,
    net' = { ...net, up: net.up.append({ ...NoMsg, kind: "hello", active: rn.job.has }) },
    srv' = srv, rn' = rn, g' = g,
  }

  // Runner process restarts: runs, outbox and (today) handled are lost.
  action RunnerRestart(keepUp: bool): bool = all {
    rn.restarts < MAX_RESTARTS,
    all { net' = { conn: false, down: List(), up: if (keepUp) net.up else List() },
          rn' = { job: NoRun, handled: if (DURABLE_HANDLED) rn.handled else Set(),
                  outbox: List(), restarts: rn.restarts + 1 },
          srv' = srv, g' = g },
  }

  action init = all {
    srv' = { status: "none", curTurn: 0, closed: 0, maxSentTurn: 0, inbox: List(), nextSeq: 1, reports: List() },
    net' = { conn: false, down: List(), up: List() },
    rn' = { job: NoRun, handled: Set(), outbox: List(), restarts: 0 },
    g' = { execs: List(), execTurns: Set(), revived: false, flip: false, falseInterrupt: false, maxExecTurn: 0, outOfOrder: false, stoppedEarly: Set(), steerLost: false },
    act' = "init",
  }

  // Labeled steps (also used by the replay tests below).
  action serverRecv = all { ServerRecv, act' = "ServerRecv" }
  action userStart = all { UserStart, act' = "UserStart" }
  action userSend = all { UserSend, act' = "UserSend" }
  action userStop = all { UserStop, act' = "UserStop" }
  action runnerRecv = all { RunnerRecv, act' = "RunnerRecv" }
  action runSession = all { RunSession, act' = "RunSession" }
  action runProgress = all { RunProgress, act' = "RunProgress" }
  action runResult(ok: str): bool = all { RunResult(ok), act' = if (ok == "done") "RunResult(done)" else "RunResult(failed)" }
  action disconnect(k: bool): bool = all { Disconnect(k), act' = if (k) "Disconnect(reports arrive)" else "Disconnect(reports lost)" }
  action connect = all { Connect, act' = "Connect" }
  action keepalive = all { Keepalive, act' = "Keepalive" }
  action restart(k: bool): bool = all { RunnerRestart(k), act' = if (k) "RunnerRestart(reports arrive)" else "RunnerRestart(reports lost)" }

  action step = any {
    serverRecv, userStart, userSend, userStop, runnerRecv, runSession, runProgress,
    { nondet ok = Set("done", "failed").oneOf() runResult(ok) },
    { nondet k = Set(true, false).oneOf() disconnect(k) },
    connect, keepalive,
    { nondet k = Set(true, false).oneOf() restart(k) },
  }

  // ---------------- invariants ----------------

  val AtMostOneTerminalReportPerTurn =
    TURNS.forall(t => srv.reports.select(r => r.turn == t).length() <= 1)

  // A closed turn's terminal status is never rewritten (stopped -> done, failed -> done ...).
  val NoTerminalFlip = not(g.flip)

  // A closed turn is never reopened (status terminal -> working) by a runner report.
  val NoClosedTurnReopens = not(g.revived)

  // hello never reports "interrupted" while the turn's real result is already on its way.
  val NoFalseInterrupt = not(g.falseInterrupt)

  // Turns execute in the order the user sent them.
  val NoOutOfOrderExecution = not(g.outOfOrder)

  val NoDuplicateExecution =
    g.execs.length() == g.execs.foldl(Set(), (acc, x) => acc.union(Set(x))).size()

  // "Stopped before it started" is true: that turn never executes, before or after the report.
  val NoRunAfterStoppedReport = g.stoppedEarly.intersect(g.execTurns) == Set()

  // A message sent after stop is not swallowed by the dying session.
  val NoSteerIntoStoppedRun = not(g.steerLost)

  // Progress, as a safety check on quiescent states: once nothing is in
  // flight, the task is terminal or the next keepalive hello will close it.
  val Quiescent = net.conn and net.up.length() == 0 and net.down.length() == 0 and
                  not(rn.job.has) and rn.outbox.length() == 0 and srv.inbox.length() == 0
  val QuiescentRecoverable = Quiescent implies (not(open(srv.status)) or helloCloses(srv))

  val Safety = AtMostOneTerminalReportPerTurn and NoTerminalFlip and NoClosedTurnReopens and NoFalseInterrupt and NoOutOfOrderExecution and
               NoDuplicateExecution and NoRunAfterStoppedReport and NoSteerIntoStoppedRun and
               QuiescentRecoverable

  // ---------------- minimal replays (counterexamples on `current`) ----------------
  // Every sequence starts with the runner connected and its hello handled.
  action online = init.then(connect).then(serverRecv)

  // CE1: stop() while the run's ack is in flight.
  run seqStopRace = online.then(userStart).then(runnerRecv).then(userStop)
    .then(serverRecv).then(runSession).then(serverRecv).then(runResult("done")).then(serverRecv)

  // CE2: result finished offline; on reconnect hello is processed before the outbox.
  run seqHelloBeforeOutbox = online.then(userStart).then(runnerRecv).then(serverRecv)
    .then(runSession).then(serverRecv).then(disconnect(true)).then(runResult("done"))
    .then(connect).then(serverRecv).then(serverRecv)

  // CE3: ack lost + runner restart => redelivered run executes again.
  run seqDupExec = online.then(userStart).then(runnerRecv).then(restart(false))
    .then(connect).then(serverRecv).then(runnerRecv)

  // CE4: send right after stop steers into the session being killed.
  run seqSteerIntoStop = online.then(userStart).then(runnerRecv).then(serverRecv)
    .then(runSession).then(serverRecv).then(userStop).then(runnerRecv).then(serverRecv)
    .then(userSend).then(runnerRecv)

  // CE5: result sent on a socket that drops, before any session report => stuck queued.
  run seqStuckQueued = online.then(userStart).then(runnerRecv).then(serverRecv)
    .then(runResult("done")).then(disconnect(false)).then(connect).then(serverRecv)

  // CE6: run started while offline; runner connects; a follow-up send is
  // delivered directly before the hello re-delivers the first run.
  run seqReorder = init.then(userStart).then(connect).then(userSend)
    .then(serverRecv).then(runnerRecv).then(runnerRecv)

  // witness: a task reaches done (run --invariant=CanFinish should FAIL = reachable)
  val CanFinish = srv.status != "done"
}

// The code as it is today.
module current {
  import runner(FLUSH_FIRST = false, FENCED = false, DURABLE_HANDLED = false,
                SAFE_STOP = false, RECONCILE = false, ORDERED_DELIVERY = false).*

  // Each test passes iff the counterexample reproduces on today's protocol.
  run stopRaceDoubleReportTest = seqStopRace.expect(
    not(AtMostOneTerminalReportPerTurn) and not(NoTerminalFlip) and
    not(NoClosedTurnReopens) and not(NoRunAfterStoppedReport))
  run helloBeforeOutboxTest = seqHelloBeforeOutbox.expect(
    not(AtMostOneTerminalReportPerTurn) and not(NoTerminalFlip) and not(NoFalseInterrupt) and srv.status == "done")
  run dupExecTest = seqDupExec.expect(not(NoDuplicateExecution))
  run steerIntoStopTest = seqSteerIntoStop.expect(not(NoSteerIntoStoppedRun))
  run stuckQueuedTest = seqStuckQueued.expect(
    Quiescent and srv.status == "queued" and not(QuiescentRecoverable))
  run reorderTest = seqReorder.expect(not(NoOutOfOrderExecution))
}
