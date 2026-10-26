import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "./Icon";
import { clock, mediaKind } from "../files/contract";
import type { PendingClip } from "./pick-media";
import { imageSrc, type PendingImage } from "./pick-images";
import type { Recorder } from "./use-recorder";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

// Where the browser sizes a field to its text, the textarea grows by itself and nothing is measured to size it.
const fieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/** What deciding pill or card needs from the textarea's style, read once per state rather than per keystroke. */
type Metrics = {
  /** Taller than this means the text wrapped: one line and its padding; the line grows with Settings → Text size. */
  readonly oneLine: number;
  readonly font: string;
  readonly paddingX: number;
};

function measure(element: HTMLElement): Metrics {
  const style = getComputedStyle(element);
  const line = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  return {
    oneLine: Math.max(parseFloat(style.minHeight), line) + 2,
    font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    paddingX: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  };
}

let ruler: CanvasRenderingContext2D | null = null;

let rulerFont = "";

// Whether the text fits on one line of a textarea this wide, padding and a little slack included.
function fitsOneLine(metrics: Metrics, text: string, width: number): boolean {
  ruler ??= document.createElement("canvas").getContext("2d");

  if (ruler === null) return text === "";

  // Setting a canvas font parses it, so only when it changes.
  if (rulerFont !== metrics.font) {
    ruler.font = metrics.font;
    rulerFont = metrics.font;
  }

  return ruler.measureText(text).width < width - metrics.paddingX - 8;
}

/** What the composer takes: images, and audio and video clips. */
const attachable = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((file) => file.type.startsWith("image/") || mediaKind(file.type) !== null);

/** The microphone: record a voice note, then attach it, send it, or throw it away. */
export type Voice = {
  readonly recorder: Recorder;
  readonly onRecord: () => void;
  /** Stop recording and attach the note; with `send`, send the message once it has gone up. */
  readonly onDone: (send: boolean) => void;
  readonly onCancel: () => void;
};

/** Someone the composer offers when the user types @. */
export type Mentionable = { readonly id: string; readonly description: string };

/** Options the menu shows at most. */
const MENU_ROWS = 6;

/** The @word the caret is in, at the start of the text or after a space: where it starts and what is typed. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));

  return match ? { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() } : null;
}

/** The ids that match what is typed after @: those it starts first, then those it is in. */
function matching(all: readonly Mentionable[], query: string): Mentionable[] {
  const starts = all.filter((each) => each.id.startsWith(query));
  const within = all.filter((each) => !each.id.startsWith(query) && each.id.includes(query));

  return [...starts, ...within].slice(0, MENU_ROWS);
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  disabled = false,
  busy = false,
  working = false,
  autoFocus = false,
  images = [],
  clips = [],
  onAddFiles,
  onRemoveImage,
  onRemoveClip,
  voice,
  children,
  label,
  mentions = [],
  history = [],
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  working?: boolean;
  autoFocus?: boolean;
  /** Images to send with the message; with onAddFiles, the composer offers to attach them. */
  images?: readonly PendingImage[];
  /** Voice notes and videos to send with the message. */
  clips?: readonly PendingClip[];
  onAddFiles?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
  onRemoveClip?: (id: string) => void;
  /** Offers the microphone. */
  voice?: Voice;
  children?: ReactNode;
  label: string;
  /** Who typing @ offers; picking one puts its @id in. */
  mentions?: readonly Mentionable[];
  /** What the user sent before, oldest first: ↑ in an empty composer brings it back. */
  history?: readonly string[];
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // The @ whose menu Escape closed; typing another opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const placeCaret = useRef<number | null>(null);
  const at = mentions.length > 0 ? mentionAt(value, caret) : null;
  const options = at && at.start !== dismissed ? matching(mentions, at.query) : [];
  const menu = options.length > 0;
  const active = Math.min(highlight, options.length - 1);

  // Which earlier message ↑ brought back, counted from the newest. It holds only while the text is
  // still that message; typing over it makes it an ordinary draft.
  const [recall, setRecall] = useState<{ index: number; text: string } | null>(null);
  const recalling = recall !== null && recall.text === value ? recall.index : null;

  const bringBack = (index: number | null) => {
    const text = index === null ? "" : (history[history.length - 1 - index] ?? "");

    setRecall(index === null ? null : { index, text });
    placeCaret.current = text.length;
    onChange(text);
  };

  const pick = (id: string) => {
    if (at === null) return;
    const before = `${value.slice(0, at.start)}@${id} `;
    placeCaret.current = before.length;
    onChange(before + value.slice(caret).replace(/^\S*\s?/, ""));
    setHighlight(0);
  };

  useLayoutEffect(() => {
    const element = area.current;

    if (placeCaret.current === null || element === null) return;
    element.focus();
    element.setSelectionRange(placeCaret.current, placeCaret.current);
    setCaret(placeCaret.current);
    placeCaret.current = null;
  }, [value]);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // A pill while it is one line; once the text wraps it opens into a card with the buttons
  // below. It closes again only when the text would fit the pill's narrower line, measured
  // against the width the pill had, so it never flips back and forth at the edge.
  const [open, setOpen] = useState(false);
  const pillWidth = useRef(0);
  const metrics = useRef<Metrics | null>(null);
  const openNow = useRef(open);

  // The pill's width, kept as layout settles rather than read (forcing a layout) on every keystroke.
  useLayoutEffect(() => {
    const element = area.current;

    if (element === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      // A resize may be a new text size, so the style is read again too.
      metrics.current = null;

      if (!openNow.current) pillWidth.current = element.clientWidth;
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = area.current;

    if (element === null) return;

    if (openNow.current !== open) {
      openNow.current = open;
      metrics.current = null;
    }

    if (!fieldSizing) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }

    if (value.includes("\n")) {
      if (!open) setOpen(true);

      return;
    }

    metrics.current ??= measure(element);

    if (open) {
      if (fitsOneLine(metrics.current, value, pillWidth.current)) setOpen(false);

      return;
    }

    if (pillWidth.current === 0) pillWidth.current = element.clientWidth;

    // Text that plainly fits the pill cannot have wrapped; only near the edge is the layout asked.
    if (!fitsOneLine(metrics.current, value, pillWidth.current) && element.scrollHeight > metrics.current.oneLine) setOpen(true);
  }, [value, open]);
  const empty = value.trim() === "" && images.length === 0 && clips.length === 0;
  const stop = working && empty && onStop !== undefined;
  const attach = onAddFiles !== undefined && !disabled;
  const recording = voice !== undefined && voice.recorder.state !== "idle" ? voice.recorder : null;

  return (
    <form
      className="composer"
      data-dragging={dragging}
      data-open={open}
      data-recording={recording !== null || undefined}
      onSubmit={(event) => {
        event.preventDefault();

        // Send while recording sends the note, once it has gone up.
        if (recording !== null) voice?.onDone(true);
        else if (stop) onStop();
        else if (!empty && !busy && !disabled) onSubmit();
      }}
      onDragOver={(event) => {
        if (!attach || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const to = event.relatedTarget;

        if (!(to instanceof Node) || !event.currentTarget.contains(to)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        const files = attachable(event.dataTransfer.files);

        if (!attach || files.length === 0) return;
        event.preventDefault();
        onAddFiles(files);
      }}
    >
      {images.length > 0 ? (
        <ul className="composer-images" aria-label="Images to send">
          {images.map((image) => (
            <li key={image.id}>
              <img src={imageSrc(image)} alt={image.name} />
              <button
                type="button"
                className="composer-image-remove"
                aria-label={`Remove ${image.name}`}
                onClick={() => onRemoveImage?.(image.id)}
              >
                <Icon name="x" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {clips.length > 0 ? (
        <ul className="composer-clips" aria-label="Clips to send">
          {clips.map((clip) => (
            <ClipChip key={clip.id} clip={clip} onRemove={() => onRemoveClip?.(clip.id)} />
          ))}
        </ul>
      ) : null}
      {onAddFiles && recording === null ? (
        <>
          <button
            type="button"
            className="attach-button pressable"
            aria-label="Attach images, audio or video"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <Icon name="plus" size={17} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*,audio/*,video/*"
            multiple
            hidden
            onChange={(event) => {
              const files = attachable(event.target.files);
              event.target.value = "";

              if (files.length > 0) onAddFiles(files);
            }}
          />
        </>
      ) : null}
      {recording !== null && voice ? <RecordingStrip recorder={recording} onCancel={voice.onCancel} /> : null}
      {menu ? (
        <ul className="mention-menu" id={menuId} role="listbox" aria-label="Specialists">
          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${menuId}-${option.id}`}
              role="option"
              aria-selected={index === active}
              className="mention-option"
              onPointerDown={(event) => {
                // Keep the focus in the text while picking.
                event.preventDefault();
                pick(option.id);
              }}
              onPointerEnter={() => setHighlight(index)}
            >
              <BotAvatar name={`@${option.id}`} identity={option.id} owner={option.id} still size={24} />
              <span className="mention-id">@{option.id}</span>
              <span className="mention-description">{option.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={area}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        aria-autocomplete={mentions.length > 0 ? "list" : undefined}
        aria-controls={menu ? menuId : undefined}
        aria-activedescendant={menu ? `${menuId}-${options[active]?.id}` : undefined}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          onChange(event.target.value);
        }}
        hidden={recording !== null}
        onPaste={(event) => {
          const files = attachable(event.clipboardData.files);

          if (!attach || files.length === 0) return;
          event.preventDefault();
          onAddFiles(files);
        }}
        onKeyDown={(event) => {
          if (menu && !event.nativeEvent.isComposing) {
            const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;

            if (step !== 0) {
              event.preventDefault();
              setHighlight((active + step + options.length) % options.length);

              return;
            }

            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(options[active]!.id);

              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(at?.start ?? null);

              return;
            }
          }

          const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing;
          const { selectionStart, selectionEnd } = event.currentTarget;
          const collapsed = selectionStart === selectionEnd;

          // ↑ on the first line steps back through what was sent: from an empty composer, or
          // from a message ↑ already brought back. ↓ on the last line steps forward, then to empty.
          if (plain && collapsed && event.key === "ArrowUp" && !value.slice(0, selectionStart).includes("\n")) {
            const next = recalling === null ? (value === "" && images.length === 0 ? 0 : null) : recalling + 1;

            if (next !== null && next < history.length) {
              event.preventDefault();
              bringBack(next);
            }

            return;
          }

          if (plain && collapsed && event.key === "ArrowDown" && recalling !== null && !value.slice(selectionEnd).includes("\n")) {
            event.preventDefault();
            bringBack(recalling === 0 ? null : recalling - 1);

            return;
          }

          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const send = event.metaKey || event.ctrlKey || (!event.shiftKey && !coarse());

          if (!send) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="composer-bar">
        {recording === null ? children : null}
        {voice && recording === null ? (
          <button type="button" className="mic-button pressable" aria-label="Record a voice note" disabled={disabled} onClick={voice.onRecord}>
            <Icon name="mic" size={17} />
          </button>
        ) : null}
        {voice && recording !== null ? (
          <button type="button" className="mic-button pressable" aria-label="Done recording" disabled={recording.state !== "recording"} onClick={() => voice.onDone(false)}>
            <Icon name="check" size={16} />
          </button>
        ) : null}
        <button
          type="submit"
          className="send-button pressable"
          data-mode={stop && recording === null ? "stop" : "send"}
          aria-label={recording !== null ? "Send voice note" : stop ? "Stop" : "Send"}
          disabled={disabled || (recording !== null ? recording.state !== "recording" : busy || (empty && !stop))}
        >
          <Icon name={stop && recording === null ? "stop" : "arrowUp"} size={stop && recording === null ? 12 : 15} />
        </button>
      </div>
    </form>
  );
}

/** A clip waiting to be sent: what it is, how long, and while it uploads, how far along. */
function ClipChip({ clip, onRemove }: { clip: PendingClip; onRemove: () => void }) {
  const uploading = clip.file === null;

  return (
    <li className="composer-clip" data-kind={clip.kind} data-uploading={uploading || undefined}>
      {clip.kind === "video" ? (
        <video src={clip.preview} muted playsInline preload="metadata" aria-hidden />
      ) : (
        <span className="composer-clip-wave" aria-hidden>
          {Array.from({ length: 20 }, (_, index) => (clip.peaks ?? "").charAt(index * 2) || "3").map((digit, index) => (
            <span key={index} style={{ height: `${Math.max(14, (Number(digit) + 1) * 10)}%` }} />
          ))}
        </span>
      )}
      <span className="composer-clip-label">
        <span>{clip.kind === "audio" ? clip.name : clip.seconds !== null ? clock(clip.seconds) : "Video"}</span>
        {clip.kind === "audio" && clip.seconds !== null ? <span className="quiet">{clock(clip.seconds)}</span> : null}
      </span>
      {uploading ? <span className="composer-clip-progress" style={{ width: `${clip.progress * 100}%` }} role="progressbar" aria-label={`Uploading ${clip.name}`} aria-valuenow={Math.round(clip.progress * 100)} /> : null}
      <button type="button" className="composer-image-remove" aria-label={`Remove ${clip.name}`} onClick={onRemove}>
        <Icon name="x" size={10} />
      </button>
    </li>
  );
}

/** While a voice note records: throw it away, how long it has gone, its sound as it comes, and the words heard. */
function RecordingStrip({ recorder, onCancel }: { recorder: Exclude<Recorder, { state: "idle" }>; onCancel: () => void }) {
  const live = recorder.state === "recording" ? recorder : null;

  return (
    <div className="recording-strip" role="status" aria-label={live ? `Recording, ${clock(live.seconds)}` : "Starting the microphone"}>
      <button type="button" className="attach-button pressable" aria-label="Discard voice note" onClick={onCancel}>
        <Icon name="x" size={15} />
      </button>
      <span className="recording-dot" aria-hidden />
      <span className="recording-time">{clock(live?.seconds ?? 0)}</span>
      <span className="recording-wave" aria-hidden>
        {Array.from({ length: 28 }, (_, index) => {
          const level = live?.levels[index - (28 - (live?.levels.length ?? 0))] ?? 0;

          return <span key={index} style={{ height: `${Math.max(10, level * 100)}%` }} />;
        })}
      </span>
      {/* Right to left, so the newest words stay in view; the words inside keep their own direction. */}
      <span className="recording-heard">
        <bdi>{live?.heard || (live ? "Listening…" : "Starting…")}</bdi>
      </span>
    </div>
  );
}
