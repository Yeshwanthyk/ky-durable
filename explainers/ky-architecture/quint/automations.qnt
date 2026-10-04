// FUTURE: recurring automations driven by one DO alarm. One automation with
// a fixed interval I; slot s is due at time s*I. A fire commits, in one SQL
// transaction, the slot ledger (run | skipped), a run row (pending) and the
// next alarm. The run is then spawned (a cloud subagent task or a node job),
// finishes, and its result is posted to the main chat with harness.submit.
module automations {
  // Fire records slots it did not run as skipped and runs only the latest
  // due slot; naive: run "now", next = now + I, missed slots vanish.
  const COALESCE: bool
  // A fire only creates a row for a slot >= next_slot (UNIQUE (id, slot));
  // naive: a re-fired alarm inserts a second run for the same slot.
  const DEDUPE_SLOT: bool
  // A due slot while a run is still in flight is recorded skipped(overlap).
  const NO_OVERLAP: bool
  // Spawn re-reads the row: disabled/deleted => the pending run is skipped.
  const RECHECK_ON_START: bool
  // Delete cancels pending/running runs and suppresses their posts.
  const CANCEL_ON_DELETE: bool
  // On DO start, pending rows get a spawn continuation again.
  const RECOVERY_SCAN: bool
  // The run task id is automation:<id>:<slot>, so a second spawn is a no-op.
  const KEYED_SPAWN: bool
  // harness.submit operationId = automation:<id>:<slot> (vs random).
  const STABLE_OPID: bool

  pure val I = 2
  pure val MAXT = 8
  pure val MAX_RESTART = 2
  pure val SLOTS = 1.to(MAXT / I)

  type Row = { slot: int, state: str, posted: bool }  // pending | running | finished | cancelled | skipped
  type Auto = { exists: bool, enabled: bool, nextSlot: int }
  type Alarm = { armed: bool, at: int, lastFire: int, refires: int }
  type Ghost = { spawns: List[int], posts: List[int],
                 startWhenOff: bool, postAfterDelete: bool, overlapped: bool }

  var clock: int
  var auto: Auto
  var alarm: Alarm
  var rows: List[Row]
  var ledger: int -> str            // slot -> "run" | "skipped:*"
  var cont: Set[int]                // in-memory spawn continuations (lost on restart)
  var restarts: int
  var g: Ghost
  var act: str

  pure def imax(a: int, b: int): int = if (a > b) a else b
  pure def inflight(rs: List[Row]): bool =
    rs.select(r => r.state == "pending" or r.state == "running").length() > 0
  pure def recordRange(l: int -> str, lo: int, hi: int, why: str): int -> str =
    // record slots lo..hi-1 that have no record yet
    SLOTS.fold(l, (acc, s) => if (s >= lo and s < hi and not(acc.keys().contains(s))) acc.put(s, why) else acc)

  // ---------------- alarm ----------------

  pure def fire(a: Auto, rs: List[Row], l: int -> str, now: int):
      { a: Auto, rs: List[Row], l: int -> str, c: Set[int], next: int } =
    val latest = now / I
    if (not(a.exists) or not(a.enabled) or latest < 1)
      { a: a, rs: rs, l: l, c: Set(), next: -1 }
    else if (DEDUPE_SLOT and latest < a.nextSlot)
      // already handled (a re-fire): just re-arm
      { a: a, rs: rs, l: l, c: Set(), next: a.nextSlot * I }
    else {
      val l1 = if (COALESCE) recordRange(l, a.nextSlot, latest, "skipped:missed") else l
      val busy = NO_OVERLAP and inflight(rs)
      val l2 = l1.put(latest, if (busy) "skipped:overlap" else "run")
      val rs2 = if (busy) rs else rs.append({ slot: latest, state: "pending", posted: false })
      { a: { ...a, nextSlot: latest + 1 }, rs: rs2, l: l2,
        c: if (busy) Set() else Set(latest), next: (latest + 1) * I }
    }

  // The DO alarm runs (possibly late).
  action AlarmFire = all {
    alarm.armed, clock >= alarm.at,
    val f = fire(auto, rows, ledger, clock)
    all {
      auto' = f.a, rows' = f.rs, ledger' = f.l, cont' = cont.union(f.c),
      alarm' = { ...alarm, armed: f.next >= 0, at: imax(f.next, 0), lastFire: clock },
      clock' = clock, restarts' = restarts, g' = g,
    },
  }

  // At-least-once: the same alarm invocation is delivered again.
  action AlarmRefire = all {
    alarm.lastFire >= 0, alarm.refires < 1,
    val f = fire(auto, rows, ledger, alarm.lastFire)
    all {
      auto' = f.a, rows' = f.rs, ledger' = f.l, cont' = cont.union(f.c),
      alarm' = { ...alarm, refires: alarm.refires + 1 },
      clock' = clock, restarts' = restarts, g' = g,
    },
  }

  // ---------------- runs ----------------

  // Spawn the run for a pending row. markRunning = false: the DO was evicted
  // between spawning the task and marking the row running.
  action Spawn(s: int, markRunning: bool): bool = all {
    cont.contains(s),
    rows.select(r => r.slot == s and r.state == "pending").length() > 0,
    val off = not(auto.exists) or not(auto.enabled)
    if (RECHECK_ON_START and off)
      all { rows' = rows.foldl(List(), (l, r) => l.append(if (r.slot == s and r.state == "pending") { ...r, state: "skipped" } else r)),
            ledger' = ledger.put(s, "skipped:disabled"), cont' = cont.exclude(Set(s)),
            auto' = auto, alarm' = alarm, clock' = clock, restarts' = restarts, g' = g }
    else {
      val already = KEYED_SPAWN and g.spawns.indices().exists(i => g.spawns[i] == s)
      // mark exactly one pending row of this slot running
      val marked = rows.foldl({ l: List(), done: false }, (acc, r) =>
        if (not(acc.done) and r.slot == s and r.state == "pending") { l: acc.l.append({ ...r, state: "running" }), done: true }
        else { l: acc.l.append(r), done: acc.done })
      val morePending = rows.select(r => r.slot == s and r.state == "pending").length() > 1
      all {
        rows' = if (markRunning) marked.l else rows,
        cont' = if (markRunning and not(morePending)) cont.exclude(Set(s)) else cont,
        g' = if (already) g else { ...g, spawns: g.spawns.append(s), startWhenOff: g.startWhenOff or off,
                                    overlapped: g.overlapped or rows.select(r => r.state == "running").length() > 0 },
        auto' = auto, alarm' = alarm, ledger' = ledger, clock' = clock, restarts' = restarts,
      }
    }
  }

  // The run finishes (ok / failed / target machine offline: all are posted).
  action Finish(s: int): bool = all {
    rows.select(r => r.slot == s and r.state == "running").length() > 0,
    rows' = rows.foldl(List(), (l, r) => l.append(if (r.slot == s and r.state == "running") { ...r, state: "finished" } else r)),
    auto' = auto, alarm' = alarm, ledger' = ledger, cont' = cont, clock' = clock, restarts' = restarts, g' = g,
  }

  // harness.submit; markPosted = false: evicted before the row was marked.
  action Post(s: int, markPosted: bool): bool = all {
    rows.select(r => r.slot == s and r.state == "finished" and not(r.posted)).length() > 0,
    // operationId automation:<id>:<slot> is deduped by the harness; a random one is not
    val fresh = not(STABLE_OPID) or not(g.posts.indices().exists(i => g.posts[i] == s))
    all {
      rows' = if (markPosted) rows.foldl(List(), (l, r) => l.append(if (r.slot == s and r.state == "finished") { ...r, posted: true } else r)) else rows,
      g' = if (fresh) { ...g, posts: g.posts.append(s),
                        postAfterDelete: g.postAfterDelete or not(auto.exists) } else g,
      auto' = auto, alarm' = alarm, ledger' = ledger, cont' = cont, clock' = clock, restarts' = restarts,
    }
  }

  // ---------------- user ----------------

  action Disable = all {
    auto.exists, auto.enabled,
    auto' = { ...auto, enabled: false },
    alarm' = alarm, rows' = rows, ledger' = ledger, cont' = cont, clock' = clock, restarts' = restarts, g' = g,
  }

  // Re-enable: slots that passed while disabled are recorded, not run.
  action Enable = all {
    auto.exists, not(auto.enabled),
    val nxt = imax(auto.nextSlot, (clock + I - 1) / I)
    all {
      auto' = { ...auto, enabled: true, nextSlot: nxt },
      ledger' = if (COALESCE) recordRange(ledger, auto.nextSlot, nxt, "skipped:disabled") else ledger,
      alarm' = { ...alarm, armed: true, at: nxt * I },
      rows' = rows, cont' = cont, clock' = clock, restarts' = restarts, g' = g,
    },
  }

  action Delete = all {
    auto.exists,
    auto' = { ...auto, exists: false, enabled: false },
    rows' = if (CANCEL_ON_DELETE)
              rows.foldl(List(), (l, r) => l.append(if (r.state == "pending" or r.state == "running" or (r.state == "finished" and not(r.posted))) { ...r, state: "cancelled" } else r))
            else rows,
    alarm' = alarm, ledger' = ledger, cont' = cont, clock' = clock, restarts' = restarts, g' = g,
  }

  // ---------------- DO lifecycle / time ----------------

  // Eviction + restart: the alarm and SQL survive, continuations do not.
  action Restart = all {
    restarts < MAX_RESTART,
    cont' = if (RECOVERY_SCAN) rows.foldl(Set(), (acc, r) => if (r.state == "pending") acc.union(Set(r.slot)) else acc) else Set(),
    restarts' = restarts + 1,
    auto' = auto, alarm' = alarm, rows' = rows, ledger' = ledger, clock' = clock, g' = g,
  }

  action Tick = all {
    clock < MAXT,
    clock' = clock + 1,
    auto' = auto, alarm' = alarm, rows' = rows, ledger' = ledger, cont' = cont, restarts' = restarts, g' = g,
  }

  action init = all {
    clock' = 0,
    auto' = { exists: true, enabled: true, nextSlot: 1 },
    alarm' = { armed: true, at: I, lastFire: -1, refires: 0 },
    rows' = List(), ledger' = Map(), cont' = Set(), restarts' = 0,
    g' = { spawns: List(), posts: List(), startWhenOff: false, postAfterDelete: false, overlapped: false },
    act' = "init",
  }

  action alarmFire = all { AlarmFire, act' = "AlarmFire" }
  action alarmRefire = all { AlarmRefire, act' = "AlarmRefire" }
  action spawn(s: int, k: bool): bool = all { Spawn(s, k), act' = if (k) "Spawn" else "Spawn(evicted before marking)" }
  action finish(s: int): bool = all { Finish(s), act' = "Finish" }
  action post(s: int, k: bool): bool = all { Post(s, k), act' = if (k) "Post" else "Post(evicted before marking)" }
  action disable = all { Disable, act' = "Disable" }
  action enable = all { Enable, act' = "Enable" }
  action delete = all { Delete, act' = "Delete" }
  action restart = all { Restart, act' = "Restart(DO)" }
  action tick = all { Tick, act' = "Tick" }

  action step = any {
    alarmFire, alarmRefire,
    { nondet s = SLOTS.oneOf() nondet k = Set(true, false).oneOf() spawn(s, k) },
    { nondet s = SLOTS.oneOf() finish(s) },
    { nondet s = SLOTS.oneOf() nondet k = Set(true, false).oneOf() post(s, k) },
    disable, enable, delete, restart, tick,
  }

  // ---------------- invariants ----------------

  pure def count(l: List[int], s: int): int = l.select(x => x == s).length()

  val AtMostOneRunPerSlot = SLOTS.forall(s => count(g.spawns, s) <= 1)
  val AtMostOnePostPerRun = SLOTS.forall(s => count(g.posts, s) <= 1)
  // No run starts while the automation is disabled or deleted (a run that
  // started before keeps going; see NoPostAfterDelete for delete).
  val NoStartAfterDisableOrDelete = not(g.startWhenOff)
  val NoPostAfterDelete = not(g.postAfterDelete)
  // Every slot before next_slot has a ledger entry (run or skipped:why).
  val NoLostSlotWithoutRecord = SLOTS.forall(s => s < auto.nextSlot implies ledger.keys().contains(s))
  // Every pending row has a spawn continuation (else it is stranded forever).
  val NoStrandedRun = rows.select(r => r.state == "pending").foldl(true, (ok, r) => ok and cont.contains(r.slot))
  val NoOverlap = not(g.overlapped)
  // The ledger says "run" for every slot that has a live or finished run row.
  val LedgerMatchesRows = rows.foldl(true, (ok, r) =>
    ok and (Set("pending", "running", "finished").contains(r.state) implies ledger.get(r.slot) == "run"))

  val Design = AtMostOneRunPerSlot and AtMostOnePostPerRun and NoStartAfterDisableOrDelete and
               NoPostAfterDelete and NoLostSlotWithoutRecord and NoStrandedRun and NoOverlap and
               LedgerMatchesRows

  // ---------------- replays ----------------

  // A1: the alarm invocation is delivered twice.
  run seqRefire = init.then(tick).then(tick).then(alarmFire).then(alarmRefire)
    .then(spawn(1, true)).then(spawn(1, true))
  // A2: the DO was asleep for 3 intervals; the alarm fires late.
  run seqLate = init.then(tick).then(tick).then(tick).then(tick).then(tick).then(tick).then(alarmFire)
  // A3: disabled after the fire committed, before the spawn.
  run seqDisableRace = init.then(tick).then(tick).then(alarmFire).then(disable).then(spawn(1, true))
  // A4: deleted while running (then: finish + post).
  run seqDeleteInFlight = init.then(tick).then(tick).then(alarmFire).then(spawn(1, true))
    .then(delete)
  // A5: evicted between commit and spawn.
  run seqStranded = init.then(tick).then(tick).then(alarmFire).then(restart)
  // A6: the run takes longer than the interval.
  run seqOverlap = init.then(tick).then(tick).then(alarmFire).then(spawn(1, true))
    .then(tick).then(tick).then(alarmFire).then(spawn(2, true))
  // A7: spawned, evicted before marking running; recovery spawns again.
  run seqDoubleSpawn = init.then(tick).then(tick).then(alarmFire).then(spawn(1, false))
    .then(restart).then(spawn(1, true))
  // A8: posted, evicted before marking posted; posted again.
  run seqDoublePost = init.then(tick).then(tick).then(alarmFire).then(spawn(1, true)).then(finish(1))
    .then(post(1, false)).then(post(1, true))
}

module design {
  import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true,
                     CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = true).*
  run refireTest = seqRefire.fail()        // only one row: the second spawn is not enabled
  run lateTest = seqLate.expect(Design and ledger.get(1) == "skipped:missed" and ledger.get(2) == "skipped:missed" and ledger.get(3) == "run")
  run disableRaceTest = seqDisableRace.expect(Design and ledger.get(1) == "skipped:disabled")
  run deleteInFlightTest = seqDeleteInFlight.then(finish(1).fail()) // cancelled: it cannot finish/post
  run strandedTest = seqStranded.expect(Design)
  run overlapTest = seqOverlap.fail()      // slot 2 skipped(overlap): no row to spawn
  run doubleSpawnTest = seqDoubleSpawn.expect(Design)
  run doublePostTest = seqDoublePost.expect(Design)
}

module naive {
  import automations(COALESCE = false, DEDUPE_SLOT = false, NO_OVERLAP = false, RECHECK_ON_START = false,
                     CANCEL_ON_DELETE = false, RECOVERY_SCAN = false, KEYED_SPAWN = false, STABLE_OPID = false).*
  run refireTest = seqRefire.expect(not(AtMostOneRunPerSlot))
  run lateTest = seqLate.expect(not(NoLostSlotWithoutRecord))
  run disableRaceTest = seqDisableRace.expect(not(NoStartAfterDisableOrDelete))
  run deleteInFlightTest = seqDeleteInFlight.then(finish(1)).then(post(1, true)).expect(not(NoPostAfterDelete))
  run strandedTest = seqStranded.expect(not(NoStrandedRun))
  run overlapTest = seqOverlap.expect(not(NoOverlap))
  run doublePostTest = seqDoublePost.expect(not(AtMostOnePostPerRun))
}

// recovery scan without keyed spawn: crash between spawn and mark => two runs
module scan_unkeyed {
  import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true,
                     CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = false, STABLE_OPID = true).*
  run doubleSpawnTest = seqDoubleSpawn.expect(not(AtMostOneRunPerSlot))
}

// Ablations: the design with exactly one rule off.
module no_coalesce { import automations(COALESCE = false, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true, CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = true).* }
module no_dedupe_slot { import automations(COALESCE = true, DEDUPE_SLOT = false, NO_OVERLAP = true, RECHECK_ON_START = true, CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = true).* }
module no_no_overlap { import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = false, RECHECK_ON_START = true, CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = true).* }
module no_recheck_on_start { import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = false, CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = true).* }
module no_cancel_on_delete { import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true, CANCEL_ON_DELETE = false, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = true).* }
module no_recovery_scan { import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true, CANCEL_ON_DELETE = true, RECOVERY_SCAN = false, KEYED_SPAWN = true, STABLE_OPID = true).* }
module no_keyed_spawn { import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true, CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = false, STABLE_OPID = true).* }
module no_stable_opid { import automations(COALESCE = true, DEDUPE_SLOT = true, NO_OVERLAP = true, RECHECK_ON_START = true, CANCEL_ON_DELETE = true, RECOVERY_SCAN = true, KEYED_SPAWN = true, STABLE_OPID = false).* }
