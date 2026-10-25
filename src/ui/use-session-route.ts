import { useEffect, useState } from "react";
import Type from "typebox";
import { decodeOr } from "../core/decode";
import { MAIN_SESSION } from "./open-chat";

/** A tapped notification's chat, as public/sw.js posts it to an open ky: the chat's query, `?session=…`. */
const OpenChat = Type.Object({ type: Type.Literal("open-chat"), search: Type.String() });

/** What the Artifacts page shows: everything, or one kind. */
const ARTIFACT_KINDS = ["all", "sites", "images", "videos", "audio"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** What the Skills page shows: everything, kits, plain skills, the ones with questions to answer, or the archive. */
const SKILL_FILTERS = ["all", "kits", "skills", "needs", "archived"] as const;

export type SkillFilter = (typeof SKILL_FILTERS)[number];

function sessionFromUrl(search = location.search): string {
  const session = new URLSearchParams(search).get("session");

  return session && /^[\w-]{1,64}$/.test(session) ? session : MAIN_SESSION;
}

function artifactsFromUrl(search = location.search): ArtifactKind | null {
  const kind = new URLSearchParams(search).get("artifacts");

  return ARTIFACT_KINDS.find((each) => each === kind) ?? null;
}

function skillsFromUrl(search = location.search): SkillFilter | null {
  const filter = new URLSearchParams(search).get("skills");

  return SKILL_FILTERS.find((each) => each === filter) ?? null;
}

declare global {
  interface Window {
    /** The installed app's launches (Chromium): the manifest's launch_handler brings an open ky forward instead of opening another. */
    readonly launchQueue?: { setConsumer(consume: (params: { readonly targetURL?: string }) => void): void };
  }
}

const urlOf = (session: string, artifacts: ArtifactKind | null = null, skills: SkillFilter | null = null) => {
  const query = new URLSearchParams();

  if (artifacts !== null) query.set("artifacts", artifacts);

  if (skills !== null) query.set("skills", skills);

  if (session !== MAIN_SESSION) query.set("session", session);
  const search = query.toString();

  return search === "" ? "/" : `/?${search}`;
};

/** The open chat, and the Artifacts or Skills page when one covers the chat. */
export type Route = {
  readonly session: string;
  readonly artifacts: ArtifactKind | null;
  readonly skills: SkillFilter | null;
  /** Opens a chat, closing either page. */
  readonly go: (next: string) => void;
  readonly showArtifacts: (kind: ArtifactKind) => void;
  readonly showSkills: (filter: SkillFilter) => void;
};

// The open chat and the page over it live in the URL, so back and forward move between them.
export function useSessionRoute(): Route {
  const [session, setSession] = useState(sessionFromUrl);
  const [artifacts, setArtifacts] = useState(artifactsFromUrl);
  // One page at a time: the Artifacts page wins a URL that names both.
  const [skills, setSkills] = useState(() => (artifactsFromUrl() === null ? skillsFromUrl() : null));

  useEffect(() => {
    const onPop = () => {
      setSession(sessionFromUrl());
      setArtifacts(artifactsFromUrl());
      setSkills(artifactsFromUrl() === null ? skillsFromUrl() : null);
    };

    // A tapped notification opens its chat here, as going to it would, without reloading the page.
    const onMessage = (event: MessageEvent) => {
      const open = decodeOr(OpenChat, event.data, undefined);

      if (!open) return;
      const next = sessionFromUrl(open.search);

      if (urlOf(next) !== location.pathname + location.search) history.pushState(null, "", urlOf(next));
      setSession(next);
      setArtifacts(null);
      setSkills(null);
    };

    // An installed ky launched again, from a shortcut say, opens where it was launched at here, as a tapped
    // notification's chat does. Its first launch is the address already open.
    window.launchQueue?.setConsumer(({ targetURL }) => {
      const target = targetURL === undefined ? null : new URL(targetURL);

      if (target === null || target.origin !== location.origin) return;
      const [next, kind] = [sessionFromUrl(target.search), artifactsFromUrl(target.search)];
      const filter = kind === null ? skillsFromUrl(target.search) : null;
      const url = urlOf(next, kind, filter);

      if (url === location.pathname + location.search) return;
      history.pushState(null, "", url);
      setSession(next);
      setArtifacts(kind);
      setSkills(filter);
    });

    const worker = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    addEventListener("popstate", onPop);
    worker?.addEventListener("message", onMessage);

    return () => {
      removeEventListener("popstate", onPop);
      worker?.removeEventListener("message", onMessage);
    };
  }, []);

  const go = (next: string) => {
    if (next === session && artifacts === null && skills === null) return;
    history.pushState(null, "", urlOf(next));
    setSession(next);
    setArtifacts(null);
    setSkills(null);
  };

  const showArtifacts = (kind: ArtifactKind) => {
    if (kind === artifacts) return;
    history.pushState(null, "", urlOf(session, kind));
    setArtifacts(kind);
    setSkills(null);
  };

  const showSkills = (filter: SkillFilter) => {
    if (filter === skills) return;
    history.pushState(null, "", urlOf(session, null, filter));
    setSkills(filter);
    setArtifacts(null);
  };

  return { session, artifacts, skills, go, showArtifacts, showSkills };
}
