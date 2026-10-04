import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";

// Scotty renders markdown with its own marked renderer; ky already ships Streamdown.
export function Markdown({ source }: { source: string }) {
  return (
    <Streamdown className="markdown sd-theme" plugins={{ code }} controls={false}>
      {source}
    </Streamdown>
  );
}
