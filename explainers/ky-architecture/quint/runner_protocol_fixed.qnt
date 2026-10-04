// The machine protocol with the minimal fixes switched on, plus one
// ablation per fix (that fix off, the rest on) to show each is needed.
// The model itself lives in runner_protocol.qnt.

module fixed {
  import runner(FLUSH_FIRST = true, FENCED = true, DURABLE_HANDLED = true,
                SAFE_STOP = true, RECONCILE = true, ORDERED_DELIVERY = true).* from "./runner_protocol"

  // The five counterexample schedules from `current` are safe here.
  run stopRaceTest = seqStopRace.expect(Safety)
  run helloBeforeOutboxTest = seqHelloBeforeOutbox.expect(Safety and srv.status == "done")
  run dupExecTest = seqDupExec.expect(Safety)
  run steerIntoStopTest = seqSteerIntoStop.expect(Safety and rn.job.next == 2)
  run stuckQueuedTest = seqStuckQueued.expect(Safety and srv.status == "failed")
  run reorderTest = seqReorder.expect(Safety)
}

module no_flush_first {
  import runner(FLUSH_FIRST = false, FENCED = true, DURABLE_HANDLED = true,
                SAFE_STOP = true, RECONCILE = true, ORDERED_DELIVERY = true).* from "./runner_protocol"
  // Fencing keeps one report, but the wrong one: "interrupted" wins and
  // the real "done" result is dropped as stale.
  run helloBeforeOutboxTest = seqHelloBeforeOutbox.expect(not(NoFalseInterrupt) and srv.status == "failed")
}

module no_fence {
  import runner(FLUSH_FIRST = true, FENCED = false, DURABLE_HANDLED = true,
                SAFE_STOP = true, RECONCILE = true, ORDERED_DELIVERY = true).* from "./runner_protocol"
}

module no_durable_handled {
  import runner(FLUSH_FIRST = true, FENCED = true, DURABLE_HANDLED = false,
                SAFE_STOP = true, RECONCILE = true, ORDERED_DELIVERY = true).* from "./runner_protocol"
  run dupExecTest = seqDupExec.expect(not(NoDuplicateExecution))
}

module no_safe_stop {
  import runner(FLUSH_FIRST = true, FENCED = true, DURABLE_HANDLED = true,
                SAFE_STOP = false, RECONCILE = true, ORDERED_DELIVERY = true).* from "./runner_protocol"
  run stopRaceTest = seqStopRace.expect(not(NoRunAfterStoppedReport))
  run steerIntoStopTest = seqSteerIntoStop.expect(not(NoSteerIntoStoppedRun))
}

module no_reconcile {
  import runner(FLUSH_FIRST = true, FENCED = true, DURABLE_HANDLED = true,
                SAFE_STOP = true, RECONCILE = false, ORDERED_DELIVERY = true).* from "./runner_protocol"
  run stuckQueuedTest = seqStuckQueued.expect(not(QuiescentRecoverable))
}

module no_ordered_delivery {
  import runner(FLUSH_FIRST = true, FENCED = true, DURABLE_HANDLED = true,
                SAFE_STOP = true, RECONCILE = true, ORDERED_DELIVERY = false).* from "./runner_protocol"
  run reorderTest = seqReorder.expect(not(NoOutOfOrderExecution))
}
