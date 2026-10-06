// Automations: jobs made from chat (one-off or cron, in UTC) that the DO runs
// with the Agents SDK Scheduler. One automation; each fire carries a slot (the
// schedule's due time in seconds; run-now passes its own). A fire starts a run:
// a background cloud subagent task `a-<id>-<slot>` (ky_tasks.source
// `automation:<id>`) or a machine task with the same id. When the run ends, its
// report reaches the main chat through the subagent Reporter (requestId
// `subagent-report:<taskId>`) or the machines report path.
//
// Three invariants, and only the state that shows them:
//   ONE_RUN_PER_SLOT    a duplicate fire or redelivery of a slot makes no
//                       second run and no second report.
//   NO_OVERLAP          a slot is skipped while the last run is queued or working.
//   NOTHING_AFTER_PAUSE after pause or archive no new run starts, and a run
//                       still in flight does not post its report.
//
// The platform gives the rest, so it is not modelled:
// - Missed slots coalesce into one late run: after a callback the SDK books
//   the next cron fire from now.
// - Restart recovery: the SDK's alarm redelivers (that is a duplicate fire
//   here), and on start ky re-books any active automation whose schedule is
//   missing.
// - A stable report id: the Reporter's requestId, so a retried post is one message.
//
// Statuses are active | paused | done (a one-off that has run) | archived.
// Removing is archiving; unarchive goes back to paused. `done` behaves like
// paused for these invariants, so it is left out.
module automations {
  // The run's task id is built from the slot, so a second spawn for the
  // same slot is a no-op. naive: every fire spawns a new task.
  const KEYED_SPAWN: bool
  // A fire is skipped while the last run is queued or working.
  const SKIP_IF_LIVE: bool
  // The fire callback re-reads the status and does nothing unless active
  // (a redelivered or in-flight fire can arrive after pause).
  const CHECK_ON_FIRE: bool
  // Pause and archive stop the live run (queued or working).
  const STOP_ON_PAUSE: bool
  // The Reporter re-reads the status right before posting and drops the
  // report unless the automation is still active.
  const CHECK_BEFORE_POST: bool

  pure val SLOTS = 1.to(3)

  type Run = { slot: int, state: str, reported: bool }  // queued | working | done | stopped
  type Ghost = { spawns: List[int], reports: List[int],
                 startWhenOff: bool, postWhenOff: bool }

  var status: str                   // active | paused | archived
  var runs: List[Run]               // ky_tasks rows made by this automation
  var g: Ghost
  var act: str

  pure def isLive(r: Run): bool = r.state == "queued" or r.state == "working"
  pure def setState(rs: List[Run], s: int, src: str, dst: str): List[Run] =
    rs.foldl(List(), (l, r) => l.append(if (r.slot == s and r.state == src) { ...r, state: dst } else r))
  pure def has(rs: List[Run], s: int, st: str): bool =
    rs.select(r => r.slot == s and r.state == st).length() > 0

  // ---------------- scheduler ----------------

  // The SDK fires a slot. Any slot, any number of times: a redelivered
  // alarm, a late fire after pause, or run-now with its own slot.
  action Fire(s: int): bool = all {
    val off = status != "active"
    val dup = KEYED_SPAWN and runs.select(r => r.slot == s).length() > 0
    val busy = SKIP_IF_LIVE and runs.select(r => isLive(r)).length() > 0
    if ((CHECK_ON_FIRE and off) or dup or busy)
      all { runs' = runs, g' = g, status' = status }
    else all {
      runs' = runs.append({ slot: s, state: "queued", reported: false }),
      g' = { ...g, spawns: g.spawns.append(s), startWhenOff: g.startWhenOff or off },
      status' = status,
    }
  }

  // ---------------- runs ----------------

  // The task leaves the queue and starts working.
  action Start(s: int): bool = all {
    has(runs, s, "queued"),
    runs' = setState(runs, s, "queued", "working"),
    g' = { ...g, startWhenOff: g.startWhenOff or status != "active" },
    status' = status,
  }

  action Finish(s: int): bool = all {
    has(runs, s, "working"),
    runs' = setState(runs, s, "working", "done"),
    g' = g, status' = status,
  }

  // The Reporter posts a finished run's report to the main chat.
  action Report(s: int): bool = all {
    runs.select(r => r.slot == s and r.state == "done" and not(r.reported)).length() > 0,
    val drop = CHECK_BEFORE_POST and status != "active"
    // mark one unreported run of this slot reported
    val marked = runs.foldl({ l: List(), hit: false }, (acc, r) =>
      if (not(acc.hit) and r.slot == s and r.state == "done" and not(r.reported))
        { l: acc.l.append({ ...r, reported: true }), hit: true }
      else { l: acc.l.append(r), hit: acc.hit })
    all {
      runs' = marked.l,
      g' = if (drop) g else { ...g, reports: g.reports.append(s),
                                    postWhenOff: g.postWhenOff or status != "active" },
      status' = status,
    }
  }

  // ---------------- user (or ky) ----------------

  pure def stopLive(rs: List[Run]): List[Run] =
    rs.foldl(List(), (l, r) => l.append(if (isLive(r)) { ...r, state: "stopped" } else r))

  action Pause = all {
    status == "active",
    status' = "paused",
    runs' = if (STOP_ON_PAUSE) stopLive(runs) else runs, g' = g,
  }

  action Archive = all {
    status != "archived",
    status' = "archived",
    runs' = if (STOP_ON_PAUSE) stopLive(runs) else runs, g' = g,
  }

  action Resume = all { status == "paused", status' = "active", runs' = runs, g' = g }

  action Unarchive = all { status == "archived", status' = "paused", runs' = runs, g' = g }

  action init = all {
    status' = "active",
    runs' = List(),
    g' = { spawns: List(), reports: List(), startWhenOff: false, postWhenOff: false },
    act' = "init",
  }

  action fire(s: int): bool = all { Fire(s), act' = "Fire" }
  action start(s: int): bool = all { Start(s), act' = "Start" }
  action finish(s: int): bool = all { Finish(s), act' = "Finish" }
  action report(s: int): bool = all { Report(s), act' = "Report" }
  action pause = all { Pause, act' = "Pause" }
  action archive = all { Archive, act' = "Archive" }
  action resume = all { Resume, act' = "Resume" }
  action unarchive = all { Unarchive, act' = "Unarchive" }

  action step = any {
    { nondet s = SLOTS.oneOf() fire(s) },
    { nondet s = SLOTS.oneOf() start(s) },
    { nondet s = SLOTS.oneOf() finish(s) },
    { nondet s = SLOTS.oneOf() report(s) },
    pause, archive, resume, unarchive,
  }

  // ---------------- invariants ----------------

  pure def count(l: List[int], s: int): int = l.select(x => x == s).length()

  val OneRunPerSlot = SLOTS.forall(s => count(g.spawns, s) <= 1 and count(g.reports, s) <= 1)
  val NoOverlap = runs.select(r => isLive(r)).length() <= 1
  val NothingAfterPause = not(g.startWhenOff) and not(g.postWhenOff)

  val Design = OneRunPerSlot and NoOverlap and NothingAfterPause

  // ---------------- replays ----------------

  // The same slot is fired twice (alarm redelivery).
  run seqDuplicate = init.then(fire(1)).then(fire(1))
  // The next slot fires while the first run is still working.
  run seqOverlap = init.then(fire(1)).then(start(1)).then(fire(2))
  // A fire that was already in flight lands after pause.
  run seqFireAfterPause = init.then(pause).then(fire(1))
  // Paused while the run is queued; then the task starts.
  run seqStartAfterPause = init.then(fire(1)).then(pause)
  // The run finished, then the automation was paused before the Reporter posted.
  run seqPostAfterPause = init.then(fire(1)).then(start(1)).then(finish(1)).then(pause).then(report(1))
  // Duplicate fire after the first run is done: still one run, one report.
  run seqLateDuplicate = init.then(fire(1)).then(start(1)).then(finish(1)).then(report(1)).then(fire(1))
}

module design {
  import automations(KEYED_SPAWN = true, SKIP_IF_LIVE = true, CHECK_ON_FIRE = true,
                     STOP_ON_PAUSE = true, CHECK_BEFORE_POST = true).*
  run duplicateTest = seqDuplicate.expect(Design and runs.length() == 1)
  run overlapTest = seqOverlap.expect(Design and runs.length() == 1)
  run fireAfterPauseTest = seqFireAfterPause.expect(Design and runs.length() == 0)
  run startAfterPauseTest = seqStartAfterPause.then(start(1).fail())   // stopped: nothing to start
  run postAfterPauseTest = seqPostAfterPause.expect(Design and g.reports.length() == 0)
  run lateDuplicateTest = seqLateDuplicate.expect(Design and runs.length() == 1 and g.reports.length() == 1)
}

module naive {
  import automations(KEYED_SPAWN = false, SKIP_IF_LIVE = false, CHECK_ON_FIRE = false,
                     STOP_ON_PAUSE = false, CHECK_BEFORE_POST = false).*
  run duplicateTest = seqDuplicate.expect(not(OneRunPerSlot))
  run overlapTest = seqOverlap.expect(not(NoOverlap))
  run fireAfterPauseTest = seqFireAfterPause.expect(not(NothingAfterPause))
  run startAfterPauseTest = seqStartAfterPause.then(start(1)).expect(not(NothingAfterPause))
  run postAfterPauseTest = seqPostAfterPause.expect(not(NothingAfterPause))
  run lateDuplicateTest = seqLateDuplicate.then(start(1)).then(finish(1)).then(report(1)).expect(not(OneRunPerSlot))
}

// Ablations: the design with exactly one rule off.
module no_keyed_spawn { import automations(KEYED_SPAWN = false, SKIP_IF_LIVE = true, CHECK_ON_FIRE = true, STOP_ON_PAUSE = true, CHECK_BEFORE_POST = true).* }
module no_skip_if_live { import automations(KEYED_SPAWN = true, SKIP_IF_LIVE = false, CHECK_ON_FIRE = true, STOP_ON_PAUSE = true, CHECK_BEFORE_POST = true).* }
module no_check_on_fire { import automations(KEYED_SPAWN = true, SKIP_IF_LIVE = true, CHECK_ON_FIRE = false, STOP_ON_PAUSE = true, CHECK_BEFORE_POST = true).* }
module no_stop_on_pause { import automations(KEYED_SPAWN = true, SKIP_IF_LIVE = true, CHECK_ON_FIRE = true, STOP_ON_PAUSE = false, CHECK_BEFORE_POST = true).* }
module no_check_before_post { import automations(KEYED_SPAWN = true, SKIP_IF_LIVE = true, CHECK_ON_FIRE = true, STOP_ON_PAUSE = true, CHECK_BEFORE_POST = false).* }
