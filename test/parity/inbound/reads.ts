import type { JsonObject } from "@earendil-works/pi-ai";
import type { SQLOutputValue } from "node:sqlite";
import type { HookDelivery, Received } from "../../../src/inbound/inbound";
import type { Hook, SecretAsk } from "../../../src/inbound/shapes";

type Side = {
  readonly inbound: {
    hooks(): Hook[];
    hook(id: string): Hook | undefined;
    asks(session: string): SecretAsk[];
    askFor(session: string, name: string): SecretAsk | undefined;
    guarded(conversation: string): boolean;
    passed(conversation: string, tool: string, args: JsonObject): boolean;
    received(id: string, delivery: HookDelivery): Promise<Received>;
    saved(session: string, name: string): Promise<boolean>;
  };
  readonly told: readonly (readonly [string, string, string])[];
  readonly tables: () => Readonly<Record<string, readonly Readonly<Record<string, SQLOutputValue>>[]>>;
};

const SIGNED = "0123456789abcdef0123456789abcdef";

const PLAIN = "fedcba9876543210fedcba9876543210";

const GONE = "00000000000000000000000000000000";

const SESSIONS = ["0", "1", "2"];

const NAMES = ["API_KEY", "gh", "OLD", "none"];

const delivery = (signature: string | null, id: string | null): HookDelivery => ({ body: '{"action":"opened"}', source: "ci", event: "pull_request", signature, delivery: id });

export async function readsOf(side: Side) {
  const { inbound } = side;

  const before = {
    hooks: inbound.hooks(),
    hook: [SIGNED, PLAIN, GONE, "none"].map((id) => inbound.hook(id) ?? null),
    asks: SESSIONS.map((session) => inbound.asks(session)),
    askFor: SESSIONS.flatMap((session) => NAMES.map((name) => inbound.askFor(session, name) ?? null)),
    guarded: SESSIONS.map((conversation) => inbound.guarded(conversation))
  };

  const passed = [
    inbound.passed("0", "write", { path: "/old" }),
    inbound.passed("0", "write", { path: "/b" }),
    inbound.passed("1", "write", { path: "/a" }),
    inbound.passed("0", "write", { path: "/a" }),
    inbound.passed("0", "write", { path: "/a" })
  ];

  const received = [];

  for (const [id, sent] of [
    [SIGNED, delivery("sha256=old", "d0")],
    [SIGNED, delivery("sha256=new", "d9")],
    [SIGNED, delivery("sha256=fresh", "d2")],
    [PLAIN, delivery(null, "u1")],
    [PLAIN, delivery(null, "u9")],
    [GONE, delivery(null, "g1")],
    ["none", delivery(null, "n1")]
  ] as const) {
    received.push(await inbound.received(id, sent));
  }

  const saved = [];

  for (const [session, name] of [
    ["0", "API_KEY"],
    ["0", "API_KEY"],
    ["1", "gh"],
    ["2", "none"]
  ] as const) {
    saved.push(await inbound.saved(session, name));
  }

  return { ...before, passed, received, saved, told: side.told, after: side.tables() };
}
