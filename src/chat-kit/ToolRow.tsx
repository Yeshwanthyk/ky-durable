import { type ReactNode, useState } from "react";
import { Icon } from "./Icon";
import { Reveal } from "./Reveal";

/** Where a tool call is: a running one says so in its verb, a failed one turns red. */
export type ToolStatus = "running" | "done" | "failed";

/**
 * One tool call in a turn's work: a dot on the log's line, a verb in the tense of its status, and its target in mono
 * for paths and commands or as prose. With a body it opens in place to show it; what it showed without opening
 * (`children`, such as a screenshot) sits under the row.
 */
export function ToolRow({
  status,
  verb,
  target = "",
  mono = false,
  title,
  body = null,
  children = null
}: {
  status: ToolStatus;
  verb: string;
  target?: string;
  mono?: boolean;
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
        <span className="mark" aria-hidden="true" />
        <span className={status === "running" ? "verb shimmer" : "verb"}>{verb}</span>
        {target ? <span className={mono ? "target mono" : "target"}>{target}</span> : null}
        {expandable ? (
          <span className="trail">
            <Icon name="chevronRight" size={12} className="chevron" />
          </span>
        ) : null}
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
export function ToolGroup({ verb, target, running, children }: { verb: string; target: string; running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="tool group-row">
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="mark" aria-hidden="true" />
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
