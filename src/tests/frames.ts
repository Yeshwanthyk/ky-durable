import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DreamLedgerRow } from "../dreaming/contract";
import type { PiServerMessage } from "../protocol";
import { ServerFrameSchema } from "../server-frames.ts";

/**
 * Decoders for what ky sends over the browser's socket, shared by the worker
 * e2e tests, the CLI harness and the Playwright suite. The frames' schemas are
 * the page's own (src/server-frames.ts). The runner's socket decodes with
 * src/machines/runner-protocol.ts, as both its ends do.
 */

/** JSON text as a value, or undefined when it is not JSON. Check the value with a schema before use. */
export function parsed(data: string): JsonValue | undefined {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** A frame for the browser's socket; undefined for anything else, like the agents SDK's own frames. */
export function decodeServerFrame(data: string): PiServerMessage | undefined {
  const value = parsed(data);

  return Value.Check(ServerFrameSchema, value) ? value : undefined;
}

const NewChat = Type.Object({ session: Type.String() });

/** The session a `new-chat` command's result names; undefined if it names none. */
export function decodeNewChat(result: JsonValue): string | undefined {
  return Value.Check(NewChat, result) ? result.session : undefined;
}

const Versions = Type.Array(Type.Object({ id: Type.Number(), action: Type.String(), actor: Type.String() }));

/** The version ids a `skill-history` command's result lists, newest first. */
export function decodeSkillVersions(result: JsonValue): number[] {
  return Value.Check(Versions, result) ? result.map((each) => each.id) : [];
}

/** A dream-ledger answer's rows; empty when it is not one. */
export function decodeDreamLedger(value: JsonValue): DreamLedgerRow[] {
  const rows = Type.Array(DreamLedgerRow);

  return Value.Check(rows, value) ? value : [];
}
