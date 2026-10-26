import type { DatabaseSync } from "node:sqlite";
import { MailBox, type MailDesk, mailApprove, mailDisallow, mailDiscard, mailExtension, mailView, readMail, receive } from "../../../src/mail/wiring";
import { storageOf } from "../skills/storage";
import type { Deps, Side } from "./legacy";

export function portOf(db: DatabaseSync, deps: Deps, chat: (session: string) => boolean): Side {
  const desk: MailDesk = {
    box: new MailBox(storageOf(db)),
    get boundary() {
      return deps.boundary;
    },
    limits: deps.limits,
    owners: deps.owners,
    tell: deps.tell,
    triage: deps.triage
  };

  return {
    readMail: (raw, envelope) => readMail(raw, envelope),
    receive: (mail) => receive(desk, mail),
    approve: (id) => mailApprove(desk, id),
    discard: (id) => mailDiscard(desk, id),
    disallow: (address) => mailDisallow(desk, address),
    view: () => mailView(desk),
    recent: (limit) => desk.box.recent(limit),
    extension: mailExtension(desk, chat)
  };
}
