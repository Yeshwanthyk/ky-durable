import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, HookApi, ToolExecutionApi, ToolHookCall, ToolHooks } from "@earendil-works/pi-durable";
import type { DatabaseSync } from "node:sqlite";
import type { InboundMail } from "../../../src/mail/contract";
import { MailBox, type MailDesk, mailApprove, mailDisallow, mailDiscard, mailExtension, mailView, readMail, receive } from "../../../src/mail/wiring";
import type { MailView } from "../../../src/protocol";
import { storageOf } from "../skills/storage";

export type Deps = Omit<MailDesk, "box">;

export type Answer = { readonly refused: string } | Record<string, never>;

export type Row = { readonly id: string };

export interface Side {
  readMail(raw: string, envelope: { from: string; to: string }): Promise<InboundMail>;
  receive(mail: InboundMail): Promise<void>;
  approve(id: string): Promise<Answer>;
  discard(id: string): Promise<Answer>;
  disallow(address: string): Answer;
  view(): MailView;
  recent(limit: number): readonly Row[];
  readonly extension: Extension;
}

export async function said(extension: Extension, args: Record<string, string | number>, session: string): Promise<string> {
  const [tool] = extension.tools ?? [];

  if (!tool) throw new Error("No mail tool");
  // SAFETY: the mail tool reads only the calling conversation from its api.
  const api = { conversationId: Number(session), callId: "call-1" } as ToolExecutionApi;
  const result = await tool.execute(args, api, BACKGROUND_CONTEXT);

  return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

export async function blocked(extension: Extension, session: string): Promise<string | null> {
  // SAFETY: a hook's handlers are its task's hooks; the mail extension's ToolTask hook is the one with beforeTool.
  const beforeTool = (extension.hooks ?? []).map(({ handlers }) => handlers as Partial<ToolHooks>).find((each) => each.beforeTool)?.beforeTool;

  if (!beforeTool) throw new Error("No beforeTool hook");
  // SAFETY: the mail hook reads the calling conversation, nothing else of the call or the api.
  const verdict = await beforeTool({ name: "mail" } as ToolHookCall, { conversationId: Number(session) } as HookApi, BACKGROUND_CONTEXT);

  return verdict?.block ?? null;
}

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
