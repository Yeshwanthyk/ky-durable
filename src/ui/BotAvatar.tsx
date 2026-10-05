import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  blobPhaseForIdentity,
  blobVariantById,
  blobVariantForIdentity,
  type BlobVariantId,
} from "./blob-catalog";
import { BotEngine, type BotFrame } from "./bloub/engine";
import { DEMI_VIEWBOX, RAYON } from "./bloub/repere";

const IDLE_VIEWBOX_RADIUS = 126;

const FRAME_INTERVAL = 1000 / 60;

// Ziggy's animated blob avatar (../ziggy/clients/web/src/components/bot-avatar.tsx), with `still`
// for lists: one frame, no animation loop per row. It looks around and blinks at rest, winks
// under the pointer, and turns into pulsing dots while it works.
export interface BotAvatarProps {
  name: string;
  /** Draw one frame and never animate. */
  still?: boolean;
  identity?: string;
  variantId?: BlobVariantId;
  active?: boolean;
  size?: number;
  className?: string;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function BotAvatar({
  name,
  identity = name,
  variantId,
  still = false,
  active = false,
  size = 40,
  className,
}: BotAvatarProps) {
  const reducedMotion = useReducedMotion();
  const animated = !reducedMotion && !still;

  const variant = useMemo(
    () => (variantId ? blobVariantById(variantId) : undefined) ?? blobVariantForIdentity(identity),
    [identity, variantId],
  );

  const phase = useMemo(() => blobPhaseForIdentity(identity), [identity]);

  const engine = useMemo(
    () => new BotEngine(RAYON, "idle", variant.shape.radii),
    [identity, variant.id, variant.shape.radii],
  );

  const engineTime = useRef(phase);
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(phase));
  /** A wink while the pointer is on it, so it answers being noticed. */
  const [poked, setPoked] = useState(false);
  const reactId = useId();
  const maskId = `bloub-mask-${reactId.replaceAll(":", "")}`;

  useEffect(() => {
    engineTime.current = phase;
    setFrame(engine.sample(phase));
  }, [engine, phase]);

  useEffect(() => {
    engine.setState(active ? "thinking" : poked ? "wink" : "idle", engineTime.current);
    engine.setLook({ yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 }, engineTime.current);

    if (reducedMotion || still) {
      engineTime.current += 1;
      setFrame(engine.sample(engineTime.current));

      return;
    }

    if (!animated) return;

    let animationFrame = 0;
    let segmentStartedAt: number | undefined;
    let lastRenderedAt = -Infinity;

    const tick = (now: number) => {
      segmentStartedAt ??= now;

      if (now - lastRenderedAt >= FRAME_INTERVAL) {
        engineTime.current += (now - segmentStartedAt) / 1000;
        segmentStartedAt = now;
        lastRenderedAt = now;
        setFrame(engine.sample(engineTime.current));
      }

      animationFrame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (document.visibilityState === "hidden" || animationFrame !== 0) return;
      segmentStartedAt = undefined;
      animationFrame = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (animationFrame === 0) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      segmentStartedAt = undefined;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stop();
    };
  }, [active, animated, engine, poked, reducedMotion, still]);

  const ink = variant.color.hex;
  const viewBoxRadius = IDLE_VIEWBOX_RADIUS;

  return (
    <svg
      aria-label={`${name}${active ? " is working" : ""}`}
      className={className}
      height={size}
      onPointerEnter={animated ? () => setPoked(true) : undefined}
      onPointerLeave={animated ? () => setPoked(false) : undefined}
      role="img"
      viewBox={`${-viewBoxRadius} ${-viewBoxRadius} ${viewBoxRadius * 2} ${viewBoxRadius * 2}`}
      width={size}
    >
      <defs>
        <mask
          height={DEMI_VIEWBOX * 2}
          id={maskId}
          maskUnits="userSpaceOnUse"
          width={DEMI_VIEWBOX * 2}
          x={-DEMI_VIEWBOX}
          y={-DEMI_VIEWBOX}
        >
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, index) => (
            <path d={eye.d} fill="#000" key={index} opacity={eye.alpha} transform={eye.matrix} />
          ))}
          {frame.notch ? (
            <circle cx={frame.notch.x} cy={frame.notch.y} fill="#000" r={frame.notch.r} />
          ) : null}
        </mask>
        {frame.arcs.map((arc) => (
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={`${maskId}-${arc.id}`}
            key={arc.id}
            x1={arc.grad.x1}
            x2={arc.grad.x2}
            y1={arc.grad.y1}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((stop, index) => (
              <stop
                key={stop}
                offset={index / Math.max(1, arc.grad.stops.length - 1)}
                stopColor={stop}
              />
            ))}
          </linearGradient>
        ))}
      </defs>

      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            d={arc.back}
            key={`back-${arc.id}`}
            opacity={arc.opacity}
            stroke={`url(#${maskId}-${arc.id})`}
            strokeWidth={arc.width}
          />
        ))}
      </g>

      {frame.dotsBehind ? <Dots dots={frame.dots} fill={ink} /> : null}

      <g opacity={frame.bodyAlpha}>
        <g mask={`url(#${maskId})`}>
          <rect
            fill={ink}
            height={DEMI_VIEWBOX * 2}
            width={DEMI_VIEWBOX * 2}
            x={-DEMI_VIEWBOX}
            y={-DEMI_VIEWBOX}
          />
        </g>
        {variant.color.id === "creme" ? (
          <g fill="#746e62">
            <path d={frame.bodyPath} fill="none" stroke="#a39c90" strokeWidth={2} />
            {frame.eyes.map((eye, index) => (
              <path d={eye.d} key={index} opacity={eye.alpha} transform={eye.matrix} />
            ))}
          </g>
        ) : null}
      </g>

      {!frame.dotsBehind ? <Dots dots={frame.dots} fill={ink} /> : null}

      {frame.notif ? (
        <circle cx={frame.notif.x} cy={frame.notif.y} fill="#1688f8" r={frame.notif.r} />
      ) : null}

      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            d={arc.front}
            key={`front-${arc.id}`}
            opacity={arc.opacity}
            stroke={`url(#${maskId}-${arc.id})`}
            strokeWidth={arc.width}
          />
        ))}
      </g>
    </svg>
  );
}

function Dots({ dots, fill }: { dots: BotFrame["dots"]; fill: string }) {
  return (
    <g>
      {dots.map((dot, index) => {
        const dotFill = dot.color ?? fill;

        return dot.d ? (
          <path
            d={dot.d}
            fill={dotFill}
            key={index}
            opacity={dot.opacity}
            transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
          />
        ) : (
          <circle
            cx={dot.x}
            cy={dot.y}
            fill={dotFill}
            key={index}
            opacity={dot.opacity}
            r={dot.r}
          />
        );
      })}
    </g>
  );
}
