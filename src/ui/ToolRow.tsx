import { type ReactNode, useState } from "react";
import type { Tool } from "./conversation";
import { duration } from "./duration";
import { Icon, Spinner, type IconName } from "./Icon";
import { useLightbox } from "./Lightbox";

const categoryIcon: Record<Tool["category"], IconName> = {
  inspect: "eye",
  change: "pencil",
  research: "globe",
  agent: "nodes",
  run: "terminal",
  other: "list",
};

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

export function phrase(tool: Tool): Phrase {
  const running = tool.status === "running";

  if (tool.category === "run")
    return {
      verb: tool.status === "failed" ? "Failed" : running ? "Running" : "Ran",
      target: tool.summary,
      mono: true,
    };

  if (tool.category === "research" && tool.summary.includes(" · "))
    return {
      verb: running ? "Calling" : tool.status === "failed" ? "Failed" : "Called",
      target: tool.summary,
      mono: false,
    };
  const [first = "", ...rest] = tool.summary.split(" ");
  const tense = tenses.get(first);

  if (tense === undefined) return { verb: tool.summary, target: "", mono: false };
  // File names and paths read in mono; searches and subagent verbs read as prose.
  const prose = ["Search", "Start", "Message"].includes(first);

  return { verb: tense[running ? 0 : 1], target: rest.join(" "), mono: !prose };
}

function Trail({ tool }: { tool: Tool }) {
  if (tool.status === "running") return <Spinner size={12} />;

  return tool.durationMs !== null && tool.durationMs >= 1000 ? (
    <span className="tabular">{duration(tool.durationMs)}</span>
  ) : null;
}

// A body opens in place: its grid row grows from 0fr to 1fr, so what is below glides down rather
// than jumping. It mounts on the first open and stays, so closing animates too; while closed it is
// inert, so it takes no clicks or focus and screen readers skip it.
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);

  if (open && !opened) setOpened(true);

  return (
    <div className="reveal" data-open={open} inert={!open}>
      <div className="reveal-inner">{opened ? children : null}</div>
    </div>
  );
}

const hasBody = (tool: Tool) => tool.output !== "" || tool.input !== "";

export function ToolRow({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const { verb, target, mono } = phrase(tool);
  const expandable = hasBody(tool);

  return (
    <div className="tool" data-status={tool.status}>
      <button
        type="button"
        className="tool-row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        title={tool.input || tool.summary}
      >
        <Icon name={tool.status === "failed" ? "alert" : categoryIcon[tool.category]} size={14} />
        <span className="verb">{verb}</span>
        {target ? <span className={mono ? "target mono" : "target"}>{target}</span> : null}
        <span className="trail">
          <Trail tool={tool} />
          {expandable ? <Icon name="chevronRight" size={12} className="chevron" /> : null}
        </span>
      </button>
      {tool.images.length > 0 ? <ToolImages tool={tool} /> : null}
      {expandable ? (
        <Reveal open={open}>
          <ToolBody tool={tool} />
        </Reveal>
      ) : null}
    </div>
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

function ToolBody({ tool }: { tool: Tool }) {
  const command = tool.category === "run";

  return (
    <div className="tool-body">
      {tool.input ? <pre className={command ? "command" : undefined}>{tool.input}</pre> : null}
      {tool.output ? <pre>{tool.output.replace(/\n+$/, "")}</pre> : null}
    </div>
  );
}

// Consecutive reads, searches and listings read as one line: "Explored 4 files, 2 searches".
export function ExploreGroup({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
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
    <div className="tool group-row">
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="search" size={14} />
        <span className="verb">{running ? "Exploring" : "Explored"}</span>
        <span className="target">{parts.join(", ")}</span>
        <span className="trail">
          {running ? <Spinner size={12} /> : null}
          <Icon name="chevronRight" size={12} className="chevron" />
        </span>
      </button>
      <Reveal open={open}>
        <div className="group-children">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      </Reveal>
    </div>
  );
}
