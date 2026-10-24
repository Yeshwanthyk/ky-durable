import { createContext, useContext } from "react";
import { DIFF_TYPE } from "../files";
import type { FileRow } from "../protocol";
import { useLightbox } from "./Lightbox";
import { VideoClip, VoiceNote } from "./Media";

// Files machine tasks shared, from the task feed; the thread and the task list read them here.
export const FilesContext = createContext<ReadonlyArray<FileRow>>([]);

/** Screenshots, recordings and sounds; a task's patches show as its Changes instead. */
export const isMedia = (file: FileRow) => file.type !== DIFF_TYPE;

export function Attachments({ task, compact = false }: { task: string; compact?: boolean }) {
  const files = useContext(FilesContext).filter((file) => file.task === task && isMedia(file));
  const open = useLightbox();

  if (files.length === 0) return null;

  const shown = [...files].reverse();
  const sounds = shown.filter((file) => file.type.startsWith("audio/"));

  // Screenshots and videos open in the lightbox; a recording of sound plays where it is.
  const media = shown
    .filter((file) => !file.type.startsWith("audio/"))
    .map((file) => ({ src: `/files/${file.id}`, name: file.name, label: file.caption ?? file.name, video: file.type.startsWith("video/") }));

  return (
    <div className="attachments" data-compact={compact}>
      {sounds.map((file) => (
        <VoiceNote key={file.id} src={`/files/${file.id}`} seconds={null} peaks={null} label={file.caption ?? file.name} name={file.name} transcript={compact ? "" : (file.caption ?? file.name)} />
      ))}
      {media.map((item, index) =>
        item.video && !compact ? (
          <VideoClip key={item.src} src={item.src} label={item.label} caption={item.label} name={item.name} />
        ) : (
          <figure key={item.src} className="attachment">
            <button type="button" className="attachment-open" aria-label={`Open ${item.label}`} onClick={() => open(media, index)}>
              {item.video ? (
                <video src={item.src} muted playsInline preload="metadata" />
              ) : (
                <img src={item.src} alt={item.label} loading="lazy" />
              )}
            </button>
            {compact ? null : <figcaption>{item.label}</figcaption>}
          </figure>
        )
      )}
    </div>
  );
}
