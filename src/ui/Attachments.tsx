import { createContext, useContext } from "react";
import type { FileRow } from "../protocol";

// Files machine tasks shared, from the task feed; the thread and the task list read them here.
export const FilesContext = createContext<ReadonlyArray<FileRow>>([]);

export function Attachments({ task, compact = false }: { task: string; compact?: boolean }) {
  const files = useContext(FilesContext).filter((file) => file.task === task);
  if (files.length === 0) return null;
  return (
    <div className="attachments" data-compact={compact}>
      {[...files].reverse().map((file) => {
        const href = `/api/files/${file.id}`;
        const label = file.caption ?? file.name;
        return (
          <figure key={file.id} className="attachment">
            {file.type.startsWith("video/") ? (
              <video src={href} controls playsInline preload="metadata" />
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                <img src={href} alt={label} loading="lazy" />
              </a>
            )}
            {compact ? null : <figcaption>{label}</figcaption>}
          </figure>
        );
      })}
    </div>
  );
}
