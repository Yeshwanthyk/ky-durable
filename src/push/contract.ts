import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export { base64url, fromBase64url, vapidToken } from "./webpush";

export const PUSH_TABLES = Object.freeze({ devices: "ky_push_devices", sent: "ky_push_sent" } as const);

export const PushDevice = Schema.Struct({ endpoint: Schema.String, p256dh: Schema.String, auth: Schema.String });

export type PushDevice = typeof PushDevice.Type;

const REFUSALS = {
  endpoint: "A push endpoint is an https address.",
  keys: "A push subscription's keys aren't a P-256 key and a 16-byte secret."
} as const;

export class BadSubscription extends Schema.TaggedError<BadSubscription>()("BadSubscription", { problem: Schema.Literals(["endpoint", "keys"]) }) implements Refusable {
  get refusal(): string {
    return REFUSALS[this.problem];
  }
}
