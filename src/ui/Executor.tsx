import { createContext, type FormEvent, useContext, useState } from "react";
import type { ToolPolicy } from "../approvals/contract";
import type { ExecutorView } from "../protocol";
import { ApprovalsContext } from "./Approvals";
import { Segmented, SegmentedOption, VaultBadge } from "./Controls";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";

type ExecutorActions = {
  /** Resolves with why the connection was refused, if it was. */
  readonly onConnect: (url: string, token: string) => Promise<string | undefined>;
  readonly onRemove: () => void;
};

/** What Settings › Executor shows, and what it does; provided around the panel. */
export const ExecutorContext = createContext<{ view: ExecutorView | null; actions: ExecutorActions }>({
  view: null,
  actions: { onConnect: async () => undefined, onRemove: () => undefined }
});

const filled = (...values: string[]) => values.every((value) => value.trim() !== "");

// Executor, which gives ky your apps' tools: connected with its URL and a token, which ky tests before keeping.
export function Executor() {
  const { view, actions } = useContext(ExecutorContext);

  return (
    <section className="group" id="settings-executor">
      <h3 className="group-label">Executor</h3>
      {view?.url ? <ConnectedExecutor url={view.url} actions={actions} /> : <ConnectExecutor onConnect={actions.onConnect} />}
      {view?.url ? <ToolPolicies /> : null}
    </section>
  );
}

const POLICIES: ReadonlyArray<[ToolPolicy, string]> = [
  ["allow", "Allow"],
  ["ask", "Ask"],
  ["block", "Block"]
];

/**
 * Each app tool that has asked for approval, and what ky does next time: ask
 * with a card (the default), allow it while the user is in the chat, or block
 * it. With nobody in the chat, Allow asks too.
 */
function ToolPolicies() {
  const { policies, actions } = useContext(ApprovalsContext);
  const [refused, setRefused] = useState<string>();

  if (policies.length === 0) return null;

  return (
    <section className="card" aria-label="Approvals">
      {policies.map(({ tool, policy }) => (
        <div className="row" key={tool}>
          <span className="row-text">
            <span className="row-label">{tool}</span>
          </span>
          <Segmented small role="radiogroup" aria-label={`Approvals for ${tool}`} chosen={policy}>
            {POLICIES.map(([each, label]) => (
              <SegmentedOption key={each} checked={policy === each} onChoose={() => void actions.onPolicy(tool, each).then(setRefused)}>
                {label}
              </SegmentedOption>
            ))}
          </Segmented>
        </div>
      ))}
      <Problem text={refused} />
      <p className="card-foot quiet">Allow approves only while you're in the chat; in a routine or a peer's question it asks you.</p>
    </section>
  );
}

/** The connected Executor, which Edit turns into a form for its URL, keeping the token unless a new one is pasted. */
function ConnectedExecutor({ url, actions }: { url: string; actions: ExecutorActions }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    const edit = async (next: string, token: string) => {
      const reason = await actions.onConnect(next, token);

      if (reason === undefined) setEditing(false);

      return reason;
    };

    return <ConnectExecutor edit={{ url, cancel: () => setEditing(false) }} onConnect={edit} />;
  }

  return (
    <div className="card">
      <div className="row">
        <span className="row-tile">
          <Icon name="plug" size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">Connected</span>
          <span className="row-sub">{url}</span>
        </span>
        <button type="button" className="pill pressable" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="pill pressable" onClick={actions.onRemove}>
          Remove
        </button>
        <span className="status-dot" data-connected />
      </div>
    </div>
  );
}

/** What the form starts from: a new connection, or the connected URL to edit, where an empty token keeps the current one. */
type FormStart = { label: string; url: string; tokenHint: string; tokenRequired: boolean; cancel?: () => void };

const startFrom = (edit?: { url: string; cancel: () => void }): FormStart =>
  edit
    ? { label: "Edit Executor", url: edit.url, tokenHint: "Keep the current token", tokenRequired: false, cancel: edit.cancel }
    : { label: "Connect Executor", url: "", tokenHint: "Paste it here", tokenRequired: true };

function ConnectExecutor({ edit, onConnect }: { edit?: { url: string; cancel: () => void }; onConnect: ExecutorActions["onConnect"] }) {
  const start = startFrom(edit);
  const [url, setUrl] = useState(start.url);
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [refused, setRefused] = useState<string>();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTesting(true);
    const reason = await onConnect(url, token);

    setRefused(reason);
    setTesting(false);
    setToken("");
  };

  return (
    <form className="automation-form key-form" aria-label={start.label} onSubmit={save}>
      <div className="card">
        <label className="row">
          <span className="row-label">URL</span>
          <input
            className="key-input"
            aria-label="Executor URL"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://mcp.executor.sh/mcp"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="row">
          <span className="row-label">Token</span>
          <input
            className="key-input"
            aria-label="Executor token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={start.tokenHint}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <Problem text={refused} />
        <FormFoot testing={testing} ready={filled(url, start.tokenRequired ? token : url)} cancel={start.cancel} />
      </div>
    </form>
  );
}

function FormFoot({ testing, ready, cancel }: { testing: boolean; ready: boolean; cancel: (() => void) | undefined }) {
  return (
    <div className="card-foot">
      <VaultBadge />
      {cancel && (
        <button type="button" className="pill pressable" onClick={cancel}>
          Cancel
        </button>
      )}
      <button type="submit" className="pill primary pressable" disabled={testing || !ready}>
        {testing ? "Testing…" : "Test and connect"}
      </button>
    </div>
  );
}
