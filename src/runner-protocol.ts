import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * The machine protocol: what MachineHub (src/machines.ts) and ky-runner
 * (runner/) say to each other over the runner's WebSocket. Both ends import
 * this file and decode every frame they receive with it, so a frame either
 * matches these schemas or is not acted on.
 *
 * The runner ships with the worker: bump PROTOCOL on any change, and the
 * object refuses a runner that says another one.
 */

export const PROTOCOL = 1;

const Seq = Type.Integer({ minimum: 1 });

/**
 * A task's turn: 1 for its run, one more for each message sent to it. A
 * report names the turn it ends or speaks for, and the object drops a report
 * for a turn it has already closed.
 */
const Turn = Type.Integer({ minimum: 1 });

const Text = Type.String();

const Session = Type.Union([Type.String(), Type.Null()]);

/** Object → runner: start a task's turn, or steer the session that runs it. */
const RunCommandSchema = Type.Object({
  type: Type.Literal("run"),
  seq: Seq,
  task: Text,
  turn: Turn,
  prompt: Text,
  /** The Claude Code session to resume, once the first turn named one. */
  session: Session
});

/** Object → runner: stop the task's session; `turn` is its latest. */
const StopCommandSchema = Type.Object({
  type: Type.Literal("stop"),
  seq: Seq,
  task: Text,
  turn: Turn
});

const RunnerCommandSchema = Type.Union([RunCommandSchema, StopCommandSchema]);

/** Runner → object. `active` lists the tasks with a live session. */
const HelloSchema = Type.Object({
  type: Type.Literal("hello"),
  protocol: Type.Literal(PROTOCOL),
  active: Type.Array(Text)
});

const RunnerReportSchema = Type.Union([
  HelloSchema,
  Type.Object({ type: Type.Literal("ack"), seq: Seq }),
  Type.Object({ type: Type.Literal("session"), task: Text, turn: Turn, session: Text }),
  Type.Object({ type: Type.Literal("progress"), task: Text, turn: Turn, text: Text }),
  /** The end of every turn up to `turn`. */
  Type.Object({
    type: Type.Literal("result"),
    task: Text,
    turn: Turn,
    ok: Type.Boolean(),
    text: Text,
    session: Session
  })
]);

export type RunnerCommand = Static<typeof RunnerCommandSchema>;

export type RunnerReport = Static<typeof RunnerReportSchema>;

/** A command before the inbox numbers it. */
export type UnnumberedCommand = RunnerCommand extends infer C ? (C extends unknown ? Omit<C, "seq"> : never) : never;

/** The frame `text` holds if it is JSON that matches `schema`, else undefined. */
function decode<const S extends TSchema>(schema: S, text: string): Static<S> | undefined {
  let frame;

  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }

  return Value.Check(schema, frame) ? frame : undefined;
}

/** A frame the object sent, or undefined if it is not a command (the Agents SDK's own frames). */
export function decodeCommand(text: string): RunnerCommand | undefined {
  return decode(RunnerCommandSchema, text);
}

/** A frame a runner sent, or undefined if it is malformed or another protocol. */
export function decodeReport(text: string): RunnerReport | undefined {
  return decode(RunnerReportSchema, text);
}
