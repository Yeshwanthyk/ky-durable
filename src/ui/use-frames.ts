import { type RefObject, useEffect, useRef, useState } from "react";

const FRAME_INTERVAL = 1000 / 60;

/** rAF times jitter (WebKit rounds them to whole milliseconds); without slack a 60Hz screen skips about a third of frames. */
const FRAME_SLACK = 1;

/** How often a running avatar checks whether something now sits over it, and a covered one whether it is clear. */
const COVER_CHECK_INTERVAL = 500;

// Whether something opaque sits over the avatar's middle. On a phone the full-screen panel covers
// the topbar and welcome avatars without moving them, so the IntersectionObserver still sees them.
function covered(svg: SVGSVGElement): boolean {
  const box = svg.getBoundingClientRect();
  let node = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

  if (!node || svg.contains(node)) return false;

  // Climb from what is on top to the first box that holds the avatar too: a see-through scrim
  // on the way still shows it, so it keeps moving.
  for (; node && !node.contains(svg); node = node.parentElement) {
    if (opaque(getComputedStyle(node).backgroundColor)) return true;
  }

  return false;
}

// Computed colours with any transparency come back as rgba(...) or with a "/ alpha".
const opaque = (color: string) => !color.startsWith("rgba(") && !color.includes("/");

export function useReducedMotion(): boolean {
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

/**
 * Calls `step` with the seconds since the last frame, at most 60 times a second, while `enabled` and
 * the avatar can be seen: not in a hidden tab, scrolled away, or under the panel. Paused, no time
 * passes, so an avatar picks up where it left off rather than jumping.
 */
export function useFrames(svgRef: RefObject<SVGSVGElement | null>, enabled: boolean, step: (seconds: number) => void): void {
  const latest = useRef(step);
  latest.current = step;

  useEffect(() => {
    const svg = svgRef.current;

    if (!enabled || !svg) return;

    let animationFrame = 0;
    let segmentStartedAt: number | undefined;
    let lastRenderedAt = -Infinity;
    let onScreen = true;
    let overlaid = false;

    const tick = (now: number) => {
      segmentStartedAt ??= now;

      if (now - lastRenderedAt >= FRAME_INTERVAL - FRAME_SLACK) {
        latest.current((now - segmentStartedAt) / 1000);
        segmentStartedAt = now;
        lastRenderedAt = now;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (animationFrame !== 0) return;
      segmentStartedAt = undefined;
      animationFrame = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (animationFrame === 0) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      segmentStartedAt = undefined;
    };

    const sync = () => {
      if (document.visibilityState !== "hidden" && onScreen && !overlaid) start();
      else stop();
    };

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? onScreen;
      sync();
    });

    const coverCheck = window.setInterval(() => {
      if (!onScreen || document.visibilityState === "hidden") return;
      overlaid = covered(svg);
      sync();
    }, COVER_CHECK_INTERVAL);

    document.addEventListener("visibilitychange", sync);
    observer.observe(svg);
    sync();

    return () => {
      document.removeEventListener("visibilitychange", sync);
      observer.disconnect();
      window.clearInterval(coverCheck);
      stop();
    };
  }, [enabled, svgRef]);
}
