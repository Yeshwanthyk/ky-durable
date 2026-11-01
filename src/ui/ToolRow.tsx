import { useMemo } from "react";
import { AVATAR_TOOL } from "../avatars/contract";
import { BloubOptions, bloubsIn } from "./Bloub";
import type { Tool } from "./conversation";
import { ToolBody, ToolGroup, ToolRow } from "../chat-kit/ToolRow";
import { useLightbox } from "./Lightbox";

// Summaries start with an imperative verb; rows read it in the tense of the tool's status.
const tenses = new Map<string, readonly [string, string]>([
  ["Read", ["Reading", "Read"]],
  ["Search", ["Searching", "Searched"]],
  ["List", ["Listing", "Listed"]],
  ["Edit", ["Editing", "Edited"]],
  ["Delete", ["Deleting", "Deleted"]],
  ["Write", ["Writing", "Wrote"]],
  ["Start", ["Starting", "Started"]],
  ["Message", ["Messaging", "Messaged"]],
]);

// How a row reads: a verb, then its target in mono for paths and commands or as prose.
type Phrase = { verb: string; target: string; mono: boolean };

// A command or a call reads as one verb for its status, then the whole summary.
function verbOf(status: Tool["status"], running: string, done: string): string {
  if (status === "failed") return "Failed";

  return status === "running" ? running : done;
}

function phrase(tool: Tool): Phrase {
  if (tool.category === "run") return { verb: verbOf(tool.status, "Running", "Ran"), target: tool.summary, mono: true };

  if (tool.category === "research" && tool.summary.includes(" · "))
    return { verb: verbOf(tool.status, "Calling", "Called"), target: tool.summary, mono: false };
  const [first = "", ...rest] = tool.summary.split(" ");
  const tense = tenses.get(first);

  if (tense === undefined) return { verb: tool.summary, target: "", mono: false };
  // File names and paths read in mono; searches and subagent verbs read as prose.
  const prose = ["Search", "Start", "Message"].includes(first);

  return { verb: tense[tool.status === "running" ? 0 : 1], target: rest.join(" "), mono: !prose };
}

const hasBody = (tool: Tool) => tool.output !== "" || tool.input !== "";

/** A tool call as the kit's row: its phrase and what it showed under it. The turn's Worked line says how long it all took. */
export function ToolCallRow({ tool }: { tool: Tool }) {
  const { verb, target, mono } = phrase(tool);

  return (
    <ToolRow
      status={tool.status}
      verb={verb}
      target={target}
      mono={mono}
      title={tool.input || tool.summary}
      body={hasBody(tool) ? <ToolBody input={tool.input} output={tool.output} command={tool.category === "run"} /> : null}
    >
      {tool.images.length > 0 ? <ToolImages tool={tool} /> : null}
      {tool.name === AVATAR_TOOL ? <ToolBloubs output={tool.output} /> : null}
    </ToolRow>
  );
}

// What a tool saw, such as a browser screenshot, shows under its row without opening it.
function ToolImages({ tool }: { tool: Tool }) {
  const open = useLightbox();
  const { verb, target } = phrase(tool);
  const media = tool.images.map((src, index) => ({ src, label: `Image ${index + 1} from ${verb} ${target}`.trim() }));

  return (
    <div className="tool-images">
      {media.map((item, index) => (
        <button key={index} type="button" className="attachment-open" aria-label={`Open ${item.label}`} onClick={() => open(media, index)}>
          <img src={item.src} alt={item.label} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

// The bloubs an avatar call previewed, rolled or saved, drawn and moving under its row.
function ToolBloubs({ output }: { output: string }) {
  const specs = useMemo(() => bloubsIn(output), [output]);

  return specs && specs.length > 0 ? <BloubOptions specs={specs} /> : null;
}

// Consecutive reads, searches and listings read as one line: "Explored 4 files, 2 searches".
export function ExploreGroup({ tools }: { tools: Tool[] }) {
  const running = tools.some((tool) => tool.status === "running");
  const reads = tools.filter((tool) => tool.summary.startsWith("Read")).length;
  const searches = tools.filter((tool) => tool.summary.startsWith("Search")).length;
  const other = tools.length - reads - searches;

  const parts = [
    reads > 0 ? `${reads} ${reads === 1 ? "file" : "files"}` : "",
    searches > 0 ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
    other > 0 ? `${other} ${other === 1 ? "listing" : "listings"}` : "",
  ].filter(Boolean);

  return (
    <ToolGroup verb={running ? "Exploring" : "Explored"} target={parts.join(", ")} running={running}>
      {tools.map((tool) => (
        <ToolCallRow key={tool.id} tool={tool} />
      ))}
    </ToolGroup>
  );
}
