import { useEffect, useState } from "react";

// The time, refreshed every 30 seconds so "5m ago" labels keep up, or every second while a clock is running.
export function useNow(ticking = false): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1_000 : 30_000);

    return () => clearInterval(timer);
  }, [ticking]);

  return now;
}
