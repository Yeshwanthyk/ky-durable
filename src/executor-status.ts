/**
 * How an Executor result says it paused for the user: model mode answers a
 * call that needs approval or input with `status: "approval-required"` or
 * `"input-required"`. Its own module, so callers like automation gates need
 * nothing else of Executor's client.
 */

/** Whether a program's result paused for the user, which an unattended caller can never answer. */
export function pausedForUser(text: string): boolean {
  return /"status"\s*:\s*"(approval|input)-required"/.test(text);
}
