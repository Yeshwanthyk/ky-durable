import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PiSessionView } from "../view";
import { Icon } from "./Icon";
import { OpenStepsContext, RecalledContext, Thread } from "./Thread";
import { Timeline, TimelineSheet } from "./Timeline";
import { turnTimeline } from "./timeline-steps";
import type { Turn } from "./conversation";
import { buildTurns } from "./turns";

type ThreadView = Pick<PiSessionView, "messages" | "live" | "running" | "tools">;

const NONE_RECALLED: Readonly<Record<string, readonly string[]>> = {};

const isEmpty = ({ messages, live, running }: ThreadView) => messages.length === 0 && !live && !running;

// The open chat's thread, which follows the end while the user is there; `welcome` stands in while it is empty.
export function ChatThread({
  chat,
  session,
  welcome,
  recalled = NONE_RECALLED,
}: {
  /** Which chat this is: another one starts its thread afresh, with earlier turns folded again. */
  chat: string;
  session: ThreadView;
  welcome: ReactNode;
  /** What turn-start recall gave the model for each user message, by message id. */
  recalled?: Readonly<Record<string, readonly string[]>>;
}) {
  const { messages, live, running, tools } = session;
  const threadRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => buildTurns(messages, live, running, tools), [messages, live, running, tools]);

  const { away, toLatest } = useFollow(threadRef, innerRef, messages[0]?.id ?? null, turns);
  const [steps, setSteps] = useState(false);
  const openSteps = useCallback(() => setSteps(true), []);

  return (
    <main ref={threadRef} className="thread" data-scroll>
      <div ref={innerRef} className="thread-inner">
        <OpenStepsContext.Provider value={openSteps}>
          <RecalledContext.Provider value={recalled}>
            {isEmpty(session) ? welcome : <Thread key={chat} turns={turns} mode={running ? "live" : "dormant"} />}
          </RecalledContext.Provider>
        </OpenStepsContext.Provider>
      </div>
      <div className="thread-end">
        <button type="button" className="to-latest pressable" data-shown={away} inert={!away} aria-label="Jump to latest" onClick={toLatest}>
          <Icon name="arrowDown" size={15} />
        </button>
      </div>
      {steps ? <TurnSteps session={session} onClose={() => setSteps(false)} /> : null}
    </main>
  );
}

// Within this many pixels of the end counts as at the end, so the thread keeps following.
const NEAR_END = 80;

// A glide back to the end gives up waiting for scrollend after this long.
const GLIDE_MS = 400;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An element near the top of the view and how far below the thread's top edge it sat. */
type Anchor = { element: Element; y: number };

type Follow = {
  /** Whether the thread keeps to its end as it grows. */
  pinned: boolean;
  /** The last scrollTop seen, to tell the user scrolling up from content growing. */
  top: number;
  /** The last clientHeight seen: a thread that grew taller (the composer shrinking) clamps scrollTop, which is not the user. */
  height: number;
  /** What to hold still while not pinned, deepest first. */
  anchors: Anchor[];
  /** A glide to the end is under way; when it started, so a stale timer knows it is stale. */
  glide: number | null;
  touching: boolean;
  /** The open chat's first message, to tell a new chat from new turns. Undefined before the first render. */
  history: string | null | undefined;
  lastTurn: string | null;
};

/**
 * Keeps the thread at its end while the user is there, and leaves it alone once they scroll up.
 * Following is instant (scrollTop on the thread), so nothing outside the thread scrolls and a
 * stream of tokens never queues smooth scrolls. A ResizeObserver does the work, so tokens,
 * late images and a keyboard opening are all caught after layout and before paint.
 */
function useFollow(
  threadRef: RefObject<HTMLElement | null>,
  innerRef: RefObject<HTMLDivElement | null>,
  history: string | null,
  turns: readonly Turn[]
) {
  // The user has scrolled up from the end, so the thread offers a way back.
  const [away, setAway] = useState(false);

  const follow = useRef<Follow>({
    pinned: true,
    top: 0,
    height: 0,
    anchors: [],
    glide: null,
    touching: false,
    history: undefined,
    lastTurn: null,
  });

  // A reload or another chat opens at its end, before the first paint, with no animation.
  // The user's own new message brings them back down if they had scrolled up.
  useLayoutEffect(() => {
    const thread = threadRef.current;
    const state = follow.current;
    const last = turns.at(-1);
    const fresh = history !== state.history;
    const sent = !fresh && last !== undefined && last.id !== state.lastTurn && last.from === null && (last.user !== "" || last.images.length > 0);

    state.history = history;
    state.lastTurn = last?.id ?? null;

    if (!thread) return;

    if (fresh) {
      state.pinned = true;
      state.glide = null;
      setAway(false);
      toEnd(thread, state);
    } else if (sent && !state.pinned) {
      glide(thread, state);
    }
  }, [threadRef, history, turns]);

  useEffect(() => {
    const thread = threadRef.current;
    const inner = innerRef.current;
    const state = follow.current;

    if (!thread || !inner) return;

    const onScroll = () => {
      const top = thread.scrollTop;
      const gap = thread.scrollHeight - top - thread.clientHeight;
      const resized = thread.clientHeight !== state.height;

      state.height = thread.clientHeight;

      // Up by the user's hand lets go of the end. Content shrinking or the view growing clamps
      // scrollTop instead, and that one stays pinned.
      if (top < state.top - 1 && gap > 2 && !resized) {
        state.pinned = false;
        state.glide = null;
      } else if (gap <= NEAR_END) {
        state.pinned = true;
      }

      state.top = top;
      state.anchors = state.pinned ? [] : anchorsIn(thread, inner);
      setAway(!state.pinned);
    };

    const onTouchStart = () => {
      state.touching = true;
    };

    const onTouchEnd = () => {
      state.touching = false;
    };

    const observer = new ResizeObserver(() => {
      // A scroll up that has not dispatched its event yet still counts.
      if (thread.scrollTop < state.top - 1) onScroll();

      // A glide under way aims again at the end as it is now, rather than land short and jump.
      if (state.glide !== null) {
        thread.scrollTo({ top: thread.scrollHeight - thread.clientHeight, behavior: "smooth" });

        return;
      }

      if (state.pinned) {
        // Under a finger, wait for the release rather than yank the page from under it.
        if (!state.touching) toEnd(thread, state);

        return;
      }

      hold(thread, inner, state);
    });

    thread.addEventListener("scroll", onScroll, { passive: true });
    thread.addEventListener("touchstart", onTouchStart, { passive: true });
    thread.addEventListener("touchend", onTouchEnd, { passive: true });
    thread.addEventListener("touchcancel", onTouchEnd, { passive: true });
    observer.observe(inner);
    observer.observe(thread);

    return () => {
      thread.removeEventListener("scroll", onScroll);
      thread.removeEventListener("touchstart", onTouchStart);
      thread.removeEventListener("touchend", onTouchEnd);
      thread.removeEventListener("touchcancel", onTouchEnd);
      observer.disconnect();
    };
  }, [threadRef, innerRef]);

  const toLatest = () => {
    const thread = threadRef.current;

    if (!thread) return;

    setAway(false);
    glide(thread, follow.current);
  };

  return { away, toLatest };
}

function toEnd(thread: HTMLElement, state: Follow) {
  thread.scrollTop = thread.scrollHeight;
  state.top = thread.scrollTop;
  state.height = thread.clientHeight;
  state.anchors = [];
}

// A short smooth scroll to the end. From far up it first jumps to a short way off, so the glide stays under 300ms.
function glide(thread: HTMLElement, state: Follow) {
  const end = thread.scrollHeight - thread.clientHeight;

  state.pinned = true;

  if (reducedMotion()) {
    toEnd(thread, state);

    return;
  }

  const reach = Math.min(240, thread.clientHeight / 2);

  if (end - thread.scrollTop > reach) thread.scrollTop = end - reach;

  state.top = thread.scrollTop;
  const id = performance.now();
  state.glide = id;
  thread.scrollTo({ top: end, behavior: "smooth" });
  const deadline = performance.now() + GLIDE_MS;

  // The jump above ends a scroll too; only the glide reaching the end counts. Past the deadline
  // it lands on the end as it is now.
  const land = () => {
    if (state.glide === id && thread.scrollHeight - thread.clientHeight - thread.scrollTop > 2 && performance.now() < deadline) return;

    thread.removeEventListener("scrollend", land);

    if (state.glide !== id) return;

    state.glide = null;

    if (state.pinned && !state.touching) toEnd(thread, state);
  };

  thread.addEventListener("scrollend", land);
  setTimeout(land, GLIDE_MS);
}

// Content above the view changed size (earlier turns revealed, an image loaded): scroll by
// as much, so what the user is reading stays where it was. overflow-anchor does this natively,
// but not in every Safari the app supports, so it is off and this does it everywhere.
function hold(thread: HTMLElement, inner: HTMLElement, state: Follow) {
  const anchor = state.anchors.find((each) => each.element.isConnected);

  if (anchor) {
    const shift = anchor.element.getBoundingClientRect().top - thread.getBoundingClientRect().top - anchor.y;

    if (Math.abs(shift) >= 1) {
      thread.scrollTop += shift;
      state.top = thread.scrollTop;
    }
  }

  state.anchors = anchorsIn(thread, inner);
}

// The first element in view, descending into the one that straddles the top edge, deepest first.
// The top-level element's next sibling comes last, for when the first is removed (the earlier-turns button).
function anchorsIn(thread: HTMLElement, inner: HTMLElement): Anchor[] {
  const edge = thread.getBoundingClientRect().top;
  const chain: Anchor[] = [];
  let level: Element = inner;

  for (let depth = 0; depth < 8; depth++) {
    const child = Array.from(level.children).find((each) => each.getBoundingClientRect().bottom > edge);

    if (!child) break;

    const y = child.getBoundingClientRect().top - edge;
    chain.unshift({ element: child, y });

    if (y >= 0 || child.children.length === 0) break;

    level = child;
  }

  const next = chain.at(-1)?.element.nextElementSibling;

  if (next) chain.push({ element: next, y: next.getBoundingClientRect().top - edge });

  return chain;
}

/** The current turn's tools as a timeline, live while ky works. */
function TurnSteps({ session, onClose }: { session: ThreadView; onClose: () => void }) {
  return (
    <TimelineSheet title="This turn" sub={session.running ? "ky · Working" : "ky · Done"} onClose={onClose}>
      <Timeline steps={turnTimeline(session)} working={session.running} empty="No tools used" />
    </TimelineSheet>
  );
}
