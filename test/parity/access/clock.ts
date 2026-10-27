import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export function clockAt(now: () => number): Clock.Clock {
  const live = Clock.Clock.defaultValue();
  const nanos = () => BigInt(now()) * 1_000_000n;

  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration)
  };
}
