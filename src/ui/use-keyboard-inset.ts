import { useEffect, useRef } from "react";

// More than this between the layout and visual viewports is a keyboard, not a toolbar settling.
const KEYBOARD_MIN = 60;

/**
 * Keeps the composer dock above the iOS keyboard. Safari ignores `interactive-widget`, so the keyboard
 * shrinks only the visual viewport and the 100dvh shell stays tall behind it. While the keyboard is up
 * this sets `--kb` on the dock to how far its bottom sits under the visible area, and the CSS pads it up
 * by that much. Measuring the dock against the visual viewport holds whether or not Safari also pans
 * the page, and the padding never feeds back into what is measured. Android resizes the page itself
 * and desktop has no keyboard, so there the two viewports match and `--kb` stays unset.
 */
export function useKeyboardInset<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    const dock = ref.current;

    if (!viewport || !dock) return;

    let frame = 0;
    let applied: number | null = null;

    const measure = () => {
      frame = 0;

      // Pinch zoom also shrinks the visual viewport; only a keyboard should move the dock.
      const keyboard = viewport.scale < 1.01 && window.innerHeight - viewport.height > KEYBOARD_MIN;

      const covered = keyboard
        ? Math.max(0, Math.round(dock.getBoundingClientRect().bottom - viewport.offsetTop - viewport.height))
        : null;

      if (covered === applied) return;

      // The thread above gives up what the dock takes. If you were at the latest message, it stays
      // in view instead of slipping under the dock.
      const thread = dock.parentElement?.querySelector<HTMLElement>("[data-scroll]");
      const atEnd = thread ? thread.scrollHeight - thread.scrollTop - thread.clientHeight < 2 : false;
      applied = covered;

      if (covered === null) dock.style.removeProperty("--kb");
      else dock.style.setProperty("--kb", `${covered}px`);

      if (thread && atEnd) thread.scrollTop = thread.scrollHeight;
    };

    // Resize and scroll can fire many times a frame while the keyboard moves; measure once per frame.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    schedule();

    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
      dock.style.removeProperty("--kb");
    };
  }, []);

  return ref;
}
