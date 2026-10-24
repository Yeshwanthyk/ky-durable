import { useEffect, useState } from "react";
import Type from "typebox";
import { decodeOr } from "../core/decode";
import { MAIN_SESSION } from "./open-chat";

/** A tapped notification's chat, as public/sw.js posts it to an open ky: the chat's query, `?session=…`. */
const OpenChat = Type.Object({ type: Type.Literal("open-chat"), search: Type.String() });

/** What the Artifacts page shows: everything, or one kind. */
const ARTIFACT_KINDS = ["all", "sites", "images", "videos", "audio"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

function sessionFromUrl(search = location.search): string {
  const session = new URLSearchParams(search).get("session");

  return session && /^[\w-]{1,64}$/.test(session) ? session : MAIN_SESSION;
}

function artifactsFromUrl(search = location.search): ArtifactKind | null {
  const kind = new URLSearchParams(search).get("artifacts");

  return ARTIFACT_KINDS.find((each) => each === kind) ?? null;
}

const urlOf = (session: string, artifacts: ArtifactKind | null = null) => {
  const query = new URLSearchParams();

  if (artifacts !== null) query.set("artifacts", artifacts);

  if (session !== MAIN_SESSION) query.set("session", session);
  const search = query.toString();

  return search === "" ? "/" : `/?${search}`;
};

/** The open chat, and the Artifacts page when it covers the chat. */
export type Route = {
  readonly session: string;
  readonly artifacts: ArtifactKind | null;
  /** Opens a chat, closing the Artifacts page. */
  readonly go: (next: string) => void;
  readonly showArtifacts: (kind: ArtifactKind) => void;
};

// The open chat and the Artifacts page live in the URL, so back and forward move between them.
export function useSessionRoute(): Route {
  const [session, setSession] = useState(sessionFromUrl);
  const [artifacts, setArtifacts] = useState(artifactsFromUrl);

  useEffect(() => {
    const onPop = () => {
      setSession(sessionFromUrl());
      setArtifacts(artifactsFromUrl());
    };

    // A tapped notification opens its chat here, as going to it would, without reloading the page.
    const onMessage = (event: MessageEvent) => {
      const open = decodeOr(OpenChat, event.data, undefined);

      if (!open) return;
      const next = sessionFromUrl(open.search);

      if (urlOf(next) !== location.pathname + location.search) history.pushState(null, "", urlOf(next));
      setSession(next);
      setArtifacts(null);
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
    if (next === session && artifacts === null) return;
    history.pushState(null, "", urlOf(next));
    setSession(next);
    setArtifacts(null);
  };

  const showArtifacts = (kind: ArtifactKind) => {
    if (kind === artifacts) return;
    history.pushState(null, "", urlOf(session, kind));
    setArtifacts(kind);
  };

  return { session, artifacts, go, showArtifacts };
}
