import { createContext, useContext } from "react";
import type { FileRow } from "../protocol";
import { type Media, useLightbox } from "./Lightbox";

// Files machine tasks shared, from the task feed; the thread and the task list read them here.
export const FilesContext = createContext<ReadonlyArray<FileRow>>([]);

export function Attachments({ task, compact = false }: { task: string; compact?: boolean }) {
  const files = useContext(FilesContext).filter((file) => file.task === task);
  const open = useLightbox();

  if (files.length === 0) return null;

  const media: Media[] = [...files].reverse().map((file) => ({
    src: `/api/files/${file.id}`,
    label: file.caption ?? file.name,
    video: file.type.startsWith("video/")
  }));

  return (
    <div className="attachments" data-compact={compact}>
      {media.map((item, index) => (
        <figure key={item.src} className="attachment">
          {item.video && !compact ? (
            <video src={item.src} controls playsInline preload="metadata" />
          ) : (
            <button type="button" className="attachment-open" aria-label={`Open ${item.label}`} onClick={() => open(media, index)}>
              {item.video ? (
                <video src={item.src} muted playsInline preload="metadata" />
              ) : (
                <img src={item.src} alt={item.label} loading="lazy" />
              )}
            </button>
          )}
          {compact ? null : <figcaption>{item.label}</figcaption>}
        </figure>
      ))}
    </div>
  );
}
