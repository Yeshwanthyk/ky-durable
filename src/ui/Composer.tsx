import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "./Icon";
import { imageSrc, type PendingImage } from "./pick-images";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

// Taller than one line and its padding means the text wrapped; the line grows with Settings → Text size.
function oneLine(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const line = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  return Math.max(parseFloat(style.minHeight), line) + 2;
}

let ruler: CanvasRenderingContext2D | null = null;

// Whether the text fits on one line of a textarea this wide, padding and a little slack included.
function fitsOneLine(element: HTMLTextAreaElement, text: string, width: number): boolean {
  ruler ??= document.createElement("canvas").getContext("2d");

  if (ruler === null) return text === "";
  const style = getComputedStyle(element);
  ruler.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const room = width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8;

  return ruler.measureText(text).width < room;
}

const imageFiles = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((file) => file.type.startsWith("image/"));

/** Someone the composer offers when the user types @. */
export type Mentionable = { readonly id: string; readonly description: string };

/** Options the menu shows at most. */
const MENU_ROWS = 6;

/** The @word the caret is in, at the start of the text or after a space: where it starts and what is typed. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));

  return match ? { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() } : null;
}

/** The ids that match what is typed after @: those it starts first, then those it is in. */
export function matching(all: readonly Mentionable[], query: string): Mentionable[] {
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
  onAddImages,
  onRemoveImage,
  children,
  label,
  mentions = [],
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
  /** Images to send with the message; with onAddImages, the composer offers to attach them. */
  images?: readonly PendingImage[];
  onAddImages?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
  children?: ReactNode;
  label: string;
  /** Who typing @ offers; picking one puts its @id in. */
  mentions?: readonly Mentionable[];
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
  useLayoutEffect(() => {
    const element = area.current;

    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;

    if (!open) {
      pillWidth.current = element.clientWidth;

      if (value.includes("\n") || element.scrollHeight > oneLine(element)) setOpen(true);
    } else if (!value.includes("\n") && fitsOneLine(element, value, pillWidth.current)) setOpen(false);
  }, [value, open]);
  const empty = value.trim() === "" && images.length === 0;
  const stop = working && empty && onStop !== undefined;
  const attach = onAddImages !== undefined && !disabled;

  return (
    <form
      className="composer"
      data-dragging={dragging}
      data-open={open}
      onSubmit={(event) => {
        event.preventDefault();

        if (stop) onStop();
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
        const files = imageFiles(event.dataTransfer.files);

        if (!attach || files.length === 0) return;
        event.preventDefault();
        onAddImages(files);
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
      {onAddImages ? (
        <>
          <button
            type="button"
            className="attach-button pressable"
            aria-label="Attach images"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <Icon name="image" size={17} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = imageFiles(event.target.files);
              event.target.value = "";

              if (files.length > 0) onAddImages(files);
            }}
          />
        </>
      ) : null}
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
              <BotAvatar name={`@${option.id}`} identity={option.id} still size={24} />
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
        onPaste={(event) => {
          const files = imageFiles(event.clipboardData.files);

          if (!attach || files.length === 0) return;
          event.preventDefault();
          onAddImages(files);
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

          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const send = event.metaKey || event.ctrlKey || (!event.shiftKey && !coarse());

          if (!send) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="composer-bar">
        {children}
        <button
          type="submit"
          className="send-button pressable"
          data-mode={stop ? "stop" : "send"}
          aria-label={stop ? "Stop" : "Send"}
          disabled={disabled || busy || (empty && !stop)}
        >
          <Icon name={stop ? "stop" : "arrowUp"} size={stop ? 12 : 15} />
        </button>
      </div>
    </form>
  );
}
