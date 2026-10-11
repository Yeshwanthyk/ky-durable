import { createContext, type FormEvent, useContext, useState } from "react";
import type { ExecutorView } from "../protocol";
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
      {view?.url ? (
        <div className="card">
          <div className="row">
            <span className="row-tile">
              <Icon name="plug" size={15} />
            </span>
            <span className="row-text">
              <span className="row-label">Connected</span>
              <span className="row-sub">{view.url}</span>
            </span>
            <button type="button" className="pill pressable" onClick={actions.onRemove}>
              Remove
            </button>
            <span className="status-dot" data-connected />
          </div>
        </div>
      ) : (
        <ConnectExecutor onConnect={actions.onConnect} />
      )}
      <p className="group-note">Gives ky your apps' tools, like email and calendar. The token stays in ky's Vault.</p>
    </section>
  );
}

function ConnectExecutor({ onConnect }: { onConnect: ExecutorActions["onConnect"] }) {
  const [url, setUrl] = useState("");
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
    <form className="automation-form key-form" aria-label="Connect Executor" onSubmit={save}>
      <div className="card">
        <label className="row">
          <span className="row-label">URL</span>
          <input
            className="key-input"
            aria-label="Executor URL"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://…/mcp"
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
            placeholder="Paste it here"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <Problem text={refused} />
        <div className="card-foot">
          <button type="submit" className="pill primary pressable" disabled={testing || !filled(url, token)}>
            {testing ? "Testing…" : "Test and connect"}
          </button>
        </div>
      </div>
    </form>
  );
}
