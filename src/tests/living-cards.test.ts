import { describe, expect, it } from "vitest";
import type { UiBlock, UiCard } from "../cards/contract";
import type { Tool, Turn } from "../ui/conversation";
import { placements } from "../ui/living-cards";

const ui = (id: string, card: UiCard, status: Tool["status"] = "done"): Tool => ({
  kind: "tool",
  id,
  name: "ui",
  category: "other",
  summary: "ui",
  status,
  input: JSON.stringify(card),
  output: "",
  images: [],
  durationMs: null
});

const turn = (id: string, ...items: Tool[]): Turn => ({
  id,
  state: "completed",
  user: "hi",
  images: [], clips: [],
  from: null,
  task: null,
  to: [],
  items,
  startedAt: null,
  endedAt: null
});

const status = (text: string): UiBlock => ({ type: "status", text, tone: "info" });

describe("a card with an id lives where it first showed", () => {
  it("shows its newest version at the first call, and each later call as an update", () => {
    const placed = placements([
      turn("t1", ui("a", { id: "trip", title: "Trip", blocks: [status("Booking")] })),
      turn("t2", ui("b", { title: "Other", blocks: [status("Elsewhere")] })),
      turn("t3", ui("c", { id: "trip", title: "Trip", blocks: [status("Booked")] }))
    ]);

    expect(placed.get("a")).toMatchObject({ kind: "card", call: "c", latest: true, living: true, ui: { blocks: [{ text: "Booked" }] } });
    expect(placed.get("b")).toMatchObject({ kind: "card", call: "b", latest: false, living: false });
    expect(placed.get("c")).toEqual({ kind: "updated", name: "Trip" });
  });

  it("keeps cards without an id where they were called, and leaves out failed and unreadable calls", () => {
    const placed = placements([turn("t1", ui("a", { blocks: [status("one")] }), ui("b", { blocks: [status("two")] }), ui("f", { blocks: [status("…")] }, "failed"), ui("u", { blocks: [] }))]);

    expect([...placed.keys()]).toEqual(["a", "b"]);
    expect(placed.get("a")).toMatchObject({ kind: "card", call: "a", latest: true, living: false, drafting: false });
  });

  it("shows a call still streaming as a draft, and a living card's draft where the card first showed", () => {
    const placed = placements([
      turn("t1", ui("a", { id: "trip", blocks: [status("Booking")] })),
      turn("t2", ui("b", { id: "trip", blocks: [status("Boo")] }, "running"), ui("c", { blocks: [status("Fresh")] }, "running"))
    ]);

    expect(placed.get("a")).toMatchObject({ kind: "card", call: "b", drafting: true, ui: { blocks: [{ text: "Boo" }] } });
    expect(placed.get("c")).toMatchObject({ kind: "card", call: "c", drafting: true });
  });

  it("is newest in the last turn only when its newest call is there", () => {
    const placed = placements([turn("t1", ui("a", { id: "p", blocks: [status("one")] }), ui("b", { id: "p", blocks: [status("two")] })), turn("t2")]);

    expect(placed.get("a")).toMatchObject({ kind: "card", call: "b", latest: false });
  });

  it("waits for its answer until the user writes after it: a post or a report landing after it leaves it waiting", () => {
    const post: Turn = { ...turn("p", ui("a", { blocks: [{ type: "choice", label: "Umbrella?", options: [{ label: "Yes" }] }] })), user: "" };
    const report: Turn = { ...turn("r"), from: { verb: "Ran", icon: "clock", name: "Daily" } };

    expect(placements([post, report]).get("a")).toMatchObject({ latest: true });
    expect(placements([post, report, turn("u")]).get("a")).toMatchObject({ latest: false });
  });
});
