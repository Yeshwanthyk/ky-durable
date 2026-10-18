import { useEffect, useState } from "react";
import Type from "typebox";
import { decodeOr } from "../core/decode";
import { MAIN_SESSION } from "./open-chat";

/** A tapped notification's chat, as public/sw.js posts it to an open ky: the chat's query, `?session=…`. */
const OpenChat = Type.Object({ type: Type.Literal("open-chat"), search: Type.String() });

function sessionFromUrl(search = location.search): string {
  const session = new URLSearchParams(search).get("session");

  return session && /^[\w-]{1,64}$/.test(session) ? session : MAIN_SESSION;
}

const urlOf = (session: string) => (session === MAIN_SESSION ? "/" : `/?session=${session}`);

// The open chat lives in the URL, so back and forward move between chats.
export function useSessionRoute(): [string, (next: string) => void] {
  const [session, setSession] = useState(sessionFromUrl);

  useEffect(() => {
    const onPop = () => setSession(sessionFromUrl());

    // A tapped notification opens its chat here, as going to it would, without reloading the page.
    const onMessage = (event: MessageEvent) => {
      const open = decodeOr(OpenChat, event.data, undefined);

      if (!open) return;
      const next = sessionFromUrl(open.search);

      if (next !== sessionFromUrl()) history.pushState(null, "", urlOf(next));
      setSession(next);
    };

    const worker = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    addEventListener("popstate", onPop);
    worker?.addEventListener("message", onMessage);

    return () => {
      removeEventListener("popstate", onPop);
      worker?.removeEventListener("message", onMessage);
    };
  }, []);

  const go = (next: string) => {
    if (next === session) return;
    history.pushState(null, "", urlOf(next));
    setSession(next);
  };

  return [session, go];
}
