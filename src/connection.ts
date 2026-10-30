import { useEffect, useState, useSyncExternalStore } from "react";
import { PING } from "./protocol";

/**
 * How the page's socket to ky is doing, as the user needs to hear it:
 * - `connecting`: the first socket hasn't opened yet.
 * - `open`: connected, and ky has said something on it.
 * - `reconnecting`: a brief drop; the socket is on its way back.
 * - `offline`: the browser has no network, or ky's own page can't be fetched.
 * - `unreachable`: the network is up but the socket keeps failing.
 * - `signed-out`: Access no longer lets this browser in; only signing in again helps.
 */
export type ConnectionKind = "connecting" | "open" | "reconnecting" | "offline" | "unreachable" | "signed-out";

/** What a fetch of ky's page says about why the socket closed. */
export type Reach = "in" | "signed-out" | "no-network";

/** The socket the watch keeps an eye on: partysocket's, as `useAgent` returns it. */
export type WatchedSocket = {
  readonly readyState: number;
  send(data: string): void;
  reconnect(): void;
  close(): void;
  addEventListener(type: "open" | "close" | "message", listener: () => void): void;
  removeEventListener(type: "open" | "close" | "message", listener: () => void): void;
};

/** What the watch asks of the browser; a test hands it its own. */
export type WatchEnv = {
  online(): boolean;
  visible(): boolean;
  /** Fetch ky's page to learn why the socket closed. */
  reach(): Promise<Reach>;
};

/** A drop shorter than this is never shown: the dot stays as it was. */
export const GRACE_MS = 1_500;

/** Down this long, or this many attempts failed, and ky is "unreachable" rather than "reconnecting". */
export const UNREACHABLE_AFTER_MS = 6_000;

const UNREACHABLE_AFTER_FAILS = 2;

/** A visible page that has heard nothing for this long pings. Well under Cloudflare's 100s idle cut, too. */
export const QUIET_MS = 25_000;

/** A message sent and nothing heard for this long: ping now, rather than wait out QUIET_MS. */
export const PROBE_AFTER_SEND_MS = 3_000;

/** A ping unanswered for this long means the socket is dead though it says OPEN. */
export const REPLY_MS = 5_000;

/** A socket that opens owes ky's hello within this long; one that stays silent is as dead as no socket. */
export const FIRST_FRAME_MS = 8_000;

/** Something heard this recently and a probe has nothing to learn. */
const HEARD_LATELY_MS = 1_000;

const OPEN = 1;

/**
 * Watches one socket at a time and says what `ConnectionKind` to show. It also keeps the socket honest:
 * - Live, not just open: a socket counts as connected once ky's first frame (its hello) arrives. One that
 *   opens and stays silent for FIRST_FRAME_MS is replaced, and counts as a failed attempt.
 * - Half-open sockets: a socket can stay OPEN while nothing gets through (a phone that changed networks).
 *   Any frame from ky proves it alive; after QUIET_MS of silence on a visible page, or PROBE_AFTER_SEND_MS
 *   after a send with no answer, it sends PING, which the Durable Object's runtime answers with PONG
 *   without waking it. No answer within REPLY_MS and the socket is replaced.
 * - Offline: partysocket's backoff grows to 10s and its wait can't be cut short, so while the browser is
 *   offline the watch stops it retrying, and `online` starts it again at once.
 * - Blips: a drop is shown only once it outlasts GRACE_MS.
 */
export class ConnectionWatch {
  readonly #env: WatchEnv;
  readonly #listeners = new Set<() => void>();
  #socket: WatchedSocket | null = null;
  #kind: ConnectionKind = "connecting";
  /** The socket says OPEN. */
  #open = false;
  /** ky has said something on this open socket. */
  #live = false;
  /** The attached socket has been live; its later drops are reconnects, not a first connect. */
  #wasLive = false;
  /** When the socket was last live, or was attached. */
  #downSince = Date.now();
  /** Attempts that ended without going live, since then. */
  #failed = 0;
  #reach: Reach | null = null;
  #checking = false;
  /** The watch closed the socket because the browser is offline. */
  #stopped = false;
  #heardAt = Date.now();
  /** When the socket was asked to prove itself (by opening, or by a PING) and hasn't yet. */
  #askedAt: number | null = null;
  /** When a message went out that nothing has followed yet. */
  #sentAt: number | null = null;
  /** Messages sent that ky hasn't placed. */
  #waiting = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(env: WatchEnv) {
    this.#env = env;
  }

  readonly kind = (): ConnectionKind => this.#kind;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };

  /** Watch `socket`, a new one; returns a detach. */
  attach(socket: WatchedSocket): () => void {
    this.#socket = socket;
    this.#open = false;
    this.#live = false;
    this.#wasLive = false;
    this.#downSince = Date.now();
    this.#failed = 0;
    this.#askedAt = null;
    this.#sentAt = null;
    socket.addEventListener("open", this.#onOpen);
    socket.addEventListener("close", this.#onClose);
    socket.addEventListener("message", this.#onMessage);

    if (socket.readyState === OPEN) this.#onOpen();
    else this.#tick();

    return () => {
      socket.removeEventListener("open", this.#onOpen);
      socket.removeEventListener("close", this.#onClose);
      socket.removeEventListener("message", this.#onMessage);
      clearTimeout(this.#timer);

      if (this.#socket === socket) this.#socket = null;
    };
  }

  /** The browser is online again: connect now, not after the backoff. A live socket may be stale, so ask it. */
  online(): void {
    if (this.#live) {
      this.probe();

      return;
    }

    this.#stopped = false;
    this.#socket?.reconnect();
    this.#tick();
  }

  /** The browser went offline: stop retrying into nothing. A live socket may survive a blip, so ask it. */
  offline(): void {
    if (this.#live) this.probe();
    else this.#stop();
    this.#tick();
  }

  /** The page is back on screen, or the network changed under it: check the socket now. */
  probe(): void {
    if (!this.#live || this.#askedAt !== null || Date.now() - this.#heardAt < HEARD_LATELY_MS) return;
    this.#ping();
    this.#tick();
  }

  /** How many messages wait for ky. One more went out: if nothing comes back soon, check the socket. */
  waiting(count: number): void {
    if (count > this.#waiting && this.#live) this.#sentAt ??= Date.now();
    this.#waiting = count;
    this.#tick();
  }

  readonly #onOpen = () => {
    this.#open = true;
    this.#stopped = false;
    // ky says hello on every connect; until it does, the socket is on trial.
    this.#askedAt = Date.now();
    this.#tick();
  };

  readonly #onMessage = () => {
    this.#heardAt = Date.now();
    this.#askedAt = null;

    if (this.#live) return;
    this.#live = true;
    this.#wasLive = true;
    this.#failed = 0;
    this.#reach = null;
    this.#tick();
  };

  readonly #onClose = () => {
    if (this.#live) this.#downSince = Date.now();
    else this.#failed++;

    this.#open = false;
    this.#live = false;
    this.#askedAt = null;
    this.#sentAt = null;

    if (!this.#env.online()) this.#stop();
    void this.#check();
    this.#tick();
  };

  /** Ask ky's page why the socket closed, one fetch at a time. */
  async #check(): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;

    try {
      const reach = await this.#env.reach();

      // An answer that lands after the socket came back says nothing about it.
      if (!this.#live) this.#reach = reach;
    } finally {
      this.#checking = false;
      this.#tick();
    }
  }

  #stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#socket?.close();
  }

  #ping(): void {
    this.#askedAt = Date.now();
    this.#sentAt = null;
    this.#socket?.send(PING);
  }

  /** The socket says OPEN but nothing answered: replace it, or, offline, just stop it. */
  #dead(): void {
    this.#askedAt = null;

    if (this.#env.online()) this.#socket?.reconnect();
    else this.#stop();
  }

  /** Do what is due now, show the kind it adds up to, and wake again when something next falls due. */
  readonly #tick = () => {
    clearTimeout(this.#timer);
    const now = Date.now();

    if (this.#open) this.#keepHonest(now);
    this.#show(this.#kindAt(now));

    const next = this.#nextAt(now);

    if (next !== null) this.#timer = setTimeout(this.#tick, Math.max(0, next - now));
  };

  /** How long the socket has to answer what it was asked. */
  #answerWithin(): number {
    return this.#live ? REPLY_MS : FIRST_FRAME_MS;
  }

  #keepHonest(now: number): void {
    if (this.#askedAt !== null) {
      if (now - this.#askedAt >= this.#answerWithin()) this.#dead();

      return;
    }

    if (this.#sentAt !== null && this.#heardAt > this.#sentAt) this.#sentAt = null;

    if (this.#sentAt !== null && now - this.#sentAt >= PROBE_AFTER_SEND_MS) this.#ping();
    else if (this.#env.visible() && now - this.#heardAt >= QUIET_MS) this.#ping();
  }

  #kindAt(now: number): ConnectionKind {
    if (this.#live) return "open";

    if (this.#reach === "signed-out") return "signed-out";
    const down = now - this.#downSince;

    // A blip keeps what was shown: the dot doesn't flicker for a socket that comes straight back.
    if (down < GRACE_MS) return this.#wasLive ? "open" : "connecting";

    if (this.#stopped || !this.#env.online() || this.#reach === "no-network") return "offline";

    if (this.#failed >= UNREACHABLE_AFTER_FAILS || down >= UNREACHABLE_AFTER_MS) return "unreachable";

    return this.#wasLive ? "reconnecting" : "connecting";
  }

  /** When something next falls due: an answer, a quiet spell, a probe, or a drop outlasting a threshold. */
  #nextAt(now: number): number | null {
    const due: number[] = [];

    if (this.#open && this.#askedAt !== null) due.push(this.#askedAt + this.#answerWithin());
    else if (this.#open) {
      if (this.#env.visible()) due.push(this.#heardAt + QUIET_MS);

      if (this.#sentAt !== null) due.push(this.#sentAt + PROBE_AFTER_SEND_MS);
    }

    if (!this.#live) due.push(this.#downSince + GRACE_MS, this.#downSince + UNREACHABLE_AFTER_MS);

    const later = due.filter((at) => at > now);

    return later.length === 0 ? null : Math.min(...later);
  }

  #show(kind: ConnectionKind): void {
    if (kind === this.#kind) return;
    this.#kind = kind;

    for (const listener of this.#listeners) listener();
  }
}

/** How long the page fetch that tells signed out from offline may take. */
const REACH_WITHIN_MS = 5_000;

/**
 * A socket upgrade Access or the Worker refused shows the browser only a close, not its status. So ask for
 * the page: Access redirects it to its login, or the Worker refuses it, when the sign-in has lapsed.
 */
async function reachKy(): Promise<Reach> {
  try {
    const page = await fetch("/", { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(REACH_WITHIN_MS) });

    return page.type === "opaqueredirect" || page.status === 401 ? "signed-out" : "in";
  } catch {
    return "no-network";
  }
}

const BROWSER: WatchEnv = {
  online: () => navigator.onLine,
  visible: () => document.visibilityState === "visible",
  reach: reachKy
};

/** The network the page is on, where the browser says when it changes (Chrome, not Safari). */
type NetworkInformation = EventTarget & { readonly type?: string };

/**
 * What to show for `socket`, kept honest as ConnectionWatch says. `waiting` counts the messages sent
 * that ky hasn't placed; when it grows, the socket is checked soon.
 */
export function useConnection(socket: WatchedSocket, waiting: number): ConnectionKind {
  const [watch] = useState(() => new ConnectionWatch(BROWSER));
  const kind = useSyncExternalStore(watch.subscribe, watch.kind);

  useEffect(() => watch.attach(socket), [watch, socket]);

  useEffect(() => {
    const online = () => watch.online();
    const offline = () => watch.offline();
    const probe = () => document.visibilityState === "visible" && watch.probe();
    // SAFETY: navigator.connection is Chrome's Network Information API, missing from lib.dom.
    const network = (navigator as Navigator & { connection?: NetworkInformation }).connection;

    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", probe);
    network?.addEventListener("change", probe);

    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", probe);
      network?.removeEventListener("change", probe);
    };
  }, [watch]);

  useEffect(() => watch.waiting(waiting), [watch, waiting]);

  return kind;
}

/** What the pill's label and the panel say for each kind. */
export const CONNECTION_LABEL: Record<ConnectionKind, string> = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  unreachable: "Can't reach ky",
  "signed-out": "Signed out"
};

/** The pill's line under the name while the socket is down; null keeps its usual line. */
export const CONNECTION_LINE: Record<ConnectionKind, string | null> = {
  connecting: null,
  open: null,
  reconnecting: "Reconnecting…",
  offline: "Offline",
  unreachable: "Can't reach ky · retrying",
  "signed-out": "Signed out"
};

/** The status dot's tone (Controls' Tone); none is the grey pulse of a socket on its way. */
export const CONNECTION_TONE: Record<ConnectionKind, "online" | "off" | "waking" | "failed" | undefined> = {
  connecting: undefined,
  open: "online",
  reconnecting: undefined,
  offline: "off",
  unreachable: "waking",
  "signed-out": "failed"
};
