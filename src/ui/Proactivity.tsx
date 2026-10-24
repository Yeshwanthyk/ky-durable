import { createContext, type KeyboardEvent, useCallback, useContext, useEffect, useState } from "react";
import { RIGHT_AWAY_MOST } from "../dreaming/contract";
import type { ZoneView, ProactivityLevel, ProactivityView } from "../protocol";
import { Problem } from "./Subscriptions";
import { RowValue, Segmented, SegmentedOption, Stepper, Switch } from "./Controls";
import { Icon } from "./Icon";

type ProactivityActions = {
  readonly open: boolean;
  readonly onView: () => Promise<ProactivityView>;
  readonly onSet: (level: ProactivityLevel) => Promise<ProactivityView>;
  readonly onLooks: (looks: readonly string[]) => Promise<ProactivityView>;
  readonly onRightAway: (most: number) => Promise<ProactivityView>;
  readonly onZone: () => Promise<ZoneView>;
  readonly onSetZone: (zone: string | null) => Promise<ZoneView>;
  readonly onPushKey: () => Promise<string>;
  readonly onSubscribe: (device: PushDevice) => Promise<null>;
  readonly onUnsubscribe: (endpoint: string) => Promise<null>;
};

/** A device's push subscription as ky keeps it: its endpoint and keys, base64url. */
type PushDevice = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

/** What Settings › Proactivity does; provided around the panel. */
export const ProactivityContext = createContext<ProactivityActions>({
  open: false,
  onView: () => Promise.reject(new Error("Not connected.")),
  onSet: () => Promise.reject(new Error("Not connected.")),
  onLooks: () => Promise.reject(new Error("Not connected.")),
  onRightAway: () => Promise.reject(new Error("Not connected.")),
  onZone: () => Promise.reject(new Error("Not connected.")),
  onSetZone: () => Promise.reject(new Error("Not connected.")),
  onPushKey: () => Promise.reject(new Error("Not connected.")),
  onSubscribe: () => Promise.reject(new Error("Not connected.")),
  onUnsubscribe: () => Promise.reject(new Error("Not connected."))
});

/** Look times a user may set, at most, as the server holds them (src/dreaming/contract.ts LOOK_TIMES). */
const MOST_LOOKS = 4;

/** Each level, and the one line under the switch that says what it does. */
const LEVELS: ReadonlyArray<{ level: ProactivityLevel; label: string; sub: string }> = [
  { level: "on", label: "On", sub: "When you're needed" },
  { level: "off", label: "Off", sub: "Only when you write" },
];

/** The levels as one segmented radio group: the chosen one takes Tab, and the arrows move the choice. */
function Levels({ level, onChoose }: { readonly level: ProactivityLevel; readonly onChoose: (level: ProactivityLevel) => void }) {
  return (
    <div className="card">
      <div className="row">
        <span className="row-text">
          <span className="row-label">Messages you first</span>
          <span className="row-sub">{LEVELS.find((each) => each.level === level)?.sub}</span>
        </span>
        <Segmented small role="radiogroup" aria-label="Proactivity" chosen={level}>
          {LEVELS.map((each) => (
            <SegmentedOption key={each.level} checked={level === each.level} onChoose={() => onChoose(each.level)}>
              {each.label}
            </SegmentedOption>
          ))}
        </Segmented>
      </div>
    </div>
  );
}

/** Focus a field as it appears: it appears because the user asked for it. */
const focusOnce = (field: HTMLInputElement | null) => field?.focus();

/** The look times as chips, each removable, and a time to add while there is room. */
function Looks({ looks, onChange }: { readonly looks: readonly string[]; readonly onChange: (looks: readonly string[]) => void }) {
  const [adding, setAdding] = useState<string | null>(null);

  const add = () => {
    if (!adding) return;
    onChange([...looks, adding]);
    setAdding(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") add();

    if (event.key === "Escape") setAdding(null);
  };

  return (
    <div className="row looks">
      <span className="row-label">Looks at</span>
      <ul className="chips" aria-label="When ky looks">
        {looks.map((time) => (
          <li key={time} className="chip tabular">
            <span>{time}</span>
            <button type="button" className="chip-remove pressable" aria-label={`Remove ${time}`} onClick={() => onChange(looks.filter((each) => each !== time))}>
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}
        {looks.length >= MOST_LOOKS ? null : adding === null ? (
          <li>
            <button type="button" className="chip chip-add pressable" aria-label="Add a time" onClick={() => setAdding("")}>
              <Icon name="plus" size={12} />
            </button>
          </li>
        ) : (
          <li className="chip chip-field">
            <input ref={focusOnce} type="time" aria-label="Look time" value={adding} onKeyDown={onKeyDown} onChange={(event) => setAdding(event.target.value)} />
            <button type="button" className="chip-confirm pressable" disabled={adding === ""} onClick={add}>
              Add
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** The select's value for following where the browser connects. */
const AUTOMATIC = "";

/** Every zone this browser knows, for the select; none where it can't list them. */
const ZONES: readonly string[] = Intl.supportedValuesOf?.("timeZone") ?? [];

/** The time now in `zone`, as the user reads a clock; null where this browser doesn't know the zone. */
function timeIn(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date());
  } catch {
    return null;
  }
}

/** The time in `zone` now, kept current. */
function LocalTime({ zone }: { readonly zone: string }) {
  const [, tick] = useState(0);

  useEffect(() => {
    const clock = setInterval(() => tick((n) => n + 1), 30_000);

    return () => clearInterval(clock);
  }, []);

  return <>{timeIn(zone) ?? zone}</>;
}

/** A zone as people name it: its city, "America/Toronto" as Toronto. */
const cityOf = (zone: string) => (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");

/** What the time zone row says: the pinned zone's city, or Auto and the city it follows. */
function zoneWords(pinned: string | null, detected: string | null): string {
  if (pinned !== null) return cityOf(pinned);

  return detected === null ? "Auto" : `Auto · ${cityOf(detected)}`;
}

/** The user's time zone, followed from where they connect or pinned, and the time there now: a row that opens the list. */
function TimeZone({ onFail }: { readonly onFail: (error: Error) => void }) {
  const actions = useContext(ProactivityContext);
  const [view, setView] = useState<ZoneView | null>(null);

  useEffect(() => {
    if (!actions.open) return;

    actions.onZone().then(setView, onFail);

    // Asked again on coming back, as another device may have pinned it meanwhile; a failed ask keeps what shows.
    const ask = () => {
      if (document.visibilityState === "visible") actions.onZone().then(setView, () => undefined);
    };

    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", ask);

    return () => {
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [actions, onFail]);

  if (view === null) return null;
  const pinned = view.pinned ? view.zone : null;
  const detected = view.detected ?? (view.pinned ? null : view.zone);

  return (
    <label className="row picker">
      <span className="row-text">
        <span className="row-label">Time zone</span>
        {view.zone === null ? null : (
          <span className="row-sub">
            <LocalTime zone={view.zone} />
          </span>
        )}
      </span>
      <RowValue>{zoneWords(pinned, detected)}</RowValue>
      <Icon name="chevronUpDown" size={14} className="row-chevron" />
      <select aria-label="Time zone" className="picker-select" value={pinned ?? AUTOMATIC} onChange={(event) => actions.onSetZone(event.target.value || null).then(setView, onFail)}>
        <option value={AUTOMATIC}>{`Automatic (${detected ?? "not known yet"})`}</option>
        {pinned !== null && !ZONES.includes(pinned) ? <option value={pinned}>{pinned}</option> : null}
        {ZONES.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
    </label>
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
  if (iosInBrowser()) return "Add ky to your Home Screen first";

  return can ? problem : "Not supported in this browser";
}

/** Notifications on this device, on or off, and how many posts a day may notify. */
function Notifications({ view, onRightAway }: { readonly view: ProactivityView; readonly onRightAway: (most: number) => void }) {
  const actions = useContext(ProactivityContext);
  const [key, setKey] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const can = pushable();

  useEffect(() => {
    if (!can || !actions.open) return;
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
    <section className="group">
      <h3 className="group-label">Notifications</h3>
      <div className="card">
        <div className="row">
          <span className="row-text">
            <span className="row-label">This device</span>
            {note === null ? null : (
              <span className="row-sub" data-problem={problem !== null && note === problem}>
                {note}
              </span>
            )}
          </span>
          <Switch on={on} label="Notifications on this device" disabled={!can || key === null} onFlip={toggle} />
        </div>
        <div className="row">
          <label className="row-text" htmlFor="right-away">
            <span className="row-label">Per day, at most</span>
            <span className="row-sub">More arrive silently.</span>
          </label>
          <Stepper id="right-away" value={view.rightAway} min={0} max={RIGHT_AWAY_MOST} onChange={onRightAway} />
        </div>
      </div>
    </section>
  );
}

/** Whether Proactivity is on, for its row on Settings' first page; nothing until ky says. */
export function ProactivityValue() {
  const actions = useContext(ProactivityContext);
  const [level, setLevel] = useState<ProactivityLevel | null>(null);

  useEffect(() => {
    if (actions.open) actions.onView().then((view) => setLevel(view.level), () => undefined);
  }, [actions]);

  return level === null ? null : <RowValue tone={level === "on" ? "online" : "off"}>{LEVELS.find((each) => each.level === level)?.label}</RowValue>;
}

// How proactive ky is: on or off, when it looks, and what notifies this device.
export function Proactivity() {
  const actions = useContext(ProactivityContext);
  const [view, setView] = useState<ProactivityView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = useCallback((error: Error) => setProblem(error.message), []);

  useEffect(() => {
    // Asked once the socket is open, and again on each reconnect.
    if (actions.open) actions.onView().then(setView, fail);
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
    <div id="settings-proactivity">
      <section className="group" aria-label="Unasked">
        <Levels level={view.level} onChoose={choose} />
      </section>
      <section className="group">
        <h3 className="group-label">Schedule</h3>
        <div className="card">
          {view.level === "off" ? null : <Looks looks={view.looks} onChange={setLooks} />}
          <TimeZone onFail={fail} />
        </div>
      </section>
      <Notifications view={view} onRightAway={setRightAway} />
      <Problem text={problem ?? undefined} />
    </div>
  );
}
