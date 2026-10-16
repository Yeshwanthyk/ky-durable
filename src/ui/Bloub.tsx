import { createContext, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import Type from "typebox";
import { type AvatarsView, BLOUBS_FENCE, type BloubSpec, BloubSpecSchema } from "../avatar-spec";
import { parseOr } from "../core/decode";
import { advance, aim, blinkOf, type Drawn, HEART_LIFE, type Mood, type Motion, newMotion, poke, poseOf, settled } from "./bloub-motion";
import { useFrames, useReducedMotion } from "./use-frames";

/**
 * A bloub drawn from its spec (avatar-spec.ts): a rounded body, one or two eyes, a mouth, and a part
 * on top, all from a fixed set, so a model's spec can only pick and size them. It breathes and blinks
 * at rest, follows the pointer with its eyes, hops with happy eyes under the pointer, squishes and
 * sends a heart when clicked, gets dizzy when poked five times quickly, leans in with dots while it
 * works, and droops with a sweat drop when its last answer failed. How it moves is bloub-motion.ts.
 */

/** The saved bloubs, by "ky" or specialist id; the page provides them. */
export const AvatarsContext = createContext<AvatarsView>({});

const VIEWBOX = "-80 -88 160 160";

const channels = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);

  return [n >> 16, (n >> 8) & 255, n & 255] as const;
};

const shade = (hex: string, k: number) => `rgb(${channels(hex).map((value) => Math.round(value * k)).join(",")})`;

const isLight = (hex: string) => {
  const [r, g, b] = channels(hex);

  return 0.3 * r + 0.59 * g + 0.11 * b > 180;
};

/** The sizes and colours every part is drawn from, worked out once per frame. */
type Frame = { spec: BloubSpec; motion: Motion; p: Drawn; hw: number; hh: number; edge: string; ink: string; light: boolean };

function frameOf(spec: BloubSpec, motion: Motion): Frame {
  const light = isLight(spec.body.color);

  return {
    spec,
    motion,
    p: motion.p,
    hw: spec.body.w / 2,
    hh: spec.body.h / 2,
    light,
    edge: shade(spec.body.color, light ? 0.78 : 0.68),
    ink: light ? "#4a3a30" : "#2a0c0e"
  };
}

/** Its eyes follow the pointer anywhere on the page while it moves. */
function usePointerGaze(svgRef: RefObject<SVGSVGElement | null>, motion: RefObject<Motion | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const follow = (event: PointerEvent) => {
      const box = svgRef.current?.getBoundingClientRect();

      if (box && motion.current) motion.current.pointer = aim(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2));
    };

    const away = () => {
      if (motion.current) motion.current.pointer = null;
    };

    window.addEventListener("pointermove", follow, { passive: true });
    document.documentElement.addEventListener("pointerleave", away);

    return () => {
      window.removeEventListener("pointermove", follow);
      document.documentElement.removeEventListener("pointerleave", away);
    };
  }, [enabled, motion, svgRef]);
}

/** The bloub's motion, stepped each frame while it animates, or settled on its mood while still. */
function useBloubMotion({ name, mood, hovered, animated, svgRef }: { name: string; mood: Mood; hovered: boolean; animated: boolean; svgRef: RefObject<SVGSVGElement | null> }): Motion {
  const motion = useRef<Motion | null>(null);
  motion.current ??= newMotion(mood, name);
  const now = motion.current;
  const [, setFrame] = useState(0);
  const pose = poseOf(now, mood, hovered);

  useEffect(() => {
    if (animated) return;

    now.p = settled(mood);
    setFrame((count) => count + 1);
  }, [animated, mood, now]);

  useFrames(svgRef, animated, (seconds) => {
    advance(now, pose, seconds);
    setFrame((count) => count + 1);
  });

  usePointerGaze(svgRef, motion, animated);

  return now;
}

/** What the pointer can do to it: nothing while it is still. */
const handlersFor = (motion: Motion, setHovered: (hovered: boolean) => void) => ({
  onPointerDown: () => poke(motion),
  onPointerEnter: () => setHovered(true),
  onPointerLeave: () => setHovered(false),
  style: { willChange: "transform" }
});

export function Bloub({ spec, name, mood = "idle", still = false, size = 40, className }: { spec: BloubSpec; name: string; mood?: Mood; still?: boolean; size?: number; className?: string }) {
  const animated = !useReducedMotion() && !still;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState(false);
  const motion = useBloubMotion({ name, mood, hovered, animated, svgRef });
  const id = useId().replaceAll(":", "");
  const label = mood === "working" ? `${name} is working` : name;

  return (
    <svg aria-label={label} className={className} height={size} ref={svgRef} role="img" viewBox={VIEWBOX} width={size} {...(animated ? handlersFor(motion, setHovered) : {})}>
      <Body frame={frameOf(spec, motion)} id={id} />
    </svg>
  );
}

/** One frame of the drawing: feet, the body that bobs, squashes and tilts with its face and top, then what floats around it. */
function Body({ frame, id }: { frame: Frame; id: string }) {
  const { p, motion, hw, hh, spec, edge } = frame;
  const { t } = motion;
  const wave = Math.sin(t * p.rate);
  const hopping = p.hop * Math.abs(Math.sin(t * 7));
  const bob = wave * p.bob - hopping * 9 + p.sag * 4;
  // A click squashes it flat and lets it spring back; a hop stretches it.
  const squash = wave * 0.015 + p.sag * 0.05 - hopping * 0.03 + p.squish * Math.cos(t * 26) * 0.12;
  const tilt = p.tilt + p.dizzy * Math.sin(t * 9) * 8;
  const sway = Math.sin(t * 1.7) * 7 - tilt * 1.5;

  return (
    <>
      {spec.feet ? [-1, 1].map((side) => <ellipse key={side} cx={side * hw * 0.45} cy={hh + 4} rx={hw * 0.26} ry={8} fill={edge} />) : null}
      <g transform={`translate(0 ${bob.toFixed(2)}) translate(0 ${hh}) rotate(${tilt.toFixed(2)}) scale(${(1 + squash).toFixed(3)} ${(1 - squash).toFixed(3)}) translate(0 ${-hh})`}>
        <g transform={`translate(0 ${-hh}) rotate(${sway.toFixed(1)}) translate(0 ${hh})`}>
          <Top frame={frame} />
        </g>
        <rect x={-hw} y={-hh} width={spec.body.w} height={spec.body.h} rx={spec.body.corner} fill={spec.body.color} stroke={edge} strokeWidth={5} />
        <ellipse cx={-hw * 0.45} cy={-hh * 0.72} rx={hw * 0.28} ry={6} fill="#fff" opacity={frame.light ? 0.6 : 0.3} />
        <Face frame={frame} id={id} />
      </g>
      <Afloat frame={frame} />
    </>
  );
}

/** Eyes, cheeks and mouth. */
function Face({ frame, id }: { frame: Frame; id: string }) {
  const { spec, p, hw, hh } = frame;
  const { count, size: r } = spec.eyes;
  const lid = Math.max(p.lid, blinkOf(frame.motion));
  const mouthY = hh * 0.42;
  const cheekX = Math.min(count === 1 ? r + 12 : r * 2.55 + 2, hw - 12);

  return (
    <>
      {(count === 1 ? [0] : [-r * 1.55, r * 1.55]).map((x, index) => (
        <Eye key={index} id={`${id}-${index}`} x={x} y={-hh * 0.12} r={r} lid={lid} frame={frame} />
      ))}
      {spec.cheeks
        ? [-1, 1].map((side) => <ellipse key={side} cx={side * cheekX} cy={mouthY - 4} rx={9} ry={5.5} fill="#ff8fa3" opacity={(0.55 + p.blush * 0.35) * (1 - p.sag)} />)
        : null}
      <Mouth y={mouthY} p={p} ink={frame.ink} />
    </>
  );
}

/** Working dots, a sweat drop, and hearts from clicks. */
function Afloat({ frame }: { frame: Frame }) {
  const { p, hw, hh, motion } = frame;
  const { t } = motion;

  return (
    <>
      {p.dots > 0.02 ? <Dots frame={frame} /> : null}
      {p.drop > 0.02 ? <path d={`M${hw - 6},${-hh + 4} q-7,11 0,14 q7,-3 0,-14 Z`} fill="#7cc4ff" opacity={p.drop} transform={`translate(0 ${(t * 12) % 8})`} /> : null}
      {motion.hearts.map((born) => {
        const age = (t - born) / HEART_LIFE;

        return (
          <path
            key={born}
            d="M0,4 C-9,-3 -6,-11 0,-6 C6,-11 9,-3 0,4 Z"
            fill="#ff5d8f"
            opacity={1 - age}
            transform={`translate(${hw * 0.6 + Math.sin(age * 9) * 4} ${-hh - 6 - age * 30}) scale(${0.8 + age * 0.5})`}
          />
        );
      })}
    </>
  );
}

function Dots({ frame }: { frame: Frame }) {
  const { p, hw, hh, motion, spec } = frame;

  return [0, 1, 2].map((index) => {
    const k = (Math.sin(motion.t * 6 - index * 0.9) + 1) / 2;

    return <circle key={index} cx={hw + 2 + index * 11} cy={-hh - 10 - k * 5} r={3.5 + k * 1.8} fill={spec.body.color} opacity={p.dots * (0.35 + k * 0.65)} />;
  });
}

function Eye({ id, x, y, r, lid, frame }: { id: string; x: number; y: number; r: number; lid: number; frame: Frame }) {
  const { p, ink } = frame;
  const pr = r * 0.58;
  const px = x + p.gx * (r - pr - 2);
  const py = y + p.gy * (r - pr - 2);

  return (
    <>
      <g opacity={1 - Math.max(p.happy, p.dizzy)}>
        <defs>
          <clipPath id={id}>
            <circle cx={x} cy={y} r={r} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id})`}>
          <circle cx={x} cy={y} r={r} fill="#fff" />
          <circle cx={px} cy={py} r={pr} fill="#1b1b1f" />
          <circle cx={px - pr * 0.35} cy={py - pr * 0.4} r={pr * 0.34} fill="#fff" />
          <circle cx={px + pr * 0.38} cy={py + pr * 0.35} r={pr * 0.15} fill="#fff" />
          <rect x={x - r} y={y - r - 1} width={2 * r} height={2 * r * lid + 1} fill={frame.spec.body.color} />
        </g>
      </g>
      {/* Happy eyes: a ^ arc, the cutest thing one stroke can do. */}
      {p.happy > 0.05 ? (
        <path d={`M${x - r * 0.7},${y + r * 0.25} Q${x},${y - r * 0.75} ${x + r * 0.7},${y + r * 0.25}`} fill="none" stroke={ink} strokeWidth={Math.max(4, r * 0.28)} strokeLinecap="round" opacity={p.happy} />
      ) : null}
      {/* Dizzy eyes: a spiral that spins. */}
      {p.dizzy > 0.05 ? (
        <path
          d={`M${x},${y} m${-r * 0.6},0 a${r * 0.6},${r * 0.6} 0 1 1 ${r * 1.2},0 a${r * 0.4},${r * 0.4} 0 1 1 ${-r * 0.8},0 a${r * 0.2},${r * 0.2} 0 1 1 ${r * 0.4},0`}
          fill="none"
          stroke={ink}
          strokeWidth={Math.max(3, r * 0.18)}
          strokeLinecap="round"
          opacity={p.dizzy}
          transform={`rotate(${((frame.motion.t * 540) % 360).toFixed(0)} ${x} ${y})`}
        />
      ) : null}
    </>
  );
}

function Mouth({ y, p, ink }: { y: number; p: Drawn; ink: string }) {
  const w = 9;

  if (p.open > 0.05) return <path d={`M${-w},${y} Q0,${y + 2} ${w},${y} Q0,${y + 6 + p.open * 10} ${-w},${y} Z`} fill={ink} />;

  const corner = y + Math.max(0, -p.smile) * 5;

  return <path d={`M${-w},${corner} Q0,${y + p.smile * 9} ${w},${corner}`} fill="none" stroke={ink} strokeWidth={4.5} strokeLinecap="round" />;
}

/** What sits on top, by kind; it sways with the body. */
const TOPS: Readonly<Record<BloubSpec["top"]["kind"], (frame: Frame, color: string, y: number) => ReactNode>> = {
  none: () => null,
  antenna: (frame, color, y) => (
    <>
      <line y1={y + 4} y2={y - 14} stroke={shade(frame.spec.body.color, 0.62)} strokeWidth={5} strokeLinecap="round" />
      <circle cy={y - 19} r={8} fill={color} />
    </>
  ),
  leaf: (_frame, color, y) => <path d={`M0,${y + 4} q-2,-10 4,-16 q14,-6 22,0 q-8,14 -26,16 Z`} fill={color} />,
  ears: (frame, color, y) =>
    [-1, 1].map((side) => {
      const x = side * frame.hw * 0.55;

      return <ellipse key={side} cx={x} cy={y + 6} rx={13} ry={18} fill={color} stroke={frame.edge} strokeWidth={4} transform={`rotate(${side * 18} ${x} ${y + 6})`} />;
    }),
  sprout: (_frame, color, y) => (
    <>
      <line y1={y + 4} y2={y - 12} stroke={shade(color, 0.7)} strokeWidth={4} strokeLinecap="round" />
      <path d={`M0,${y - 10} q-4,-12 -16,-12 q2,12 16,12 Z`} fill={color} />
      <path d={`M0,${y - 10} q4,-12 16,-12 q-2,12 -16,12 Z`} fill={color} />
    </>
  ),
  tuft: (_frame, color, y) =>
    [-8, 0, 8].map((dx) => <path key={dx} d={`M${dx},${y + 4} q${dx * 0.6 - 3},-12 ${dx * 0.9 + 4},-16`} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />)
};

function Top({ frame }: { frame: Frame }) {
  const { top, body } = frame.spec;

  return TOPS[top.kind](frame, top.color ?? body.color, -frame.hh);
}

/** Bloubs shown side by side, numbered, as a tool showed them in the chat. */
export function BloubOptions({ specs }: { specs: readonly BloubSpec[] }) {
  const numbered = specs.length > 1;

  return (
    <div className="bloub-options">
      {specs.map((spec, index) => (
        <figure key={index}>
          <Bloub spec={spec} name={spec.name ?? `Option ${index + 1}`} size={72} />
          <figcaption>{[numbered ? `${index + 1}` : "", spec.name ?? ""].filter(Boolean).join(" · ")}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** A fenced block of bloubs, as the avatar tool writes it. */
const BLOUBS_BLOCK = new RegExp(`\`\`\`${BLOUBS_FENCE}\\n([\\s\\S]*?)\\n\`\`\``);

/** The bloubs an avatar tool result carries, to draw under its row; none for any other output. */
export function bloubsIn(output: string): readonly BloubSpec[] | undefined {
  const match = output.match(BLOUBS_BLOCK);

  return match?.[1] ? parseOr(Type.Array(BloubSpecSchema), match[1], undefined) : undefined;
}
