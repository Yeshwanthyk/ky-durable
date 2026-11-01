import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { Icon, type IconName } from "../chat-kit/Icon";

/** How far each arrow key moves a radio group's choice. */
const ARROWS = new Map([
  ["ArrowDown", 1],
  ["ArrowRight", 1],
  ["ArrowUp", -1],
  ["ArrowLeft", -1],
]);

/** In a radio group, an arrow picks the next option round the list and focuses it, as a native radio group does. */
function moveChoice(track: HTMLElement, event: KeyboardEvent<HTMLElement>): boolean {
  const step = ARROWS.get(event.key);

  if (step === undefined || track.getAttribute("role") !== "radiogroup") return false;
  const radios = [...track.querySelectorAll<HTMLButtonElement>(':scope > [role="radio"]:not(:disabled)')];
  const at = radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true" || radio === document.activeElement);
  const next = radios[(Math.max(at, 0) + step + radios.length) % radios.length];

  if (next === undefined) return false;
  event.preventDefault();
  next.click();
  next.focus();

  return true;
}

// A segmented control whose one pill slides under the chosen option, so you see where you went. As a radio group the
// arrow keys move the choice, and a choice made from the keyboard moves the pill without the slide.
export function Segmented({ chosen, small, children, onKeyDown, ...rest }: HTMLAttributes<HTMLDivElement> & { chosen: unknown; small?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const keyed = useRef(false);

  useLayoutEffect(() => {
    placePill(track.current, !keyed.current);
    keyed.current = false;
  }, [chosen]);
  // A new width (the panel resized, the font arrived) moves the pill without the slide.
  useEffect(() => {
    const element = track.current;

    if (element === null) return;
    const observer = new ResizeObserver(() => placePill(element, false));

    observer.observe(element);
    void document.fonts.ready.then(() => placePill(element, false));

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={track}
      className={small ? "segmented small" : "segmented"}
      onKeyDown={(event) => {
        onKeyDown?.(event);

        if (event.defaultPrevented || track.current === null) return;
        keyed.current = true;

        if (!moveChoice(track.current, event)) keyed.current = event.key === " " || event.key === "Enter";
      }}
      {...rest}
    >
      <span className="segmented-pill" aria-hidden="true" />
      {children}
    </div>
  );
}

/** Puts the pill under the chosen option; it slides only once it has been placed. */
function placePill(track: HTMLElement | null, glide: boolean) {
  const pill = track?.querySelector<HTMLElement>(":scope > .segmented-pill");
  const chosen = track?.querySelector<HTMLElement>(':scope > [aria-selected="true"], :scope > [aria-checked="true"]');

  if (!pill) return;
  pill.dataset.shown = String(chosen !== null && chosen !== undefined);

  if (!chosen) return;
  pill.dataset.glide = String(glide && pill.dataset.placed === "true");
  pill.dataset.placed = "true";
  pill.style.width = `${chosen.offsetWidth}px`;
  pill.style.height = `${chosen.offsetHeight}px`;
  pill.style.borderRadius = getComputedStyle(chosen).borderRadius;
  pill.style.transform = `translate(${chosen.offsetLeft}px, ${chosen.offsetTop}px)`;
}

/** One option of a segmented radio group: the chosen one takes Tab, the arrows move between them. */
export function SegmentedOption({ checked, onChoose, children, label }: { checked: boolean; onChoose: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" role="radio" aria-checked={checked} aria-label={label} tabIndex={checked ? 0 : -1} className="pressable" onClick={onChoose}>
      {children}
    </button>
  );
}

// An on/off switch: a track and a knob that slides across. From the keyboard it flips without the slide.
export function Switch({ on, label, disabled, onFlip }: { on: boolean; label: string; disabled?: boolean; onFlip: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" disabled={disabled} onClick={onFlip}>
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}

// A small whole number between `min` and `max`: − and + either side of a field you can also type in.
export function Stepper({
  id,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const set = (next: number) => {
    if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
  };

  return (
    <span className="stepper">
      <button type="button" className="stepper-button pressable" aria-label="Fewer" disabled={value <= min} onClick={() => set(value - 1)}>
        <Icon name="minus" size={12} />
      </button>
      <input
        id={id}
        className="stepper-value tabular"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(event) => set(event.target.valueAsNumber)}
      />
      <button type="button" className="stepper-button pressable" aria-label="More" disabled={value >= max} onClick={() => set(value + 1)}>
        <Icon name="plus" size={12} />
      </button>
    </span>
  );
}

/** A status's tone: green when something is up, red when it is down, amber in between, grey when there is nothing to say. */
export type Tone = "online" | "done" | "offline" | "failed" | "paused" | "waking" | "off" | "stopped";

// What a row is set to, on the row's trailing edge: a short word or count, after a small dot when it is a status.
// It is the row's quietest part, so it gives way (with an ellipsis) before the row's label does.
export function RowValue({ tone, children }: { tone?: Tone | undefined; children: ReactNode }) {
  return (
    <span className="row-value">
      {tone ? <span className="row-dot" data-tone={tone} aria-hidden="true" /> : null}
      <span className="row-value-text">{children}</span>
    </span>
  );
}

// Nothing to list yet, said inside a card where the list would be: an icon, one line, and what to do about it, if
// anything. It takes a row's height and rhythm, so an empty section sits in the same grid as a full one.
export function EmptyState({ icon, children, action }: { icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card empty-state">
      {icon ? (
        <span className="row-tile">
          <Icon name={icon} size={15} />
        </span>
      ) : null}
      <p className="empty-state-text">{children}</p>
      {action}
    </div>
  );
}

/** Where a secret goes once it is saved, beside the control that takes it. */
export function VaultBadge() {
  return (
    <span className="vault-badge">
      <Icon name="lock" size={12} />
      Stored in Vault
    </span>
  );
}
