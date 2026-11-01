import { useSyncExternalStore } from "react";

/**
 * Settings → Appearance → Accent: the color of the user's bubble, the unread
 * dot and focus rings. Ink by default; the rest of ky stays ink either way.
 * Remembered in localStorage and set on <html> for the CSS (chat-kit/chat.css).
 */
export const ACCENTS = ["ink", "violet", "blue", "green", "ember", "pink"] as const;

export type Accent = (typeof ACCENTS)[number];

const KEY = "accent";

const listeners = new Set<() => void>();

const isAccent = (value: string | null): value is Accent => ACCENTS.some((each) => each === value);

function read(): Accent {
  const stored = localStorage.getItem(KEY);

  return isAccent(stored) ? stored : "ink";
}

function apply(accent: Accent): void {
  if (accent === "ink") document.documentElement.removeAttribute("data-accent");
  else document.documentElement.setAttribute("data-accent", accent);
}

export function setAccent(accent: Accent): void {
  localStorage.setItem(KEY, accent);
  apply(accent);

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** Put the remembered accent on <html>, before the first render. */
export const restoreAccent = () => apply(read());

export const useAccent = (): Accent => useSyncExternalStore(subscribe, read);
