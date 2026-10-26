import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export const MAIL_TABLES = { mail: "ky_mail", allowed: "ky_mail_allowed", expect: "ky_mail_expect" } as const;

export const MAIL_BYTES = 2_000_000;

export const NOTHING_NEW = "NOTHING_NEW";

export type MailLimits = { readonly dailySends: number; readonly hourlyTriages: number };

function cap(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return value?.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function mailLimits(vars: { readonly KY_MAIL_DAILY_SENDS?: string; readonly KY_MAIL_HOURLY_TRIAGES?: string }): MailLimits {
  return { dailySends: cap(vars.KY_MAIL_DAILY_SENDS, 50), hourlyTriages: cap(vars.KY_MAIL_HOURLY_TRIAGES, 20) };
}

export function addressOf(text: string): string {
  return (/<([^>]+)>/.exec(text)?.[1] ?? text).trim().toLowerCase();
}

export const InboundMail = Schema.Struct({
  messageId: Schema.String,
  from: Schema.String,
  fromName: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  answers: Schema.Array(Schema.String),
  at: Schema.Number
});

export type InboundMail = typeof InboundMail.Type;

export type MailBoundary = {
  readonly address: string;
  readonly send: (message: EmailMessageBuilder) => Promise<EmailSendResult>;
};

export const MailRow = Schema.Struct({
  id: Schema.String,
  direction: Schema.Literals(["in", "out"]),
  message_id: Schema.NullOr(Schema.String),
  answers: Schema.NullOr(Schema.String),
  party: Schema.String,
  party_name: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["new", "triaged", "kept", "held", "discarded", "sending", "sent", "failed"]),
  session: Schema.String,
  note: Schema.String,
  at: Schema.Number
});

export type MailRow = typeof MailRow.Type;

export const NOT_SET_UP = "ky has no address yet: the user sets it up in Settings › Mail.";

export class NotSetUp extends Schema.TaggedError<NotSetUp>()("NotSetUp", {}) implements Refusable {
  get refusal(): string {
    return NOT_SET_UP;
  }
}

export class DailyCap extends Schema.TaggedError<DailyCap>()("DailyCap", { dailySends: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `ky sent ${this.dailySends} mails today, its most; try tomorrow.`;
  }
}

export class ServiceRefused extends Schema.TaggedError<ServiceRefused>()("ServiceRefused", { why: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Email Service refused it: ${this.why}`;
  }
}

export class NotWaiting extends Schema.TaggedError<NotWaiting>()("NotWaiting", {}) implements Refusable {
  get refusal(): string {
    return "That mail isn't waiting any more.";
  }
}

export class NotAllowed extends Schema.TaggedError<NotAllowed>()("NotAllowed", { address: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.address} isn't allowed.`;
  }
}

export class NotAnAddress extends Schema.TaggedError<NotAnAddress>()("NotAnAddress", { to: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.to} isn't one email address.`;
  }
}

export class EmptyMail extends Schema.TaggedError<EmptyMail>()("EmptyMail", {}) implements Refusable {
  get refusal(): string {
    return "A mail needs a subject and some text.";
  }
}

export class MailTooLong extends Schema.TaggedError<MailTooLong>()("MailTooLong", { most: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `A mail is at most ${this.most} characters.`;
  }
}

export class NoInbound extends Schema.TaggedError<NoInbound>()("NoInbound", { id: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No mail ${this.id} came to ky.`;
  }
}

export class NoMail extends Schema.TaggedError<NoMail>()("NoMail", { id: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No mail ${this.id}.`;
  }
}

export class NoSender extends Schema.TaggedError<NoSender>()("NoSender", {}) implements Refusable {
  get refusal(): string {
    return "expect needs from: an address, or a domain like github.com.";
  }
}
