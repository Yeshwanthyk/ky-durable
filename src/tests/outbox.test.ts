import type { AgentEvent, ConversationId, EntryId, SubmissionId, UserInput } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isQueued, type Outgoing, outgoingText, reduceOutbox, settleOutgoing } from "../outbox";

const outgoing = (operationId: string, behind = false, submission: number | null = null): Outgoing => ({
  operationId,
  input: `say ${operationId}`,
  at: 1,
  behind,
  submission
});

// SAFETY: pi's ids are numbers branded by kind; these stand in for ones pi made.
const submissionId = (id: number) => id as SubmissionId;

// SAFETY: as above.
const conversationId = 1 as ConversationId;

// SAFETY: as above.
const entryId = 2 as EntryId;

const submission = (requestId: string, id: number, status: "queued" | "placed"): AgentEvent => ({
  type: "submission",
  record:
    status === "queued"
      ? { type: "input", id: submissionId(id), conversationId, requestId, status }
      : { type: "input", id: submissionId(id), conversationId, requestId, status, entry: entryId }
});

const inbox = (...ids: number[]): AgentEvent => ({ type: "inbox_update", items: ids.map((id) => ({ id: submissionId(id), mode: "steer" })) });

describe("reduceOutbox", () => {
  it("keeps a queued message with pi's id until pi places it", () => {
    const queued = reduceOutbox([outgoing("a", true)], [submission("a", 7, "queued")]);

    expect(queued).toEqual([outgoing("a", true, 7)]);
    expect(isQueued(queued[0]!)).toBe(true);
    expect(reduceOutbox(queued, [submission("a", 7, "placed")])).toEqual([]);
  });

  it("drops a queued message that leaves pi's inbox, and keeps one pi has not seen yet", () => {
    const outbox = [outgoing("a", true, 7), outgoing("b", true, 8), outgoing("c", true)];

    expect(reduceOutbox(outbox, [inbox(8)]).map((item) => item.operationId)).toEqual(["b", "c"]);
  });

  it("leaves other submissions alone", () => {
    const outbox = [outgoing("a")];

    expect(reduceOutbox(outbox, [submission("z", 3, "placed")])).toEqual(outbox);
  });
});

describe("settleOutgoing", () => {
  it("drops a message once answered, unless pi queued it", () => {
    const outbox = [outgoing("a"), outgoing("b", true, 4)];

    expect(settleOutgoing(outbox, "a", false)).toEqual([outgoing("b", true, 4)]);
    expect(settleOutgoing(outbox, "b", false)).toEqual(outbox);
  });

  it("drops a refused message, queued or not", () => {
    expect(settleOutgoing([outgoing("b", true, 4)], "b", true)).toEqual([]);
  });
});

describe("outgoingText", () => {
  it("joins the words and skips the images", () => {
    const input: UserInput = [
      { type: "text", text: "one" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "two" }
    ];

    expect(outgoingText(input)).toBe("one\ntwo");
  });
});
