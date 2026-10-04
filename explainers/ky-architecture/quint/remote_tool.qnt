// FUTURE: a tool that must run on one machine (apple_reminders on the Mac),
// called by the main agent mid-turn. One job, one node, a shared clock.
//
// Durable job row on the DO (SQL): { id = pi tool-call/task id, state:
// queued -> sent -> acked -> done | failed | expired | aborted, deadline,
// outcome }. Delivered through the node's socket while online; the node
// executes and replies { id, result }. Two delivery shapes:
//   BLOCK = true : the tool call waits (in memory) for the row to go terminal.
//   BLOCK = false: the tool returns "started"; the terminal row is posted to
//                  the main chat later with harness.submit (like machine tasks).
module remote {
  const BLOCK: bool
  // Node keeps durable started/done marks per job id and never re-runs a
  // started job: redelivery gets the cached result or "unknown".
  const NODE_DEDUPE: bool
  // Deadline lives in SQL + a DO alarm, re-armed after eviction (vs an
  // in-memory timer in the waiting tool).
  const DURABLE_DEADLINE: bool
  // The job carries its absolute deadline; the node refuses to start after it.
  const NODE_CHECKS_DEADLINE: bool
  // Expiry/abort say "not run" only if the job was never sent, else "unknown".
  const TRUTHFUL_EXPIRY: bool
  // Report shape: operationId = remote:<job id> (vs a random uuid).
  const STABLE_OPID: bool
  // Block shape: after DO eviction pi re-invokes the tool with the same call
  // id, which finds the row by id and waits again (vs the call failing).
  const WAITER_RESUMES: bool

  pure val D = 2         // tool timeout
  pure val MAXT = 5
  pure val MAX_CRASH = 2
  pure val MAX_EVICT = 2

  type Job = { state: str, deadline: int, sentEver: bool, outcome: str, needPost: bool }
  type Node = { online: bool, executing: bool, effectDone: bool, memHandled: bool,
                started: bool, done: bool, crashes: int }
  type Net = { down: List[str], up: List[str] }
  type Cons = { waiter: bool, timer: bool, consumed: int, told: str, ops: Set[str], evictions: int }
  type Ghost = { effects: int, execAfterTerminal: bool, lateResult: bool }

  var clock: int
  var job: Job
  var node: Node
  var net: Net
  var cons: Cons
  var g: Ghost
  var act: str

  pure def isOpen(s: str): bool = Set("queued", "sent", "acked").contains(s)
  pure def terminal(s: str): bool = Set("done", "failed", "expired", "aborted").contains(s)
  pure def giveUpOutcome(j: Job): str =
    if (TRUTHFUL_EXPIRY and j.sentEver) "unknown" else "not_run"

  // ---------------- DO / tool ----------------

  action Call = all {
    job.state == "none",
    val j = { state: if (node.online) "sent" else "queued", deadline: clock + D,
              sentEver: node.online, outcome: "", needPost: false }
    all {
      job' = j,
      net' = if (node.online) { ...net, down: net.down.append("job") } else net,
      cons' = { ...cons, waiter: BLOCK, timer: true },
      clock' = clock, node' = node, g' = g,
    },
  }

  // giving up: deadline alarm or Esc; cancel goes to the node if online
  pure def giveUp(j: Job, n: Net, online: bool, st: str): { j: Job, n: Net } =
    { j: { ...j, state: st, outcome: giveUpOutcome(j), needPost: not(BLOCK) },
      n: if (online) { ...n, down: n.down.append("cancel") } else n }

  action Expire = all {
    cons.timer, clock >= job.deadline, isOpen(job.state),
    val r = giveUp(job, net, node.online, "expired")
    all { job' = r.j, net' = r.n, clock' = clock, node' = node, cons' = cons, g' = g },
  }

  // Esc. Block: aborts the waiting call. Report: an explicit stop.
  action Abort = all {
    isOpen(job.state),
    val r = giveUp(job, net, node.online, "aborted")
    all { job' = r.j, net' = r.n, clock' = clock, node' = node, cons' = cons, g' = g },
  }

  action ServerRecv = all {
    net.up.length() > 0,
    val m = net.up.head()
    val n1 = { ...net, up: net.up.tail() }
    if (m == "ack")
      all { job' = if (job.state == "sent") { ...job, state: "acked" } else job,
            net' = n1, clock' = clock, node' = node, cons' = cons, g' = g }
    else if (isOpen(job.state))
      // compare-and-set: only an open row takes a result
      all { job' = { ...job, state: if (m == "ok") "done" else "failed", outcome: m, needPost: not(BLOCK) },
            net' = n1, clock' = clock, node' = node, cons' = cons, g' = g }
    else
      all { job' = job, net' = n1, clock' = clock, node' = node, cons' = cons,
            g' = { ...g, lateResult: true } }
  }

  // Block: the waiting call returns the terminal row to the model.
  action Consume = all {
    BLOCK, cons.waiter, terminal(job.state), cons.consumed == 0,
    cons' = { ...cons, waiter: false, consumed: 1, told: job.outcome },
    job' = job, net' = net, clock' = clock, node' = node, g' = g,
  }

  // Report: harness.submit, then mark posted (markPosted = false models an
  // eviction between the two, so the post is retried).
  action Post(markPosted: bool): bool = all {
    not(BLOCK), job.needPost,
    val op = if (STABLE_OPID) "remote:job"
             else if (cons.ops.size() == 0) "remote:job:uuid1"
             else if (cons.ops.size() == 1) "remote:job:uuid2" else "remote:job:uuid3"
    val fresh = not(cons.ops.contains(op))
    all {
      cons' = { ...cons, ops: cons.ops.union(Set(op)),
                consumed: if (fresh) cons.consumed + 1 else cons.consumed,
                told: if (fresh) job.outcome else cons.told },
      job' = { ...job, needPost: not(markPosted) },
      net' = net, clock' = clock, node' = node, g' = g,
    }
  }

  // DO eviction + restart: memory (waiter, timer) is lost, SQL is kept.
  action Evict = all {
    cons.evictions < MAX_EVICT,
    val waiterBack = BLOCK and cons.waiter and WAITER_RESUMES
    val callFails = BLOCK and cons.waiter and not(WAITER_RESUMES) and cons.consumed == 0
    all {
      cons' = { ...cons, evictions: cons.evictions + 1, waiter: waiterBack,
                timer: job.state != "none" and (DURABLE_DEADLINE or waiterBack),
                consumed: if (callFails) 1 else cons.consumed,
                told: if (callFails) "interrupted" else cons.told },
      job' = job, net' = net, clock' = clock, node' = node, g' = g,
    }
  }

  // ---------------- node ----------------

  action NodeConnect = all {
    not(node.online),
    // the DO re-delivers every open row on connect
    val resend = isOpen(job.state)
    all {
      node' = { ...node, online: true },
      net' = if (resend) { ...net, down: net.down.append("job") } else net,
      job' = if (resend) { ...job, state: if (job.state == "queued") "sent" else job.state, sentEver: true } else job,
      clock' = clock, cons' = cons, g' = g,
    },
  }

  action NodeDisconnect(keepUp: bool): bool = all {
    node.online,
    node' = { ...node, online: false },
    net' = { down: List(), up: if (keepUp) net.up else List() },
    job' = job, clock' = clock, cons' = cons, g' = g,
  }

  action NodeCrash = all {
    node.crashes < MAX_CRASH,
    node' = { online: false, executing: false, effectDone: false, memHandled: false,
              started: NODE_DEDUPE and node.started, done: NODE_DEDUPE and node.done,
              crashes: node.crashes + 1 },
    net' = { down: List(), up: List() },
    job' = job, clock' = clock, cons' = cons, g' = g,
  }

  action NodeRecv = all {
    node.online, net.down.length() > 0,
    val m = net.down.head()
    val n1 = { ...net, down: net.down.tail() }
    if (m == "cancel") {
      // stops it only if the effect has not happened yet
      val stop = node.executing and not(node.effectDone)
      all { node' = if (stop) { ...node, executing: false } else node,
            net' = if (stop) { ...n1, up: n1.up.append("not_run") } else n1,
            job' = job, clock' = clock, cons' = cons, g' = g }
    } else {
      val n2 = { ...n1, up: n1.up.append("ack") }
      if (node.memHandled)
        all { node' = node, net' = n2, job' = job, clock' = clock, cons' = cons, g' = g }
      else if (NODE_DEDUPE and node.done)
        all { node' = { ...node, memHandled: true }, net' = { ...n2, up: n2.up.append("ok") },
              job' = job, clock' = clock, cons' = cons, g' = g }
      else if (NODE_DEDUPE and node.started)
        all { node' = { ...node, memHandled: true }, net' = { ...n2, up: n2.up.append("unknown") },
              job' = job, clock' = clock, cons' = cons, g' = g }
      else if (NODE_CHECKS_DEADLINE and clock > job.deadline)
        all { node' = { ...node, memHandled: true }, net' = { ...n2, up: n2.up.append("not_run") },
              job' = job, clock' = clock, cons' = cons, g' = g }
      else
        all { node' = { ...node, memHandled: true, executing: true, started: true },
              net' = n2, job' = job, clock' = clock, cons' = cons,
              g' = { ...g, execAfterTerminal: g.execAfterTerminal or terminal(job.state) } }
    }
  }

  // The non-idempotent side effect (create the reminder).
  action NodeEffect = all {
    node.executing, not(node.effectDone),
    node' = { ...node, effectDone: true },
    g' = { ...g, effects: g.effects + 1 },
    job' = job, net' = net, clock' = clock, cons' = cons,
  }

  action NodeFinish = all {
    node.executing, node.effectDone,
    node' = { ...node, executing: false, done: true },
    net' = if (node.online) { ...net, up: net.up.append("ok") } else net,
    job' = job, clock' = clock, cons' = cons, g' = g,
  }

  // ---------------- time ----------------

  // Time cannot pass an armed alarm, a ready waiter, or an unposted report.
  val urgent = (cons.timer and clock >= job.deadline and isOpen(job.state)) or
               (BLOCK and cons.waiter and terminal(job.state) and cons.consumed == 0) or
               (not(BLOCK) and job.needPost)

  action Tick = all {
    clock < MAXT, not(urgent),
    clock' = clock + 1,
    job' = job, net' = net, node' = node, cons' = cons, g' = g,
  }

  action init = all {
    clock' = 0,
    job' = { state: "none", deadline: 0, sentEver: false, outcome: "", needPost: false },
    node' = { online: false, executing: false, effectDone: false, memHandled: false,
              started: false, done: false, crashes: 0 },
    net' = { down: List(), up: List() },
    cons' = { waiter: false, timer: false, consumed: 0, told: "", ops: Set(), evictions: 0 },
    g' = { effects: 0, execAfterTerminal: false, lateResult: false },
    act' = "init",
  }

  action call = all { Call, act' = "Call" }
  action expire = all { Expire, act' = "Expire" }
  action abort = all { Abort, act' = "Abort(Esc)" }
  action serverRecv = all { ServerRecv, act' = "ServerRecv" }
  action consume = all { Consume, act' = "Consume" }
  action post(k: bool): bool = all { Post(k), act' = if (k) "Post" else "Post(evicted before marking)" }
  action evict = all { Evict, act' = "Evict(DO)" }
  action nodeConnect = all { NodeConnect, act' = "NodeConnect" }
  action nodeDisconnect(k: bool): bool = all { NodeDisconnect(k), act' = "NodeDisconnect" }
  action nodeCrash = all { NodeCrash, act' = "NodeCrash" }
  action nodeRecv = all { NodeRecv, act' = "NodeRecv" }
  action nodeEffect = all { NodeEffect, act' = "NodeEffect" }
  action nodeFinish = all { NodeFinish, act' = "NodeFinish" }
  action tick = all { Tick, act' = "Tick" }

  action step = any {
    call, expire, abort, serverRecv, consume,
    { nondet k = Set(true, false).oneOf() post(k) },
    evict, nodeConnect,
    { nondet k = Set(true, false).oneOf() nodeDisconnect(k) },
    nodeCrash, nodeRecv, nodeEffect, nodeFinish, tick,
  }

  // ---------------- invariants ----------------

  val ResultConsumedAtMostOnce = cons.consumed <= 1
  val NoExecutionAfterExpiryOrAbort = not(g.execAfterTerminal)
  // The model is never told "not run" about a job whose effect happened (now or later).
  val TruthfulOutcome = cons.told == "not_run" implies g.effects == 0
  // What the model was told is the row's final outcome (no orphaned result).
  val NoOrphanResult = (cons.consumed == 1 and terminal(job.state)) implies cons.told == job.outcome
  val NonIdempotentEffectAtMostOnce = g.effects <= 1
  val NoStuckWaiter = (job.state != "none" and clock > job.deadline) implies
                      (terminal(job.state) and cons.consumed >= 1)

  val Design = ResultConsumedAtMostOnce and TruthfulOutcome and NoOrphanResult and
               NonIdempotentEffectAtMostOnce and NoStuckWaiter

  // ---------------- replays ----------------

  // R1: the job is on the wire when the deadline passes; the node starts it after expiry.
  // (block shape: the waiter returns before time moves on)
  run seqLateStart = init.then(nodeConnect).then(call).then(tick).then(tick).then(expire)
    .then(consume).then(tick).then(nodeRecv)

  // R2: Esc while the job is on the wire: the node starts it anyway.
  run seqAbortRace = init.then(nodeConnect).then(call).then(abort).then(nodeRecv)

  // R3: node does the effect, crashes before replying, reconnects, gets the job again.
  run seqCrashRedo = init.then(nodeConnect).then(call).then(nodeRecv).then(nodeEffect)
    .then(nodeCrash).then(nodeConnect).then(nodeRecv).then(nodeEffect)

  // R4: DO evicted while the tool waits; the deadline passes.
  run seqEvictWait = init.then(call).then(evict).then(tick).then(tick).then(tick)

  // R5: expiry says "not run" though the node had started; it then finishes.
  run seqFalseNotRun = init.then(nodeConnect).then(call).then(nodeRecv).then(tick).then(tick)
    .then(expire).then(nodeEffect)
}

module design_block {
  import remote(BLOCK = true, NODE_DEDUPE = true, DURABLE_DEADLINE = true, NODE_CHECKS_DEADLINE = true,
                TRUTHFUL_EXPIRY = true, STABLE_OPID = true, WAITER_RESUMES = true).*
  run lateStartRefusedTest = seqLateStart.expect(Design and NoExecutionAfterExpiryOrAbort)
  run abortRaceUnavoidableTest = seqAbortRace.expect(Design and not(NoExecutionAfterExpiryOrAbort))
  run crashRedoTest = seqCrashRedo.fail()  // the second nodeEffect is not enabled: no re-run
  run evictWaitTest = seqEvictWait.fail()  // time cannot pass the re-armed deadline
  run falseNotRunTest = seqFalseNotRun.then(consume).expect(Design and cons.told == "unknown")
}

module design_report {
  import remote(BLOCK = false, NODE_DEDUPE = true, DURABLE_DEADLINE = true, NODE_CHECKS_DEADLINE = true,
                TRUTHFUL_EXPIRY = true, STABLE_OPID = true, WAITER_RESUMES = false).*
  run abortRaceUnavoidableTest = seqAbortRace.expect(Design and not(NoExecutionAfterExpiryOrAbort))
  run evictWaitTest = seqEvictWait.fail()
  // Post twice (evicted between submit and mark): one message reaches the chat.
  run postRetryTest = init.then(nodeConnect).then(call).then(nodeRecv).then(nodeEffect).then(nodeFinish)
    .then(serverRecv).then(serverRecv).then(post(false)).then(post(true))
    .expect(Design and cons.consumed == 1 and cons.told == "ok")
}

// Ablations: the design minus one rule.
module naive {
  import remote(BLOCK = true, NODE_DEDUPE = false, DURABLE_DEADLINE = false, NODE_CHECKS_DEADLINE = false,
                TRUTHFUL_EXPIRY = false, STABLE_OPID = false, WAITER_RESUMES = false).*
  run lateStartTest = seqLateStart.expect(not(NoExecutionAfterExpiryOrAbort))
  run crashRedoTest = seqCrashRedo.expect(not(NonIdempotentEffectAtMostOnce))
  run evictWaitTest = seqEvictWait.expect(not(NoStuckWaiter))
  run falseNotRunTest = seqFalseNotRun.then(consume).expect(not(TruthfulOutcome))
}
module block_no_resume {
  import remote(BLOCK = true, NODE_DEDUPE = true, DURABLE_DEADLINE = true, NODE_CHECKS_DEADLINE = true,
                TRUTHFUL_EXPIRY = true, STABLE_OPID = true, WAITER_RESUMES = false).*
}
module report_random_opid {
  import remote(BLOCK = false, NODE_DEDUPE = true, DURABLE_DEADLINE = true, NODE_CHECKS_DEADLINE = true,
                TRUTHFUL_EXPIRY = true, STABLE_OPID = false, WAITER_RESUMES = false).*
}
module report_no_alarm {
  import remote(BLOCK = false, NODE_DEDUPE = true, DURABLE_DEADLINE = false, NODE_CHECKS_DEADLINE = true,
                TRUTHFUL_EXPIRY = true, STABLE_OPID = true, WAITER_RESUMES = false).*
}
