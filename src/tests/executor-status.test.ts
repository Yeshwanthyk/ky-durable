import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { programOutcome } from "../executor-status";

/** `execute`'s answer as the real Executor sends it. */
const envelope = (execution: { ok: boolean; value?: JsonValue; error?: JsonValue }, status = "completed") =>
  JSON.stringify({ status, execution: { toolCalls: [{ path: "gmail.search" }], ...execution }, unavailableApps: [] });

/** What a program came to is read from inside Executor's envelope, never from the envelope itself. */
describe("an Executor program's outcome", () => {
  it("is the program's return value, null and undefined included", () => {
    expect(programOutcome(envelope({ ok: true, value: null }))).toEqual({ kind: "returned", value: null });
    expect(programOutcome(envelope({ ok: true }))).toEqual({ kind: "returned", value: undefined });
    expect(programOutcome(envelope({ ok: true, value: [] }))).toEqual({ kind: "returned", value: [] });
    expect(programOutcome(envelope({ ok: true, value: [{ subject: "Trip form" }] }))).toEqual({ kind: "returned", value: [{ subject: "Trip form" }] });
  });

  it("is a failure when the program failed, with what it threw", () => {
    expect(programOutcome(envelope({ ok: false, error: "no tool gmail.search" }))).toEqual({ kind: "failed", text: "no tool gmail.search" });
    expect(programOutcome(envelope({ ok: false, error: { message: "rate limited" } }))).toEqual({ kind: "failed", text: "rate limited" });
    expect(programOutcome(envelope({ ok: false }))).toEqual({ kind: "failed", text: "the program failed" });
  });

  it("is paused when Executor asks for an approval or input", () => {
    expect(programOutcome(JSON.stringify({ status: "approval-required", requestId: "r1", message: "send mail" }))).toEqual({ kind: "paused" });
    expect(programOutcome(JSON.stringify({ status: "input-required", requestId: "r2" }))).toEqual({ kind: "paused" });
  });

  it("is a failure for a status other than completed, or an answer that isn't the envelope", () => {
    expect(programOutcome(envelope({ ok: true, value: 1 }, "cancelled"))).toEqual({ kind: "failed", text: "Executor said cancelled" });
    expect(programOutcome("null")).toEqual({ kind: "failed", text: "Executor answered something ky can't read: null" });
    expect(programOutcome('{"value":[1]}')).toEqual({ kind: "failed", text: 'Executor answered something ky can\'t read: {"value":[1]}' });
  });
});
