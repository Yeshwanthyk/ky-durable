import { createContext, type FormEvent, useCallback, useContext, useEffect, useState } from "react";
import type { SpendTotals, SpendView } from "../protocol";
import { RowValue } from "./Controls";
import { Problem } from "./Subscriptions";

type SpendActions = {
  readonly open: boolean;
  readonly onView: () => Promise<SpendView>;
  readonly onCap: (usd: number | null) => Promise<SpendView | { readonly refused: string }>;
};

/** What Settings › Spend does; provided around the panel. */
export const SpendContext = createContext<SpendActions>({
  open: false,
  onView: () => Promise.reject(new Error("Not connected.")),
  onCap: () => Promise.reject(new Error("Not connected.")),
});

const dollars = (amount: number) => `$${amount.toFixed(amount > 0 && amount < 1 ? 4 : 2)}`;

const tokens = (totals: SpendTotals) => `${(totals.tokensIn + totals.tokensOut).toLocaleString()} tokens, ${totals.calls} calls`;

const SOURCES = new Map([
  ["chat", "Chat"],
  ["subagent", "Subagents"],
  ["automation", "Automations"],
  ["look", "Looks"],
  ["dream", "Dreams"],
  ["episode", "Episodes"],
  ["skill-review", "Skill reviews"],
  ["mail", "Mail"],
  ["peer", "Peers"],
  ["machine-task", "Machine tasks"],
  ["call", "Titles, routing and summaries"],
  ["other", "Other"],
]);

function useSpend() {
  const actions = useContext(SpendContext);
  const [view, setView] = useState<SpendView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = useCallback((error: Error) => setProblem(error.message), []);

  useEffect(() => {
    if (actions.open) actions.onView().then(setView, fail);
  }, [actions, fail]);

  return { actions, view, setView, problem, setProblem, fail };
}

/** Today's spend, on Settings' first page. */
export function SpendValue() {
  const { view } = useSpend();

  return view === null ? null : <RowValue>{dollars(view.today.costUsd)}</RowValue>;
}

function Cap({ view, onSet }: { readonly view: SpendView; readonly onSet: (usd: number | null) => void }) {
  const [draft, setDraft] = useState(view.capUsd === null ? "" : String(view.capUsd));

  const save = (event: FormEvent) => {
    event.preventDefault();
    onSet(Number(draft));
  };

  return (
    <form className="card" aria-label="Daily cap" onSubmit={save}>
      <label className="row">
        <span className="row-text">
          <span className="row-label">Daily cap, USD</span>
          <span className="row-sub">{view.capUsd === null ? "Off: nothing waits" : view.capped ? "Reached: unasked work waits until tomorrow" : "Unasked work waits once today reaches it"}</span>
        </span>
        <input className="key-input" aria-label="Daily cap in dollars" type="number" inputMode="decimal" min="0" step="0.01" placeholder="None" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <div className="card-foot">
        {view.capUsd === null ? null : (
          <button type="button" className="pill pressable" onClick={() => onSet(null)}>
            Clear
          </button>
        )}
        <button type="submit" className="pill primary pressable" disabled={draft.trim() === ""}>
          Set cap
        </button>
      </div>
    </form>
  );
}

// What the models cost today and this month, today by purpose and source, and the daily cap that holds unasked work.
export function Spend() {
  const { actions, view, setView, problem, setProblem, fail } = useSpend();

  if (view === null) return <p className="group-empty">{problem ?? "Loading…"}</p>;

  const setCap = (usd: number | null) => {
    setProblem(null);
    actions.onCap(usd).then((answer) => ("refused" in answer ? setProblem(answer.refused) : setView(answer)), fail);
  };

  return (
    <div id="settings-spend">
      <section className="group" aria-label="Totals">
        <ul className="card">
          <li className="row">
            <span className="row-text">
              <span className="row-label">Today</span>
              <span className="row-sub">{tokens(view.today)}</span>
            </span>
            <RowValue tone={view.capped ? "paused" : undefined}>{dollars(view.today.costUsd)}</RowValue>
          </li>
          <li className="row">
            <span className="row-text">
              <span className="row-label">This month</span>
              <span className="row-sub">{tokens(view.month)}</span>
            </span>
            <RowValue>{dollars(view.month.costUsd)}</RowValue>
          </li>
        </ul>
      </section>
      <section className="group">
        <h3 className="group-label">Today by purpose</h3>
        {view.lines.length === 0 ? (
          <p className="group-empty">Nothing yet today.</p>
        ) : (
          <ul className="card" aria-label="Today by purpose">
            {view.lines.map((line) => (
              <li key={`${line.purpose}/${line.source}`} className="row">
                <span className="row-text">
                  <span className="row-label">{SOURCES.get(line.source) ?? line.source}</span>
                  <span className="row-sub">
                    {line.purpose} · {tokens(line)}
                  </span>
                </span>
                <RowValue>{dollars(line.costUsd)}</RowValue>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="group">
        <h3 className="group-label">Cap</h3>
        <Cap key={String(view.capUsd)} view={view} onSet={setCap} />
        {view.held.length === 0 ? null : (
          <ul className="card" aria-label="Held today">
            {view.held.map((held) => (
              <li key={held.work} className="row">
                <span className="row-text">
                  <span className="row-label">{held.work} held</span>
                  <span className="row-sub">{held.why}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Problem text={problem ?? undefined} />
    </div>
  );
}
