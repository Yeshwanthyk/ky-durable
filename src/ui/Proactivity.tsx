import { createContext, type KeyboardEvent, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ProactivityLevel, ProactivityView } from "../protocol";
import { Icon } from "./Icon";

type ProactivityActions = {
  readonly onView: () => Promise<ProactivityView>;
  readonly onSet: (level: ProactivityLevel) => Promise<ProactivityView>;
  readonly onLooks: (looks: readonly string[]) => Promise<ProactivityView>;
};

/** What Settings › Proactivity does; provided around the panel. */
export const ProactivityContext = createContext<ProactivityActions>({
  onView: () => Promise.reject(new Error("Not connected.")),
  onSet: () => Promise.reject(new Error("Not connected.")),
  onLooks: () => Promise.reject(new Error("Not connected."))
});

/** Look times a user may set, at most, as the server holds them (src/dreaming/contract.ts LOOK_TIMES). */
const MOST_LOOKS = 4;

const LEVELS: ReadonlyArray<{ level: ProactivityLevel; label: string; sub: string }> = [
  { level: "on", label: "On", sub: "ky looks over your day at set times and messages you when something needs you." },
  { level: "off", label: "Off", sub: "ky says nothing unasked. Check-ins are their own switch, in Automations." }
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

/** The levels as one radio group: the chosen one takes Tab, and the arrows move the choice. */
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

/** The look times while Proactivity is on, each removable, and a time to add while there is room. */
function Looks({ view, onChange }: { readonly view: ProactivityView; readonly onChange: (looks: readonly string[]) => void }) {
  const [adding, setAdding] = useState("");
  const { looks } = view;

  if (view.level === "off") return null;

  const add = () => {
    if (adding === "") return;
    onChange([...looks, adding]);
    setAdding("");
  };

  return (
    <>
      <h3 className="group-label">Looks, your time</h3>
      <div className="card">
        {looks.map((time) => (
          <div key={time} className="row">
            <span className="row-label">{time}</span>
            <button type="button" className="pill pressable" aria-label={`Remove ${time}`} onClick={() => onChange(looks.filter((each) => each !== time))}>
              Remove
            </button>
          </div>
        ))}
        {looks.length < MOST_LOOKS ? (
          <div className="row">
            <input type="time" aria-label="Look time" value={adding} onChange={(event) => setAdding(event.target.value)} />
            <button type="button" className="pill pressable" disabled={adding === ""} onClick={add}>
              Add
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

// How proactive ky is: on or off, and when it looks.
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

  const setLooks = (looks: readonly string[]) => {
    setProblem(null);
    actions.onLooks(looks).then(setView, fail);
  };

  return (
    <section className="group" id="settings-proactivity">
      <h3 className="group-label">Unasked</h3>
      <Levels level={view.level} onChoose={choose} />
      <Looks view={view} onChange={setLooks} />
      {problem === null ? null : <p className="group-note">{problem}</p>}
    </section>
  );
}
