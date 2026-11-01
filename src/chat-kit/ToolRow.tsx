import { type ReactNode, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { Reveal } from "./Reveal";

/** Where a tool call is: a running one says so in its verb, a failed one turns red. */
export type ToolStatus = "running" | "done" | "failed";

/**
 * One tool call in a turn's work: an icon, a verb in the tense of its status, its target in mono for paths and commands
 * or as prose, and a trail such as how long it took. With a body it opens in place to show it; what it showed without
 * opening (`children`, such as a screenshot) sits under the row.
 */
export function ToolRow({
  icon,
  status,
  verb,
  target = "",
  mono = false,
  trail = null,
  title,
  body = null,
  children = null
}: {
  icon: IconName;
  status: ToolStatus;
  verb: string;
  target?: string;
  mono?: boolean;
  trail?: ReactNode;
  /** The row's tooltip, such as the call's whole input. */
  title?: string;
  /** What opening the row shows; none, and the row doesn't open. */
  body?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = body !== null;

  return (
    <div className="tool" data-status={status}>
      <button
        type="button"
        className="tool-row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        title={title}
      >
        <Icon name={status === "failed" ? "alert" : icon} size={14} />
        <span className={status === "running" ? "verb shimmer" : "verb"}>{verb}</span>
        {target ? <span className={mono ? "target mono" : "target"}>{target}</span> : null}
        <span className="trail">
          {trail}
          {expandable ? <Icon name="chevronRight" size={12} className="chevron" /> : null}
        </span>
      </button>
      {children}
      {expandable ? <Reveal open={open}>{body}</Reveal> : null}
    </div>
  );
}

/** What a tool call took in and gave back, under its row: a command reads as `$ command`. */
export function ToolBody({ input, output, command = false }: { input: string; output: string; command?: boolean }) {
  return (
    <div className="tool-body">
      {input ? <pre className={command ? "command" : undefined}>{input}</pre> : null}
      {output ? <pre>{output.replace(/\n+$/, "")}</pre> : null}
    </div>
  );
}

/** A run of calls read as one line, such as "Explored 4 files, 2 searches", that opens to their rows. */
export function ToolGroup({ icon, verb, target, running, children }: { icon: IconName; verb: string; target: string; running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="tool group-row">
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={icon} size={14} />
        <span className={running ? "verb shimmer" : "verb"}>{verb}</span>
        <span className="target">{target}</span>
        <span className="trail">
          <Icon name="chevronRight" size={12} className="chevron" />
        </span>
      </button>
      <Reveal open={open}>
        <div className="group-children">{children}</div>
      </Reveal>
    </div>
  );
}
