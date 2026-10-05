import { useState } from "react";
import type { Tool } from "./conversation";
import { duration } from "./duration";
import { Icon, Spinner, type IconName } from "./Icon";

const categoryIcon: Record<Tool["category"], IconName> = {
  inspect: "eye",
  change: "pencil",
  research: "globe",
  agent: "nodes",
  run: "terminal",
  other: "list",
};

// Summaries start with an imperative verb; rows read it in the tense of the tool's status.
const tenses: Record<string, [string, string]> = {
  Read: ["Reading", "Read"],
  Search: ["Searching", "Searched"],
  List: ["Listing", "Listed"],
  Edit: ["Editing", "Edited"],
  Delete: ["Deleting", "Deleted"],
  Write: ["Writing", "Wrote"],
  Start: ["Starting", "Started"],
  Message: ["Messaging", "Messaged"],
};

export function phrase(tool: Tool): { verb: string; target: string; mono: boolean } {
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
  const tense = tenses[first];

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
      {open ? <ToolBody tool={tool} /> : null}
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
      {open ? (
        <div className="group-children">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
