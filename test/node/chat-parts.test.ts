import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Tool } from "../../src/ui/conversation.ts";
import { attachable, attachmentsOf, composerVoice } from "../../src/ui/composer-parts.tsx";
import type { PendingClip } from "../../src/ui/pick-media.ts";
import { ExploreGroup, ToolCallRow } from "../../src/ui/ToolRow.tsx";

/** ky's side of the chat kit, drawn to HTML: the parts it plugs into the composer and the tool rows. */

const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node));

const clip = (patch: Partial<PendingClip>): PendingClip => ({
  id: "c",
  kind: "audio",
  name: "Voice note",
  type: "audio/webm",
  seconds: 65,
  peaks: "0918",
  transcript: "",
  frames: [],
  preview: "blob:x",
  file: "f1",
  progress: 1,
  ...patch
});

const none = () => {};

const draft = (clips: readonly PendingClip[]) => ({ images: [], clips, removeImage: none, removeClip: none });

describe("what waits to be sent", () => {
  it("is nothing while nothing does, so the composer stays a pill", () => {
    expect(attachmentsOf(draft([]))).toBeNull();
  });

  it("names each clip with its length and a way to remove it", () => {
    const shown = html(attachmentsOf(draft([clip({})])));

    expect(shown).toContain("<span>Voice note</span>");
    expect(shown).toContain('<span class="quiet">1:05</span>');
    expect(shown).toContain('aria-label="Remove Voice note"');
  });

  it("shows a clip's upload as it goes, and one waiting offline as waiting", () => {
    expect(html(attachmentsOf(draft([clip({ file: null, progress: 0.4 })])))).toContain('aria-valuenow="40"');
    expect(html(attachmentsOf(draft([clip({ file: null, waiting: true })])))).toContain("Uploads on reconnect");
  });

  it("reads a video as its length", () => {
    const shown = html(attachmentsOf(draft([clip({ kind: "video", type: "video/mp4", name: "clip.mp4" })])));

    expect(shown).toContain("<video");
    expect(shown).toContain("<span>1:05</span>");
  });
});

describe("the microphone", () => {
  const actions = { onRecord: none, onDone: none, onCancel: none };

  it("draws nothing in the text's place until it records", () => {
    expect(composerVoice({ state: "idle" }, actions)).toMatchObject({ recording: null, ready: false });
  });

  it("puts the recording strip in the text's place, ready once the microphone is live", () => {
    const starting = composerVoice({ state: "starting" }, actions);
    const live = composerVoice({ state: "recording", seconds: 3, levels: [0.5], heard: "hello" }, actions);

    expect(starting.ready).toBe(false);
    expect(html(starting.recording)).toContain("Starting the microphone");
    expect(live.ready).toBe(true);
    expect(html(live.recording)).toContain('aria-label="Recording, 0:03"');
    expect(html(live.recording)).toContain("<bdi>hello</bdi>");
    expect(html(live.recording)).toContain('aria-label="Discard voice note"');
  });

  it("takes images, and the audio and video ky plays", () => {
    expect(attachable(new File([], "a.png", { type: "image/png" }))).toBe(true);
    expect(attachable(new File([], "a.mp3", { type: "audio/mpeg" }))).toBe(true);
    expect(attachable(new File([], "a.pdf", { type: "application/pdf" }))).toBe(false);
  });
});

const tool = (patch: Partial<Tool>): Tool => ({
  kind: "tool",
  id: "t",
  name: "read",
  category: "inspect",
  summary: "Read src/a.ts",
  status: "done",
  input: "",
  output: "",
  images: [],
  durationMs: null,
  ...patch
});

describe("a tool call's row", () => {
  const row = (patch: Partial<Tool>) => renderToStaticMarkup(createElement(ToolCallRow, { tool: tool(patch) }));

  it("reads its summary in the tense of its status, a path in mono", () => {
    expect(row({})).toContain('<span class="verb">Read</span><span class="target mono">src/a.ts</span>');
    expect(row({ status: "running" })).toContain('<span class="verb shimmer">Reading</span>');
  });

  it("reads a search as prose and a command as one verb", () => {
    expect(row({ summary: "Search for todo" })).toContain('<span class="verb">Searched</span><span class="target">for todo</span>');
    expect(row({ category: "run", summary: "pnpm test", status: "failed" })).toContain('<span class="verb">Failed</span><span class="target mono">pnpm test</span>');
    expect(row({ category: "research", summary: "github · issues" })).toContain('<span class="verb">Called</span>');
    expect(row({ summary: "Ponder" })).toContain('<span class="verb">Ponder</span>');
  });

  it("leaves how long a call took to the Worked line, and opens only when it has a body", () => {
    expect(row({ durationMs: 2500 })).not.toContain("2.5s");
    expect(row({})).toMatch(/class="tool-row" disabled=""/);
    expect(row({ output: "x" })).toContain('aria-expanded="false"');
  });

  it("groups reads, searches and listings into one line", () => {
    const tools = [tool({ id: "1" }), tool({ id: "2" }), tool({ id: "3", summary: "Search x" }), tool({ id: "4", summary: "List src" })];

    expect(renderToStaticMarkup(createElement(ExploreGroup, { tools }))).toContain('<span class="verb">Explored</span><span class="target">2 files, 1 search, 1 listing</span>');
    expect(renderToStaticMarkup(createElement(ExploreGroup, { tools: [tool({ status: "running" })] }))).toContain('<span class="verb shimmer">Exploring</span><span class="target">1 file</span>');
  });
});
