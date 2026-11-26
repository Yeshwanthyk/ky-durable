import { type ReactNode, useId } from "react";
import { Segmented as Track, SegmentedOption } from "../Controls";

/** A setting: its label across the full width, a hint under it, and its control below both. */
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const id = useId();

  return (
    <div className="kit-setting" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint === undefined ? undefined : `${id}-hint`}>
      <span className="kit-setting-label" id={`${id}-label`}>
        {label}
      </span>
      {hint === undefined ? null : (
        <p className="kit-setting-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      <div className="kit-setting-control">{children}</div>
    </div>
  );
}

/** Two to four choices as a radio group, drawn by Controls' Segmented: arrows move the choice, the pill follows. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  small
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <Track role="radiogroup" aria-label={label} chosen={value} small={small}>
      {options.map((option) => (
        <SegmentedOption key={option.value} checked={option.value === value} onChoose={() => onChange(option.value)}>
          {option.label}
        </SegmentedOption>
      ))}
    </Track>
  );
}
