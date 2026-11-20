import { createMermaidPlugin } from "@pierre/words/mermaid";
import { type Components, Markdown as Words, type PluginConfig } from "@pierre/words/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { diagrams } from "./diagram";

// Words (diffs.com/words) parses Markdown in WebAssembly and patches only the blocks a stream changed.

/**
 * One plugins object for the whole app, replaced when the highlighter or a diagram type finishes loading,
 * so every Markdown renders again with it. Words reuses a closed block's output while its plugins stay the same.
 */
let plugins: PluginConfig = {};

const listeners = new Set<() => void>();

function publish(next: PluginConfig) {
  plugins = next;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/**
 * A ```mermaid fence is drawn by pele (src/ui/diagram.ts); an open fence grows with each complete line.
 * Words compares plugins by their parts, so a diagram type that finished loading hands it a new wrapper,
 * and the fences it showed as code draw.
 */
const mermaid = createMermaidPlugin(diagrams(() => publish({ ...plugins, mermaid: { render: (options) => mermaid.render(options) } })));

plugins = { mermaid };

/** The highlighter and its grammars are most of the bundle, so they load with the first code fence. */
let loading: Promise<void> | undefined;

// A load that failed (offline before the service worker cached it) is forgotten, so the next fence tries again.
function loadHighlighter() {
  loading ??= Promise.all([
    import("@pierre/words/highlights"),
    import("@pierre/highlights/themes/github-light"),
    import("@pierre/highlights/themes/github-dark")
  ]).then(
    ([{ createHighlightsPlugin }, light, dark]) =>
      // Both themes in each token through `light-dark()`, so a theme switch recolours code without highlighting it again.
      publish({ ...plugins, code: createHighlightsPlugin({ themes: { light: light.default, dark: dark.default }, defaultColor: "light-dark()" }) }),
    () => {
      loading = undefined;
    }
  );
}

const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})\s*(\S*)/;

/** Whether the source opens a fence that highlights: a ```mermaid fence draws instead, so it needs no highlighter. */
function highlights(source: string) {
  let open: string | undefined;

  for (const line of source.split("\n")) {
    const [, fence, language] = FENCE_LINE.exec(line) ?? [];

    if (!fence) continue;

    if (!open) {
      if (language !== "mermaid") return true;
      open = fence;
    } else if (fence[0] === open[0] && fence.length >= open.length && !language) open = undefined;
  }

  return false;
}

function usePlugins(source: string) {
  const wanted = highlights(source);
  const current = useSyncExternalStore(subscribe, () => plugins);

  useEffect(() => {
    // Until it loads, fences show as plain code.
    if (wanted && !current.code) loadHighlighter();
  }, [wanted, current]);

  return current;
}

/** How long a source must sit still before it counts as finished, e.g. a stopped run. */
const SETTLE_MS = 2000;

/**
 * True while the source is still growing. Markdown's callers don't say whether they stream, so a source that
 * changed in the last two seconds counts as streaming: Words then closes its unfinished emphasis, code and links.
 */
function useGrowing(source: string) {
  const [previous, setPrevious] = useState(source);
  const [growing, setGrowing] = useState(false);

  // Set during render, so the very render that grows the source already counts as streaming.
  if (source !== previous) {
    setPrevious(source);
    setGrowing(true);
  }

  useEffect(() => {
    if (!growing) return;

    const settle = setTimeout(() => setGrowing(false), SETTLE_MS);

    return () => clearTimeout(settle);
  }, [growing, source]);

  return growing;
}

const COMPONENTS: Components = {
  // A link opens beside the chat, so following one never navigates the installed app away from it.
  a: (html) => html.replace("<a ", '<a target="_blank" rel="noopener noreferrer" '),
  // A one-line snippet needs no line number: mark it so CSS can hide the gutter.
  pre: (html) => (/data-markdown="line-numbers"[^>]*><span data-markdown="code-lines">\d+<\/span>/.test(html) ? html.replace("<pre", "<pre data-one-line") : html)
};

export function Markdown({ source }: { source: string }) {
  const current = usePlugins(source);
  const growing = useGrowing(source);

  return (
    <Words className="markdown" plugins={current} components={COMPONENTS} isAnimating={growing} controls={false}>
      {source}
    </Words>
  );
}
