import { useEffect, useState } from "react";

/** The main chat's session. Side chats and subagents have their own. */
export const MAIN_SESSION = "1";

function sessionFromUrl(): string {
  const session = new URLSearchParams(location.search).get("session");

  return session && /^[\w-]{1,64}$/.test(session) ? session : MAIN_SESSION;
}

// The open chat lives in the URL, so back and forward move between chats.
export function useSessionRoute(): [string, (next: string) => void] {
  const [session, setSession] = useState(sessionFromUrl);

  useEffect(() => {
    const onPop = () => setSession(sessionFromUrl());
    addEventListener("popstate", onPop);

    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = (next: string) => {
    if (next === session) return;
    history.pushState(null, "", next === MAIN_SESSION ? "/" : `/?session=${next}`);
    setSession(next);
  };

  return [session, go];
}
