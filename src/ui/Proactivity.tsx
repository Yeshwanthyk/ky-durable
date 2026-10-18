import { createContext, type KeyboardEvent, useCallback, useContext, useEffect, useRef, useState } from "react";
import { RIGHT_AWAY_MOST } from "../dreaming/contract";
import type { ProactivityLevel, ProactivityView } from "../protocol";
import { Icon } from "./Icon";

type ProactivityActions = {
  readonly onView: () => Promise<ProactivityView>;
  readonly onSet: (level: ProactivityLevel) => Promise<ProactivityView>;
  readonly onLooks: (looks: readonly string[]) => Promise<ProactivityView>;
  readonly onRightAway: (most: number) => Promise<ProactivityView>;
  readonly onPushKey: () => Promise<string>;
  readonly onSubscribe: (device: PushDevice) => Promise<null>;
  readonly onUnsubscribe: (endpoint: string) => Promise<null>;
};

/** A device's push subscription as ky keeps it: its endpoint and keys, base64url. */
type PushDevice = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

/** What Settings › Proactivity does; provided around the panel. */
export const ProactivityContext = createContext<ProactivityActions>({
  onView: () => Promise.reject(new Error("Not connected.")),
  onSet: () => Promise.reject(new Error("Not connected.")),
  onLooks: () => Promise.reject(new Error("Not connected.")),
  onRightAway: () => Promise.reject(new Error("Not connected.")),
  onPushKey: () => Promise.reject(new Error("Not connected.")),
  onSubscribe: () => Promise.reject(new Error("Not connected.")),
  onUnsubscribe: () => Promise.reject(new Error("Not connected."))
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

/** Whether this browser can show ky's pushes at all. */
const pushable = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** An iPhone or iPad with ky open in Safari rather than from the Home Screen, where it gets no pushes. */
const iosInBrowser = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;

/** This device's push subscription, if it has one. */
async function subscription(): Promise<PushSubscription | null> {
  return (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null;
}

/** ky's service worker on this page, which a subscription is made through. */
async function worker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.getRegistration();

  if (!registration) throw new Error("ky's service worker isn't running on this page; reload it and try again.");

  return registration;
}

/** ky's VAPID public key's bytes, from its base64url. */
const keyBytes = (key: string) => Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

/** Subscribe this device with ky's VAPID `key`, once notifications are allowed. */
async function subscribeWith(key: string): Promise<PushDevice> {
  return deviceOf(await (await worker()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
}

/** Ask to show notifications, and subscribe this device with ky's VAPID `key`. */
async function subscribe(key: string): Promise<PushDevice> {
  // First, while the click still counts as the user's: Safari asks only then.
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for ky in this browser's settings.");

  return subscribeWith(key);
}

/** Whether `made` was subscribed with ky's VAPID `key`. */
function madeWith(made: PushSubscription, key: string): boolean {
  const was = made.options.applicationServerKey;

  return was !== null && new Uint8Array(was).join() === keyBytes(key).join();
}

/**
 * Whether this device gets ky's pushes, making sure ky knows it: a subscription made with another VAPID key (a new
 * Vault) is made again with `key`, and either way ky is told of it, as it may have lost its row (a restore).
 */
async function resume(key: string, remember: (device: PushDevice) => Promise<null>): Promise<boolean> {
  const made = await subscription();

  if (made === null || Notification.permission !== "granted") return false;
  const device = madeWith(made, key) ? deviceOf(made) : await made.unsubscribe().then(() => subscribeWith(key));
  await remember(device);

  return true;
}

/** A subscription as ky keeps it; ky refuses one without its keys. */
function deviceOf(made: PushSubscription): PushDevice {
  const keys = made.toJSON().keys ?? {};

  return { endpoint: made.endpoint, p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" };
}

/** Unsubscribe this device, if it is subscribed, and tell ky through `forget`. */
async function unsubscribe(forget: (endpoint: string) => Promise<null>): Promise<void> {
  const made = await subscription();

  if (!made) return;
  await made.unsubscribe();
  await forget(made.endpoint);
}

/** What to say under the switch, if anything: on an iPhone in Safari, how to get notifications at all. */
function deviceNote(can: boolean, problem: string | null): string | null {
  if (iosInBrowser()) return "On iPhone, add ky to your Home Screen first (Share › Add to Home Screen), then turn this on there.";

  return can ? problem : "This browser can't show notifications from ky.";
}

/** Notifications on this device, on or off, and how many posts a day may notify. */
function Notifications({ view, onRightAway }: { readonly view: ProactivityView; readonly onRightAway: (most: number) => void }) {
  const actions = useContext(ProactivityContext);
  const [key, setKey] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const can = pushable();

  useEffect(() => {
    if (!can) return;
    // The key is fetched ahead, so a click goes straight to asking.
    actions
      .onPushKey()
      .then(async (current) => {
        setKey(current);
        setOn(await resume(current, actions.onSubscribe));
      })
      .catch((error: Error) => setProblem(error.message));
  }, [actions, can]);

  const toggle = () => {
    if (key === null) return;
    setProblem(null);
    (on ? unsubscribe(actions.onUnsubscribe) : subscribe(key).then(actions.onSubscribe)).then(
      () => setOn(!on),
      (error: Error) => setProblem(error.message)
    );
  };

  const note = deviceNote(can, problem);

  return (
    <>
      <h3 className="group-label">Notifications</h3>
      <div className="card">
        <div className="row">
          <span className="choice-text">
            <span>Notifications on this device</span>
            <span className="row-sub">What ky posts unasked shows here, and a tap opens its chat.</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Notifications on this device"
            className="pill pressable"
            disabled={!can || key === null}
            onClick={toggle}
          >
            {on ? "On" : "Off"}
          </button>
        </div>
        <div className="row">
          <label className="choice-text" htmlFor="right-away">
            <span>Right away, a day</span>
            <span className="row-sub">Past this many, a post still lands in its chat, without a notification.</span>
          </label>
          <input
            id="right-away"
            type="number"
            min={0}
            max={RIGHT_AWAY_MOST}
            value={view.rightAway}
            onChange={(event) => {
              const most = event.target.valueAsNumber;

              if (Number.isInteger(most) && most >= 0 && most <= RIGHT_AWAY_MOST) onRightAway(most);
            }}
          />
        </div>
      </div>
      {note === null ? null : <p className="group-note">{note}</p>}
    </>
  );
}

// How proactive ky is: on or off, when it looks, and what notifies this device.
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

  const setRightAway = (most: number) => {
    setProblem(null);
    setView({ ...view, rightAway: most });
    actions.onRightAway(most).then(setView, fail);
  };

  return (
    <section className="group" id="settings-proactivity">
      <h3 className="group-label">Unasked</h3>
      <Levels level={view.level} onChoose={choose} />
      <Looks view={view} onChange={setLooks} />
      <Notifications view={view} onRightAway={setRightAway} />
      {problem === null ? null : <p className="group-note">{problem}</p>}
    </section>
  );
}
