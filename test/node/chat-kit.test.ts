import { createElement, type ComponentProps, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, ComposerActions, type ComposerVoice } from "../../src/chat-kit/Composer.tsx";
import { matching, mentionAt, menuKey, moved, recallStep } from "../../src/chat-kit/composer-keys.ts";
import { TurnEnd, Thought, UserBubble, WorkingLine, WorkLog } from "../../src/chat-kit/Thread.tsx";
import { ToolBody, ToolGroup, ToolRow } from "../../src/chat-kit/ToolRow.tsx";

/** What a kit component draws first, as HTML; its effects and handlers are for the browser tests (test/web). */
const draw = <P extends object>(component: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(component, props));

/** The accessible names of the buttons in some HTML, in order. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(([, name]) => name);

const voice = (recording: ComposerVoice["recording"] = null, ready = true): ComposerVoice => ({ recording, ready, onRecord: () => {}, onDone: () => {} });

describe("the composer's action", () => {
  const actions = (props: Partial<ComponentProps<typeof ComposerActions>>) =>
    draw(ComposerActions, { voice: voice(), empty: true, stop: false, disabled: false, busy: false, ...props });

  it("is the microphone while nothing is typed", () => {
    expect(buttons(actions({}))).toEqual(["Record a voice note"]);
  });

  it("swaps the microphone for Send once something is", () => {
    expect(buttons(actions({ empty: false }))).toEqual(["Send"]);
  });

  it("offers Stop, ringed, beside the microphone while a turn runs and nothing is typed", () => {
    const html = actions({ stop: true });

    expect(buttons(html)).toEqual(["Record a voice note", "Stop"]);
    expect(html).toContain('class="send-ring"');
    expect(html).toContain('r="16.5"');
  });

  it("takes the note while recording: Done, and Send once the microphone is live", () => {
    const html = actions({ voice: voice("recording", false), empty: false });

    expect(buttons(html)).toEqual(["Done recording", "Send voice note"]);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(actions({ voice: voice("recording", true) })).not.toContain("disabled");
  });

  it("without a microphone always shows Send, waiting while there is nothing to send", () => {
    expect(actions({ voice: undefined })).toMatch(/aria-label="Send" disabled=""/);
    expect(actions({ voice: undefined, empty: false, busy: true })).toMatch(/aria-label="Send" disabled=""/);
    expect(actions({ voice: undefined, empty: false })).not.toContain("disabled");
  });
});

describe("the composer", () => {
  const composer = (props: Partial<ComponentProps<typeof Composer>>) =>
    draw(Composer, { value: "", onChange: () => {}, onSubmit: () => {}, placeholder: "Message ky", label: "Message", ...props });

  it("is a pill with its field named, attach first and the action last", () => {
    const html = composer({ onAddFiles: () => {}, voice: voice() });

    expect(html).toContain('data-open="false"');
    expect(html).toContain('aria-label="Message"');
    expect(buttons(html)).toEqual(["Attach images, audio or video", "Record a voice note"]);
  });

  it("opens into a card while something waits to be sent, which counts as a message", () => {
    const html = composer({ attachments: "photo.png", hasAttachments: true, voice: voice() });

    expect(html).toContain('data-open="true"');
    expect(html).toContain('<div class="composer-attachments">photo.png</div>');
    expect(buttons(html)).toEqual(["Send"]);
  });

  it("puts the recording in the text's place and hides attach", () => {
    const html = composer({ onAddFiles: () => {}, voice: voice("<strip>") });

    expect(html).toContain('data-recording="true"');
    expect(html).toMatch(/<textarea[^>]*hidden=""/);
    expect(buttons(html)).toEqual(["Done recording", "Send voice note"]);
  });

  it("offers Stop only while a turn runs and the host can stop it", () => {
    expect(buttons(composer({ working: true, onStop: () => {} }))).toEqual(["Stop"]);
    expect(buttons(composer({ working: true }))).toEqual(["Send"]);
    expect(buttons(composer({ working: true, onStop: () => {}, value: "steer" }))).toEqual(["Send"]);
  });
});

describe("a tool row", () => {
  it("opens to its body, and doesn't without one", () => {
    const body = createElement(ToolBody, { input: "ls", output: "a\nb\n\n", command: true });
    const open = draw(ToolRow, { icon: "terminal", status: "done", verb: "Ran", target: "ls", mono: true, body });

    expect(open).toContain('aria-expanded="false"');
    expect(open).toContain('<span class="target mono">ls</span>');
    expect(open).toContain('<div class="reveal" data-open="false" inert=""><div class="reveal-inner"></div></div>');
    expect(renderToStaticMarkup(body)).toBe('<div class="tool-body"><pre class="command">ls</pre><pre>a\nb</pre></div>');
    expect(draw(ToolRow, { icon: "eye", status: "done", verb: "Read" })).toMatch(/class="tool-row" disabled=""/);
  });

  it("shimmers its verb while running and swaps its icon when it fails", () => {
    const row = (status: "running" | "done" | "failed") => draw(ToolRow, { icon: "eye", status, verb: "Read" });

    expect(row("running")).toContain('class="verb shimmer"');
    expect(row("failed")).toContain('data-status="failed"');
    expect(row("failed").replace("failed", "done")).not.toEqual(row("done"));
  });

  it("groups calls behind one line, their rows mounted only once it opens", () => {
    const html = draw(ToolGroup, { icon: "search", verb: "Explored", target: "2 files", running: false, children: "rows" });

    expect(html).toContain('<span class="target">2 files</span>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("rows");
  });
});

describe("a turn", () => {
  it("folds finished work behind a line that says what it took", () => {
    expect(draw(WorkLog, { live: false, took: "12s", steps: 3, children: "log" })).toContain('<span>Worked for <b class="tabular">12s</b> · 3 steps</span>');
    expect(draw(WorkLog, { live: false, state: "aborted", steps: 1, children: "log" })).toContain("<span>Ran · 1 step</span>");
  });

  it("keeps the work open while it runs, without the line", () => {
    const html = draw(WorkLog, { live: true, steps: 3, children: "log" });

    expect(html).not.toContain("worked");
    expect(html).toContain('<div class="worklog" data-live="true">log</div>');
  });

  it("says who works, on what, and opens its steps only when it can", () => {
    const line = (onOpenSteps: (() => void) | null) => draw(WorkingLine, { avatar: "A", phase: "Thinking", took: "4s", steps: 2, onOpenSteps });

    expect(line(() => {})).toContain("2 steps");
    expect(line(null)).toMatch(/class="live" disabled=""/);
    expect(line(null)).not.toContain("steps");
  });

  it("clamps a long message behind Show more", () => {
    expect(draw(UserBubble, { text: "x\n".repeat(9) })).toContain('data-clamped="true"');
    expect(draw(UserBubble, { text: "short" })).not.toContain("Show more");
  });

  it("reads a thought's bold opening as its title", () => {
    expect(draw(Thought, { text: "**Plan** read the **file**" })).toContain("<b>Plan. </b>read the file");
  });

  it("ends saying whether it was interrupted or failed", () => {
    expect(draw(TurnEnd, { state: "aborted" })).toContain("Interrupted");
    expect(draw(TurnEnd, { state: "failed" })).toContain("Turn failed");
    expect(draw(TurnEnd, { state: "completed" })).toBe('<div class="turn-end" data-state="completed"></div>');
  });
});

describe("the composer's keys", () => {
  const team = [{ id: "writer", description: "" }, { id: "rewriter", description: "" }, { id: "coder", description: "" }];

  it("finds the @word the caret is in, only at the start or after a space", () => {
    expect(mentionAt("ask @Wri", 8)).toEqual({ start: 4, query: "wri" });
    expect(mentionAt("me@home", 7)).toBeNull();
  });

  it("offers who starts with what is typed first, then who has it inside", () => {
    expect(matching(team, "writ").map((each) => each.id)).toEqual(["writer", "rewriter"]);
  });

  it("moves through the menu with the arrows, wrapping, and picks or closes", () => {
    expect([menuKey("ArrowDown"), menuKey("Tab"), menuKey("Escape"), menuKey("a")]).toEqual(["down", "pick", "close", null]);
    expect([moved(2, "down", 3), moved(0, "up", 3)]).toEqual([0, 2]);
  });

  it("brings back what was sent with ↑ from an empty composer, and steps forward to empty with ↓", () => {
    expect(recallStep("ArrowUp", "", "", null, true, 2)).toBe(0);
    expect(recallStep("ArrowUp", "", "", null, false, 2)).toBeUndefined();
    expect(recallStep("ArrowUp", "", "", 1, true, 2)).toBeUndefined();
    expect(recallStep("ArrowUp", "a\nb", "", 0, true, 2)).toBeUndefined();
    expect(recallStep("ArrowDown", "", "", 1, true, 2)).toBe(0);
    expect(recallStep("ArrowDown", "", "", 0, true, 2)).toBeNull();
    expect(recallStep("ArrowDown", "", "", null, true, 2)).toBeUndefined();
  });
});
