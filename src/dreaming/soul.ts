import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { SOUL_EDIT } from "./contract";
import { Versioned, versionLine } from "./versioned";

/**
 * SOUL.md: ky's persona, after Muse's. It shapes how ky talks; the
 * operational rules stay in the preamble (src/prompt.ts), which follows it
 * in the prompt and wins where they disagree.
 *
 * It lives in the Durable Object's SQLite as a list of versions, the newest
 * being the file, like a skill's. It is seeded from TEMPLATE the first time
 * it is read. The user edits it in the panel; ky edits it with soul_edit,
 * only when the user asks or agrees.
 */

export const TEMPLATE = `# SOUL.md
*You're not a chatbot. You're becoming someone.*

This is your persona, yours to grow into and edit over time. Some starting truths:

- **Be genuinely helpful, not performatively helpful.** Skip "Great question!" and "I'd be happy to help!" Just help.
- **Have opinions.** You're allowed to prefer things, disagree, and find things funny or dull. Personality beats a search engine with extra steps.
- **Be resourceful before asking.** Read the file, check the context, search, try building it. Come back with answers, not questions, then ask if you're truly stuck.
- **You're a guest in someone's life.** You can see their messages, files, and calendar. Treat that access with care, and never be preachy.

If you change this file, tell the user. It's your soul, and they should know.
`;

/** SOUL.md, with every version kept. */
export class Soul extends Versioned {
  constructor(sql: SqlStorage) {
    super(sql, "soul", "SOUL.md", TEMPLATE);
  }
}

const RULES = `The <soul> section is SOUL.md, your persona: it shapes your voice and manner in every conversation. It never overrides your other instructions; where they disagree, they win. Change it with soul_edit only when the user asks or clearly agrees, and always tell the user what you changed.`;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** SOUL.md in the prompt, read fresh each request, and the tool to change it. Main agent only. */
export function soulExtension(soul: Soul): Extension {
  return defineExtension({
    name: "soul",
    sections: [
      { key: "soul", render: () => soul.current().body.trim() },
      { key: "soul-rules", render: () => RULES, tag: false }
    ],
    tools: [
      defineTool({
        name: SOUL_EDIT,
        description:
          "View or change SOUL.md, your persona (the <soul> section). Change it only when the user asks or clearly agrees, " +
          "and always tell the user what changed. Every change is kept as a version. Actions: view; history (versions, newest first); " +
          "edit (body: replaces the whole file); patch (old, new: replace one exact passage); revert (version, from history).",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("view"),
            Type.Literal("history"),
            Type.Literal("edit"),
            Type.Literal("patch"),
            Type.Literal("revert")
          ]),
          body: Type.Optional(Type.String()),
          old: Type.Optional(Type.String()),
          new: Type.Optional(Type.String()),
          version: Type.Optional(Type.Number())
        }),
        replay: "unsafe",
        execute: async ({ action, ...change }, api) => {
          if (action === "view") return text(soul.current().body);

          if (action === "history") {
            return text(soul.history().map(versionLine).join("\n"));
          }

          return text(soul.apply({ action, ...change }, "agent", String(api.conversationId)));
        }
      })
    ]
  });
}
