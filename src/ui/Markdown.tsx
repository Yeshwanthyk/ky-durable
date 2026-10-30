import type { CodeHighlighterPlugin, PluginConfig } from "streamdown";
import { Streamdown } from "streamdown";
import { useEffect, useState } from "react";
import { Diagram } from "./Diagram";

type Highlighted = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

/** Uncoloured, one token per line: the same markup shiki's tokens render into, so colour arriving later moves nothing. */
const plain = (code: string): Highlighted => ({ tokens: code.split("\n").map((content) => [{ content }]) });

/**
 * Shiki re-tokenises the whole block on every call, and @streamdown/code caches each partial block
 * forever. So an open fence renders plain, and only finished blocks reach shiki.
 */
function finishedOnly(shiki: CodeHighlighterPlugin): CodeHighlighterPlugin {
  return {
    ...shiki,
    highlight(options, done) {
      if (options.isIncomplete) return plain(options.code);

      // A cache miss answers later through `done`; plain text holds the place with the right lines.
      return shiki.highlight(options, done) ?? plain(options.code);
    },
  };
}

/** A ```mermaid fence is drawn as a diagram (src/ui/Diagram.tsx), not highlighted. */
const DIAGRAMS: PluginConfig = { renderers: [{ language: "mermaid", component: Diagram }] };

/** Shiki and its grammars are most of the bundle, so they load with the first code fence. */
let plugins: PluginConfig | undefined;

let loading: Promise<PluginConfig> | undefined;

// One object for the whole app: Streamdown's memo compares `plugins` by identity.
// A load that failed (offline before the service worker cached it) is forgotten, so the next fence tries again.
function loadHighlighter(): Promise<PluginConfig> {
  if (loading) return loading;
  const load = import("@streamdown/code").then(({ code }) => (plugins = { ...DIAGRAMS, code: finishedOnly(code) }));
  loading = load;
  load.catch(() => (loading = undefined));

  return load;
}

const FENCE = /^\s*(```|~~~)/m;

function useHighlighter(source: string) {
  const wanted = FENCE.test(source);
  const [loaded, setLoaded] = useState(plugins);

  useEffect(() => {
    // Until it loads, fences show as plain code.
    if (wanted && !loaded) loadHighlighter().then(setLoaded, () => {});
  }, [wanted, loaded]);

  // Diagrams draw before shiki arrives: they don't need it.
  return wanted ? (loaded ?? DIAGRAMS) : undefined;
}

// The fence rule Streamdown itself uses to call a block incomplete.
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function endsInOpenFence(source: string) {
  let open: string | undefined;

  for (const line of source.split("\n")) {
    const fence = FENCE_LINE.exec(line)?.[1];

    if (!fence) continue;

    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = undefined;
  }

  return open !== undefined;
}

/** How long a source must sit still before an unclosed fence counts as finished, e.g. a stopped run. */
const SETTLE_MS = 2000;

/**
 * True while the source is growing inside an unclosed fence. Streamdown only marks a fence
 * incomplete when told it is animating, and Markdown's callers don't say whether they stream.
 */
function useOpenFence(source: string) {
  const [previous, setPrevious] = useState(source);
  const [growing, setGrowing] = useState(false);

  // Set during render, so the very render that grows the fence already counts as streaming.
  if (source !== previous) {
    setPrevious(source);
    setGrowing(true);
  }

  useEffect(() => {
    if (!growing) return;

    const settle = setTimeout(() => setGrowing(false), SETTLE_MS);

    return () => clearTimeout(settle);
  }, [growing, source]);

  return growing && FENCE.test(source) && endsInOpenFence(source);
}

// Scotty renders markdown with its own marked renderer; ky already ships Streamdown.
export function Markdown({ source }: { source: string }) {
  const highlighter = useHighlighter(source);
  const streaming = useOpenFence(source);

  return (
    <Streamdown className="markdown sd-theme" plugins={highlighter} isAnimating={streaming} controls={false}>
      {source}
    </Streamdown>
  );
}
