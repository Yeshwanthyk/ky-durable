import type { JsonObject } from "@earendil-works/pi-ai";
import { type Activity, describeTool } from "../tool-labels";
import type { PiMessage } from "../transcript";
import type { PiRunningTool } from "../view";

export type { Activity } from "../tool-labels";

const THINKING: Activity = { icon: "thought", label: "Thinking…" };

/** The arguments of a call, from the newest messages that could hold it. */
function findArgs(messages: readonly PiMessage[], callId: string): JsonObject {
  for (let index = messages.length - 1; index >= 0 && index >= messages.length - 8; index--) {
    for (const part of messages[index]?.parts ?? []) {
      if (part.type === "tool-call" && part.id === callId) return part.arguments;
    }
  }

  return {};
}

/** What each running tool is doing, labelled from its arguments: "Reading tasks.ts". */
export function toolLabels(tools: readonly PiRunningTool[], messages: readonly PiMessage[]): string[] {
  return tools.map((tool) => describeTool(tool.name, findArgs(messages, tool.callId)).label);
}

/**
 * What the agent is doing, from the same live state the thread renders: the
 * message it is streaming, then the tools running now. Null when it is idle.
 */
export function currentActivity({
  running,
  live,
  tools,
  messages,
  retrying = false
}: {
  running: boolean;
  live: PiMessage | null;
  tools: readonly PiRunningTool[];
  messages: readonly PiMessage[];
  retrying?: boolean;
}): Activity | null {
  if (!running) return null;

  if (retrying) return { icon: "refresh", label: "Retrying…" };

  // The newest part of the streaming message is what it is doing this moment.
  const part = live?.parts.findLast(
    (each) => each.type === "tool-call" || ((each.type === "text" || each.type === "thinking") && each.text.trim() !== "")
  );

  if (part?.type === "tool-call") return describeTool(part.name, part.arguments);

  if (part?.type === "text") return { icon: "chat", label: "Writing reply" };

  if (part?.type === "thinking") return THINKING;

  const tool = tools.at(-1);

  if (tool) return describeTool(tool.name, findArgs(messages, tool.callId));

  return THINKING;
}
