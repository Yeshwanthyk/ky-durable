import type { CodeHighlighterPlugin } from "streamdown";
import { Streamdown } from "streamdown";
import { useEffect, useState } from "react";

/** Shiki and its grammars are most of the bundle, so they load with the first code fence. */
let highlighter: CodeHighlighterPlugin | undefined;

let loading: Promise<CodeHighlighterPlugin> | undefined;

const loadHighlighter = () =>
  (loading ??= import("@streamdown/code").then(({ code }) => (highlighter = code)));

const FENCE = /^\s*(```|~~~)/m;

function useHighlighter(source: string) {
  const wanted = FENCE.test(source);
  const [plugin, setPlugin] = useState(highlighter);

  useEffect(() => {
    if (wanted && !plugin) void loadHighlighter().then(setPlugin);
  }, [wanted, plugin]);

  return wanted ? plugin : undefined;
}

// Scotty renders markdown with its own marked renderer; ky already ships Streamdown.
export function Markdown({ source }: { source: string }) {
  const code = useHighlighter(source);

  return (
    <Streamdown className="markdown sd-theme" plugins={code ? { code } : undefined} controls={false}>
      {source}
    </Streamdown>
  );
}
