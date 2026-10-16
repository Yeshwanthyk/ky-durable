/**
 * How a bloub moves, apart from how it is drawn (Bloub.tsx): its poses, the values that ease between
 * them each frame, blinks, pokes, hearts and dizziness. Plain functions over a `Motion`, so the page
 * keeps one per avatar off React state and the tests can step one by hand.
 */

export type Mood = "idle" | "working" | "failed";

/** What it is doing now: its mood, or what the pointer just did to it. */
type Pose = Mood | "hover" | "dizzy";

/** Each pose's targets; the drawn values ease toward them. `rate` is how fast it breathes. */
type Params = { hop: number; bob: number; rate: number; tilt: number; lid: number; happy: number; smile: number; open: number; dots: number; drop: number; sag: number; blush: number; dizzy: number };

/** The params that ease from pose to pose; the breathing rate switches at once. */
const EASED = ["hop", "bob", "tilt", "lid", "happy", "smile", "open", "dots", "drop", "sag", "blush", "dizzy"] as const satisfies readonly (keyof Params)[];

const POSES: Readonly<Record<Pose, Params>> = {
  idle: { hop: 0, bob: 1.4, rate: 2.2, tilt: 0, lid: 0, happy: 0, smile: 0.7, open: 0, dots: 0, drop: 0, sag: 0, blush: 0, dizzy: 0 },
  hover: { hop: 1, bob: 0, rate: 2.2, tilt: 0, lid: 0, happy: 1, smile: 1, open: 0.8, dots: 0, drop: 0, sag: 0, blush: 1, dizzy: 0 },
  working: { hop: 0, bob: 1, rate: 9, tilt: 3, lid: 0.2, happy: 0, smile: 0.2, open: 0, dots: 1, drop: 0, sag: 0, blush: 0, dizzy: 0 },
  failed: { hop: 0, bob: 0.5, rate: 1.4, tilt: 4, lid: 0.5, happy: 0, smile: -0.7, open: 0, dots: 0, drop: 1, sag: 1, blush: 0, dizzy: 0 },
  dizzy: { hop: 0, bob: 0.6, rate: 3, tilt: 0, lid: 0, happy: 0, smile: 0, open: 0.5, dots: 0, drop: 0, sag: 0.3, blush: 0, dizzy: 1 }
};

/** Where each pose looks, -1 to 1 across the eye; a pose not here follows the pointer, or wanders. */
const GAZE: Partial<Record<Pose, readonly [number, number]>> = { hover: [0, 0], working: [0.5, 0.5], failed: [0, 0.55], dizzy: [0, 0] };

/** Pokes within this many seconds that make it dizzy, and how long it stays so. */
const POKES = 5;

const POKE_WINDOW = 2.5;

const DIZZY_FOR = 2.2;

/** How long a heart floats. */
export const HEART_LIFE = 1.1;

/** How far away, in pixels, the pointer still draws its eyes all the way over. */
const GAZE_REACH = 320;

/** The drawn values: a pose's, plus where the eyes look and how squashed a click left it. */
export type Drawn = Params & { gx: number; gy: number; squish: number };

/** Everything that moves between frames. */
export type Motion = {
  p: Drawn;
  t: number;
  blinkAt: number;
  pokes: number[];
  dizzyUntil: number;
  /** When each floating heart was sent. */
  hearts: number[];
  /** Where the pointer is, as a direction from the avatar's middle, -1 to 1; null while it's off the page. */
  pointer: readonly [number, number] | null;
};

const ease = (from: number, to: number, k: number) => from + (to - from) * k;

/** A seed's start in the breathing cycle, so a row of bloubs doesn't breathe in step. */
function phaseOf(seed: string): number {
  let sum = 0;

  for (let index = 0; index < seed.length; index++) sum += seed.charCodeAt(index);

  return sum % 9;
}

/** A bloub at rest in `mood`, started at a point in its breathing that `seed` picks. */
export function newMotion(mood: Mood, seed: string): Motion {
  const t = phaseOf(seed);

  return { p: settled(mood), t, blinkAt: t + 1 + Math.random() * 3, pokes: [], dizzyUntil: 0, hearts: [], pointer: null };
}

/** `mood`'s pose, eased all the way: what a still bloub shows. */
export const settled = (mood: Mood): Drawn => ({ ...POSES[mood], gx: 0, gy: 0, squish: 0 });

/** What it does now: dizzy from pokes first, then glad of the pointer while idle, else its mood. */
export function poseOf(motion: Motion, mood: Mood, hovered: boolean): Pose {
  if (motion.t < motion.dizzyUntil) return "dizzy";

  return hovered && mood === "idle" ? "hover" : mood;
}

/** One frame: ease toward `pose`, look, spring back from a click, let hearts fade, and book the next blink. */
export function advance(motion: Motion, pose: Pose, seconds: number): void {
  const dt = Math.min(0.05, seconds);
  const k = 1 - Math.exp(-dt * 10);
  const target = POSES[pose];
  const { p } = motion;
  motion.t += dt;

  for (const key of EASED) p[key] = ease(p[key], target[key], k);

  p.rate = target.rate;

  const gaze = GAZE[pose] ?? motion.pointer ?? [Math.sin(motion.t * 0.7) * 0.45, Math.sin(motion.t * 0.43 + 1.3) * 0.3];
  p.gx = ease(p.gx, gaze[0], k);
  p.gy = ease(p.gy, gaze[1], k);
  p.squish = ease(p.squish, 0, 1 - Math.exp(-dt * 6));
  motion.hearts = motion.hearts.filter((born) => motion.t - born < HEART_LIFE);

  if (motion.t > motion.blinkAt + 0.15) motion.blinkAt = motion.t + 2.4 + Math.random() * 3;
}

/** A click: it squishes and sends a heart; the fifth within a few seconds makes it dizzy. */
export function poke(motion: Motion): void {
  motion.p.squish = 1;
  motion.hearts.push(motion.t);
  motion.pokes = [...motion.pokes.filter((at) => motion.t - at < POKE_WINDOW), motion.t];

  if (motion.pokes.length < POKES) return;

  motion.dizzyUntil = motion.t + DIZZY_FOR;
  motion.pokes = [];
}

/** Where the eyes turn for a pointer `dx`, `dy` pixels from the middle: fully over only when it is far. */
export function aim(dx: number, dy: number): readonly [number, number] {
  const reach = Math.max(1, Math.hypot(dx, dy), GAZE_REACH * 0.25);
  const pull = Math.min(1, reach / GAZE_REACH);

  return [(dx / reach) * pull, (dy / reach) * pull];
}

/** How far through a blink it is, 0 open to 1 shut. */
export function blinkOf(motion: Motion): number {
  const at = (motion.t - motion.blinkAt) / 0.15;

  return at >= 0 && at <= 1 ? Math.sin(at * Math.PI) : 0;
}
