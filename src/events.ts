import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentState,
  CommitObservation,
  EntryId,
  EntryRecord,
  InboxItem,
  InboxState,
  LiveRun,
  LiveState,
  SubmissionRecord,
  ToolSlot
} from "@earendil-works/pi-durable";
import type { ConversationView } from "@earendil-works/pi-durable/harness/view";
import type { PiHarness, PiSessionId } from "agents/harness/pi";

/** One incremental update to a streaming assistant message, as `src/view.ts` and the Mac app apply it. */
export type MessageChange =
  | { readonly type: "message"; readonly message: AssistantMessage }
  | {
      readonly type: "text_start" | "thinking_start" | "toolcall_start" | "block";
      readonly contentIndex: number;
      readonly block: AssistantMessage["content"][number];
    }
  | { readonly type: "text_delta" | "thinking_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "toolcall_delta"; readonly contentIndex: number; readonly path: readonly (string | number)[]; readonly delta: string };

/** Tool output delta for a running tool slot. */
export type ToolOutputDelta = { readonly set: string } | { readonly trimStart?: number; readonly append?: string };

/** Events streamed over ky's WebSocket and folded by `reduceEvents` in `src/view.ts` and `apps/mac`. */
export type AgentEvent =
  | {
      readonly type: "snapshot";
      readonly entries: readonly EntryRecord[];
      readonly run?: LiveRun;
      readonly generation?: LiveState["generation"];
      readonly tools: readonly ToolSlot[];
      readonly inbox: readonly InboxItem[];
      readonly agent: AgentState;
    }
  | { readonly type: "run_start" }
  | { readonly type: "run_end" }
  | { readonly type: "message_start"; readonly message: AssistantMessage }
  | { readonly type: "message_update"; readonly changes: readonly MessageChange[] }
  | { readonly type: "message_end"; readonly entry: EntryRecord }
  | { readonly type: "entry_appended"; readonly entry: EntryRecord }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly output?: ToolOutputDelta }
  | { readonly type: "tool_execution_end"; readonly toolCallId: string }
  | { readonly type: "inbox_update"; readonly items: readonly InboxItem[] }
  | { readonly type: "auto_retry_start"; readonly at: number; readonly errorMessage: string }
  | { readonly type: "auto_retry_end" }
  | { readonly type: "agent_changed"; readonly agent: AgentState }
  | { readonly type: "task_failed"; readonly message: string }
  | { readonly type: "submission"; readonly record: SubmissionRecord };

export type SnapshotEvent = Extract<AgentEvent, { readonly type: "snapshot" }>;

export type AgentEventStream = {
  readonly snapshot: SnapshotEvent;
  start(listener: (events: readonly AgentEvent[]) => void | Promise<void>): void;
  stop(): Promise<void>;
};

const EMPTY_AGENT: AgentState = {};

const liveOf = (view: ConversationView): LiveState | undefined =>
  // SAFETY: pi-durable's ConversationView stores LiveDoc under the built-in key "pi.live".
  view.docs["pi.live"] as LiveState | undefined;

const inboxOf = (view: ConversationView): readonly InboxItem[] =>
  // SAFETY: pi-durable's ConversationView stores InboxDoc under the built-in key "pi.inbox".
  (view.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];

const agentOf = (view: ConversationView): AgentState =>
  // SAFETY: pi-durable's ConversationView stores AgentDoc under the built-in key "pi.agent".
  (view.docs["pi.agent"] as AgentState | undefined) ?? EMPTY_AGENT;

/** Active context entries for a snapshot: if a compaction/reset marker exists, lead with it and keep entries from its head onward. */
function activeEntries(entries: readonly EntryRecord[]): readonly EntryRecord[] {
  let marker: EntryRecord | undefined;

  for (const entry of entries) if (entry.head !== undefined) marker = entry;

  if (!marker || marker.head === undefined) return entries;
  const head = marker.head;

  return [marker, ...entries.filter((entry) => entry.id !== marker.id && entry.id >= head && entry.head === undefined)];
}

function snapshotOf(view: ConversationView): SnapshotEvent {
  const live = liveOf(view);

  return {
    type: "snapshot",
    entries: activeEntries(view.entries),
    ...(live?.run !== undefined && { run: live.run }),
    ...(live?.generation !== undefined && { generation: live.generation }),
    tools: live?.tools ?? [],
    inbox: inboxOf(view),
    agent: agentOf(view)
  };
}

function diffViews(prev: ConversationView, next: ConversationView, seen: Set<EntryId>): AgentEvent[] {
  const events: AgentEvent[] = [];
  const prevLive = liveOf(prev);
  const nextLive = liveOf(next);

  if (prevLive?.run === undefined && nextLive?.run !== undefined) events.push({ type: "run_start" });

  const prevAgent = agentOf(prev);
  const nextAgent = agentOf(next);

  if (prevAgent !== nextAgent) events.push({ type: "agent_changed", agent: nextAgent });

  const prevInbox = inboxOf(prev);
  const nextInbox = inboxOf(next);

  if (prevInbox !== nextInbox) events.push({ type: "inbox_update", items: nextInbox });

  const prevTools = new Map((prevLive?.tools ?? []).map((tool) => [tool.callId, tool]));
  const nextTools = new Map((nextLive?.tools ?? []).map((tool) => [tool.callId, tool]));

  for (const [callId, tool] of nextTools) {
    const before = prevTools.get(callId);

    if (tool.status === "running" && before?.status !== "running") {
      events.push({ type: "tool_execution_start", toolCallId: callId, toolName: tool.name });

      if (tool.output) events.push({ type: "tool_execution_update", toolCallId: callId, output: { set: tool.output } });
    } else if (tool.status === "running" && tool.output !== before?.output) {
      events.push({ type: "tool_execution_update", toolCallId: callId, output: { set: tool.output ?? "" } });
    }
  }

  for (const [callId, before] of prevTools) {
    const after = nextTools.get(callId);

    if (before.status === "running" && after?.status !== "running") {
      events.push({ type: "tool_execution_end", toolCallId: callId });
    }
  }

  for (const entry of next.entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    events.push(entry.model !== undefined ? { type: "message_end", entry } : { type: "entry_appended", entry });
  }

  // SAFETY: pi-durable stores the in-flight AssistantMessage as its JSON representation on LiveState.generation.message.
  const prevMessage = prevLive?.generation?.message as AssistantMessage | undefined;
  // SAFETY: pi-durable stores the in-flight AssistantMessage as its JSON representation on LiveState.generation.message.
  const nextMessage = nextLive?.generation?.message as AssistantMessage | undefined;

  if (prevMessage === undefined && nextMessage !== undefined) {
    events.push({ type: "message_start", message: nextMessage });
  } else if (prevMessage !== undefined && nextMessage !== undefined && prevMessage !== nextMessage) {
    events.push({ type: "message_update", changes: [{ type: "message", message: nextMessage }] });
  }

  const prevRetry = prevLive?.generation?.retry;
  const nextRetry = nextLive?.generation?.retry;

  if (nextRetry !== undefined && (nextRetry.at !== prevRetry?.at || nextRetry.error !== prevRetry?.error)) {
    events.push({ type: "auto_retry_start", at: nextRetry.at, errorMessage: nextRetry.error });
  } else if (prevRetry !== undefined && nextRetry === undefined) {
    events.push({ type: "auto_retry_end" });
  }

  const prevFailure = prevLive?.runFailure;
  const nextFailure = nextLive?.runFailure;

  if (nextFailure !== undefined && nextFailure !== prevFailure && nextFailure.reason !== "aborted" && nextFailure.reason !== "reset") {
    events.push({ type: "task_failed", message: nextFailure.detail ?? nextFailure.reason });
  }

  if (prevLive?.run !== undefined && nextLive?.run === undefined) events.push({ type: "run_end" });

  return events;
}

/**
 * Watch a pi-durable 1.6+ session as ky's `AgentEventStream`: a snapshot followed by incremental
 * events derived from `ConversationView` updates and `submission` commit records.
 */
export async function watchEvents(harness: PiHarness, session?: PiSessionId): Promise<AgentEventStream> {
  const [watch, pi] = await Promise.all([harness.session(session).watch({ min: 500, max: 1_000 }), harness.pi()]);
  let current = watch.value;
  const conversationId = current.conversation.id;
  const seen = new Set<EntryId>(current.entries.map((entry) => entry.id));
  const snapshot = snapshotOf(current);
  let commits: CommitObservation | undefined;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  return {
    snapshot,
    start(listener) {
      if (stopped) return;

      const deliver = (events: readonly AgentEvent[]) => {
        if (stopped || events.length === 0) return;

        chain = chain.then(() => (stopped ? undefined : listener(events))).catch(() => {});
      };

      watch.start(async (call) => {
        if (call.kind !== "value") return;
        const events = diffViews(current, call.value, seen);
        current = call.value;
        deliver(events);
      });

      commits = pi.observeCommits({
        advance(publication) {
          const events: AgentEvent[] = [];

          for (const change of publication.changes) {
            if (change.type === "submission" && change.value.conversationId === conversationId) {
              events.push({ type: "submission", record: change.value });
            }
          }

          deliver(events);
        },
        end() {}
      });
    },
    async stop() {
      stopped = true;
      commits?.detach();
      commits = undefined;
      await watch.stop();
    }
  };
}
