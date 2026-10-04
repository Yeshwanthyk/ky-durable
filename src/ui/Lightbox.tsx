import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

// Images and videos open over the page instead of in a new tab. One dialog for the
// whole app; arrows step through the set it was opened from, Escape or a click
// outside closes it.

export type Media = { src: string; label: string; video?: boolean };

type Opened = { items: readonly Media[]; index: number };

const LightboxContext = createContext<(items: readonly Media[], index: number) => void>(() => {});

export const useLightbox = () => useContext(LightboxContext);

export function LightboxProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  const open = useCallback((items: readonly Media[], index: number) => {
    setOpened({ items, index });
    dialog.current?.showModal();
  }, []);

  const step = useCallback((by: number) => {
    setOpened((current) =>
      current
        ? { ...current, index: (current.index + by + current.items.length) % current.items.length }
        : current
    );
  }, []);

  useEffect(() => {
    const element = dialog.current;

    if (!element) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
    };

    element.addEventListener("keydown", onKey);

    return () => element.removeEventListener("keydown", onKey);
  }, [step]);

  const item = opened?.items[opened.index];
  const many = (opened?.items.length ?? 0) > 1;

  return (
    <LightboxContext.Provider value={open}>
      {children}
      <dialog
        ref={dialog}
        className="lightbox"
        aria-label={item?.label ?? "Media"}
        // Keep the item through the exit fade; just stop a playing video.
        onClose={() => dialog.current?.querySelector("video")?.pause()}
        // A click on the backdrop lands on the dialog itself, not on its content.
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {item ? (
          <figure className="lightbox-figure">
            {item.video ? (
              <video key={item.src} src={item.src} controls autoPlay playsInline />
            ) : (
              <img key={item.src} src={item.src} alt={item.label} />
            )}
            <figcaption>
              <span className="lightbox-label">{item.label}</span>
              {many ? (
                <span className="lightbox-count">
                  {opened!.index + 1} / {opened!.items.length}
                </span>
              ) : null}
              <a href={item.src} target="_blank" rel="noreferrer">
                Original
              </a>
            </figcaption>
          </figure>
        ) : null}
        {many ? (
          <>
            <button type="button" className="lightbox-step" data-side="left" aria-label="Previous" onClick={() => step(-1)}>
              ‹
            </button>
            <button type="button" className="lightbox-step" data-side="right" aria-label="Next" onClick={() => step(1)}>
              ›
            </button>
          </>
        ) : null}
        <button type="button" className="lightbox-close" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </dialog>
    </LightboxContext.Provider>
  );
}
