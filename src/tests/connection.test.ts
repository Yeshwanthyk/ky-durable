import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionWatch,
  FIRST_FRAME_MS,
  GRACE_MS,
  PROBE_AFTER_SEND_MS,
  QUIET_MS,
  type Reach,
  REPLY_MS,
  UNREACHABLE_AFTER_MS
} from "../connection";
import { PING } from "../protocol";

/** A socket the test opens, speaks on and drops, as partysocket's would. */
class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  reconnects = 0;
  closes = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  reconnect(): void {
    this.reconnects++;

    if (this.readyState === 1) this.drop();
  }

  close(): void {
    this.closes++;

    if (this.readyState === 1) this.drop();
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  say(): void {
    this.dispatchEvent(new Event("message"));
  }

  drop(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  pings(): number {
    return this.sent.filter((each) => each === PING).length;
  }
}

/** The browser as the watch sees it. */
type Browser = { online: boolean; visible: boolean; reach: Reach };

const browser: Browser = { online: true, visible: true, reach: "in" };

function watching() {
  const watch = new ConnectionWatch({ online: () => browser.online, visible: () => browser.visible, reach: async () => browser.reach });
  const socket = new FakeSocket();
  const detach = watch.attach(socket);

  return { watch, socket, detach };
}

/** Open the socket and hear ky's hello. */
function connect(socket: FakeSocket): void {
  socket.open();
  socket.say();
}

describe("the connection watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    browser.online = true;
    browser.visible = true;
    browser.reach = "in";
  });

  afterEach(() => vi.useRealTimers());

  it("is connecting until ky's hello, then open", () => {
    const { watch, socket } = watching();
    expect(watch.kind()).toBe("connecting");

    socket.open();
    expect(watch.kind()).toBe("connecting");

    socket.say();
    expect(watch.kind()).toBe("open");
  });

  it("keeps the dot through a blip, then says reconnecting, then that it can't reach ky", async () => {
    const { watch, socket } = watching();
    connect(socket);

    socket.drop();
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
    expect(watch.kind()).toBe("open");

    await vi.advanceTimersByTimeAsync(200);
    expect(watch.kind()).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(UNREACHABLE_AFTER_MS - GRACE_MS);
    expect(watch.kind()).toBe("unreachable");

    connect(socket);
    expect(watch.kind()).toBe("open");
  });

  it("never shows a socket that comes straight back as down", async () => {
    const { watch, socket } = watching();
    connect(socket);
    const shown: string[] = [];
    watch.subscribe(() => shown.push(watch.kind()));

    socket.drop();
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    connect(socket);
    await vi.advanceTimersByTimeAsync(UNREACHABLE_AFTER_MS);
    expect(shown).toEqual([]);
  });

  it("can't reach ky once two attempts fail, before the clock says so", async () => {
    const { watch, socket } = watching();
    connect(socket);
    socket.drop();

    socket.open();
    socket.drop();
    socket.open();
    socket.drop();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(watch.kind()).toBe("unreachable");
  });

  it("offline, stops the socket retrying and says so; online, reconnects at once", async () => {
    const { watch, socket } = watching();
    connect(socket);

    browser.online = false;
    socket.drop();
    expect(socket.closes).toBe(1);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(watch.kind()).toBe("offline");

    browser.online = true;
    watch.online();
    expect(socket.reconnects).toBe(1);
    connect(socket);
    expect(watch.kind()).toBe("open");
  });

  it("going offline with a live socket asks it first, and stops it only when it doesn't answer", async () => {
    const { watch, socket } = watching();
    connect(socket);
    await vi.advanceTimersByTimeAsync(2_000);

    browser.online = false;
    watch.offline();
    expect(socket.pings()).toBe(1);
    expect(socket.closes).toBe(0);

    await vi.advanceTimersByTimeAsync(REPLY_MS);
    expect(socket.closes).toBe(1);
    expect(socket.reconnects).toBe(0);
  });

  it("pings a quiet socket and replaces it when the ping goes unanswered", async () => {
    const { socket } = watching();
    connect(socket);

    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    expect(socket.pings()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.pings()).toBe(1);

    await vi.advanceTimersByTimeAsync(REPLY_MS);
    expect(socket.reconnects).toBe(1);
  });

  it("keeps a quiet socket that answers its ping, and pings again only after another quiet spell", async () => {
    const { socket } = watching();
    connect(socket);

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    socket.say();
    await vi.advanceTimersByTimeAsync(REPLY_MS * 2);
    expect(socket.reconnects).toBe(0);
    expect(socket.pings()).toBe(1);

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(socket.pings()).toBe(2);
  });

  it("never pings a busy socket", async () => {
    const { socket } = watching();
    connect(socket);

    for (let second = 0; second < 60; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      socket.say();
    }

    expect(socket.pings()).toBe(0);
  });

  it("doesn't ping from a hidden page", async () => {
    const { socket } = watching();
    connect(socket);
    browser.visible = false;

    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);
    expect(socket.pings()).toBe(0);
  });

  it("checks soon after a send that nothing answers", async () => {
    const { watch, socket } = watching();
    connect(socket);

    watch.waiting(1);
    await vi.advanceTimersByTimeAsync(PROBE_AFTER_SEND_MS);
    expect(socket.pings()).toBe(1);

    await vi.advanceTimersByTimeAsync(REPLY_MS);
    expect(socket.reconnects).toBe(1);
  });

  it("doesn't check after a send that ky answered", async () => {
    const { watch, socket } = watching();
    connect(socket);

    watch.waiting(1);
    await vi.advanceTimersByTimeAsync(500);
    socket.say();
    watch.waiting(0);
    await vi.advanceTimersByTimeAsync(PROBE_AFTER_SEND_MS * 2);
    expect(socket.pings()).toBe(0);
  });

  it("replaces a socket that opens but never says hello, and counts it as a failed attempt", async () => {
    const { watch, socket } = watching();
    connect(socket);
    socket.drop();

    socket.open();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS);
    expect(socket.reconnects).toBe(1);
    expect(watch.kind()).toBe("unreachable");
  });

  it("says signed out as soon as ky's page says so, without waiting out the blip", async () => {
    const { watch, socket } = watching();
    connect(socket);

    browser.reach = "signed-out";
    socket.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.kind()).toBe("signed-out");

    browser.reach = "in";
    connect(socket);
    expect(watch.kind()).toBe("open");
  });

  it("says offline when ky's page can't be fetched though the browser says it is online", async () => {
    const { watch, socket } = watching();
    connect(socket);

    browser.reach = "no-network";
    socket.drop();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(watch.kind()).toBe("offline");
  });

  it("stops watching a socket it was detached from", async () => {
    const { watch, socket, detach } = watching();
    connect(socket);
    detach();

    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(socket.pings()).toBe(0);
    expect(watch.kind()).toBe("open");
  });
});
