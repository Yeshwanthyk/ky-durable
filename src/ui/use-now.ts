import { useEffect, useState } from "react";

// The time, refreshed every 30 seconds so "5m ago" labels keep up.
export function useNow(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  return now;
}
