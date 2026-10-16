import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ProactivityLevel, ProactivityView, Rate } from "../protocol";
import { Icon } from "./Icon";

type ProactivityActions = {
  readonly onView: () => Promise<ProactivityView>;
  readonly onSet: (level: ProactivityLevel) => Promise<ProactivityView>;
};

/** What Settings › Proactivity does; provided around the panel. */
export const ProactivityContext = createContext<ProactivityActions>({
  onView: () => Promise.reject(new Error("Not connected.")),
  onSet: () => Promise.reject(new Error("Not connected."))
});

const LEVELS: ReadonlyArray<{ level: ProactivityLevel; label: string; sub: string }> = [
  { level: "off", label: "Off", sub: "ky speaks only when you ask." },
  { level: "brief", label: "Brief only", sub: "A few lines ready when you first come back each day." },
  { level: "boundary", label: "Brief and boundary lines", sub: "The brief, and a line when a task ends, if one helps." }
];

/** A rate as a percentage of how many, or a dash while there is nothing to count. */
const percent = ({ count, of }: Rate) => (of === 0 ? "—" : `${Math.round((count / of) * 100)}%`);

const RATES: ReadonlyArray<{ key: "accepted" | "dismissed" | "expired"; label: string; sub: (rate: Rate) => string }> = [
  { key: "accepted", label: "Brief lines used", sub: ({ count, of }) => `${count} of ${of} acted on or pinned, last 7 days` },
  { key: "dismissed", label: "Brief lines dismissed", sub: ({ count, of }) => `${count} of ${of}, last 7 days` },
  { key: "expired", label: "Anticipations missed", sub: ({ count, of }) => `${count} of ${of} passed unseen, last 30 days` }
];

// How proactive ky is, and how it is going: the brief's acceptance and dismissals, and anticipations that passed unseen.
export function Proactivity() {
  const actions = useContext(ProactivityContext);
  const [view, setView] = useState<ProactivityView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = useCallback((error: Error) => setProblem(error.message), []);

  useEffect(() => {
    actions.onView().then(setView, fail);
  }, [actions, fail]);

  if (view === null) return <p className="group-empty">{problem ?? "Loading…"}</p>;

  const choose = (level: ProactivityLevel) => {
    setView({ ...view, level });
    actions.onSet(level).then(setView, fail);
  };

  return (
    <>
      <section className="group" id="settings-proactivity">
        <h3 className="group-label">Unasked</h3>
        <ul className="card choices" role="radiogroup" aria-label="Proactivity">
          {LEVELS.map(({ level, label, sub }) => (
            <li key={level}>
              <button type="button" role="radio" aria-checked={view.level === level} className="choice" onClick={() => choose(level)}>
                <span className="choice-text">
                  <span>{label}</span>
                  <span className="row-sub">{sub}</span>
                </span>
                <Icon name="check" size={14} className="choice-check" />
              </button>
            </li>
          ))}
        </ul>
        {problem === null ? null : <p className="group-note">{problem}</p>}
      </section>
      <section className="group">
        <h3 className="group-label">How it is going</h3>
        <ul className="card" aria-label="Proactivity rates">
          {RATES.map(({ key, label, sub }) => (
            <li key={key} className="row">
              <span className="row-text">
                <span className="row-label">{label}</span>
                <span className="row-sub">{sub(view[key])}</span>
              </span>
              <span className="row-value">{percent(view[key])}</span>
            </li>
          ))}
        </ul>
        <p className="group-note">After two weeks with fewer than a quarter of its lines used, the brief keeps to two lines.</p>
      </section>
    </>
  );
}
