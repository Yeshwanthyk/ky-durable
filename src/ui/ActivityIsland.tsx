import { useEffect, useRef, useState } from "react";
import type { Activity } from "./activity";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "./Icon";

/** How long the island and an outgoing status take to fade; matches shell.css. */
const FADE_MS = 220;

type Shown = { readonly key: number; readonly activity: Activity };

/**
 * A small floating card under the header while the agent works: its avatar,
 * and what it is doing now. Statuses cross-fade; it fades out when idle.
 */
export function ActivityIsland({
  activity,
  name,
  variantId
}: {
  activity: Activity | null;
  name: string;
  variantId?: BlobVariantId;
}) {
  const counter = useRef(0);
  const [current, setCurrent] = useState<Shown | null>(null);
  const [previous, setPrevious] = useState<Shown | null>(null);
  const [leaving, setLeaving] = useState(false);

  const label = activity?.label ?? null;

  useEffect(() => {
    if (activity === null) {
      if (current === null) return;
      setLeaving(true);
      const timer = setTimeout(() => {
        setCurrent(null);
        setPrevious(null);
        setLeaving(false);
      }, FADE_MS);

      return () => clearTimeout(timer);
    }

    setLeaving(false);

    if (current?.activity.label === activity.label) return;
    setPrevious(current);
    setCurrent({ key: ++counter.current, activity });
    // Only a new label is a new status; a new object with the same words is not.
  }, [label]);

  useEffect(() => {
    if (previous === null) return;
    const timer = setTimeout(() => setPrevious(null), FADE_MS);

    return () => clearTimeout(timer);
  }, [previous]);

  if (current === null) return null;

  return (
    <div className="island-wrap" aria-hidden={leaving}>
      <div className="island" data-state={leaving ? "out" : "in"} role="status" aria-live="polite">
        {/* The header avatar already turns into dots while it works; this one keeps its face. */}
        <BotAvatar name={name} variantId={variantId} size={22} />
        <div className="island-status">
          {previous ? <IslandLine key={previous.key} activity={previous.activity} out /> : null}
          <IslandLine key={current.key} activity={current.activity} />
        </div>
      </div>
    </div>
  );
}

function IslandLine({ activity, out = false }: { activity: Activity; out?: boolean }) {
  return (
    <span className="island-line" data-out={out} aria-hidden={out}>
      <Icon name={activity.icon} size={12} />
      <span className="island-label">{activity.label}</span>
    </span>
  );
}
