import { createContext, type KeyboardEvent, useCallback, useContext, useEffect, useRef, useState } from "react";
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
  { level: "off", label: "Off", sub: "No brief. Check-ins are their own switch, in Automations." },
  { level: "brief", label: "Brief only", sub: "A few lines ready when you first come back each day." },
  { level: "boundary", label: "Brief and boundary lines", sub: "The brief, and a line when a task ends, if one helps." }
];

/** How far each arrow key moves the choice. */
const ARROWS = new Map([
  ["ArrowDown", 1],
  ["ArrowRight", 1],
  ["ArrowUp", -1],
  ["ArrowLeft", -1]
]);

/** The level an arrow key moves to from `level`, round the list, as a radio group's arrows do. */
function levelAfter(level: ProactivityLevel, key: string): ProactivityLevel | undefined {
  const step = ARROWS.get(key);

  if (step === undefined) return undefined;
  const index = LEVELS.findIndex((each) => each.level === level);

  return LEVELS[(index + step + LEVELS.length) % LEVELS.length]?.level;
}

/** The three levels as one radio group: the chosen one takes Tab, and the arrows move the choice. */
function Levels({ level, onChoose }: { readonly level: ProactivityLevel; readonly onChoose: (level: ProactivityLevel) => void }) {
  const group = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    const next = levelAfter(level, event.key);

    if (next === undefined) return;
    event.preventDefault();
    onChoose(next);
    group.current?.querySelector<HTMLElement>(`[data-level="${next}"]`)?.focus();
  };

  return (
    <div ref={group} className="card choices" role="radiogroup" aria-label="Proactivity" onKeyDown={onKeyDown}>
      {LEVELS.map((each) => (
        <button
          key={each.level}
          type="button"
          role="radio"
          data-level={each.level}
          aria-checked={level === each.level}
          tabIndex={level === each.level ? 0 : -1}
          className="choice"
          onClick={() => onChoose(each.level)}
        >
          <span className="choice-text">
            <span>{each.label}</span>
            <span className="row-sub">{each.sub}</span>
          </span>
          <Icon name="check" size={14} className="choice-check" />
        </button>
      ))}
    </div>
  );
}

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
        <Levels level={view.level} onChoose={choose} />
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
