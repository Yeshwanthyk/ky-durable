import { type DragEvent, type KeyboardEvent, type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { matching, mentionAt, type Mentionable, menuKey, moved, recallStep } from "./composer-keys";
import { Icon } from "./Icon";
import { fitsOneLine, measure, type Metrics } from "./measure";

export type { Mentionable } from "./composer-keys";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

// Where the browser sizes a field to its text, the textarea grows by itself and nothing is measured to size it.
const fieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/**
 * The microphone. While a note records, `recording` is what the host draws in the text's place (its time, its sound,
 * the words heard); Done attaches the note and Send sends it once it has gone up.
 */
export type ComposerVoice = {
  /** What takes the text's place while recording; null while the microphone is off. */
  readonly recording: ReactNode | null;
  /** The microphone is live, so the note can be taken. */
  readonly ready: boolean;
  readonly onRecord: () => void;
  /** Stop recording and attach the note; with `send`, send the message once it has gone up. */
  readonly onDone: (send: boolean) => void;
};

export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Offered in place of Send while a turn runs and nothing is typed. */
  onStop?: () => void;
  placeholder: string;
  /** The text field's accessible name. */
  label: string;
  disabled?: boolean;
  /** Something must settle first (an upload, a check), so Send waits. */
  busy?: boolean;
  /** A turn is running. */
  working?: boolean;
  autoFocus?: boolean;
  /** What waits to be sent, drawn by the host above the text. */
  attachments?: ReactNode;
  /** Something waits to be sent, so there is a message to send without text. */
  hasAttachments?: boolean;
  /** Which dropped, pasted or picked files it takes; images, audio and video by default. */
  accepts?: (file: File) => boolean;
  /** Offers attach, drop and paste. */
  onAddFiles?: (files: File[]) => void;
  /** Offers the microphone. */
  voice?: ComposerVoice;
  /** Who typing @ offers; picking one puts its @id in. */
  mentions?: readonly Mentionable[];
  /** Drawn before a mention's @id in the menu, such as its avatar. */
  renderMention?: (id: string) => ReactNode;
  /** What the user sent before, oldest first: ↑ in an empty composer brings it back. */
  history?: readonly string[];
  /** More in the button row, before the action. */
  children?: ReactNode;
};

type Defaults = Required<Pick<ComposerProps, "disabled" | "busy" | "working" | "autoFocus" | "attachments" | "hasAttachments" | "accepts" | "mentions" | "history">>;

const DEFAULTS: Defaults = {
  disabled: false,
  busy: false,
  working: false,
  autoFocus: false,
  attachments: null,
  hasAttachments: false,
  // Images, audio and video.
  accepts: (file) => /^(image|audio|video)\//.test(file.type),
  mentions: [],
  history: []
};

/** The props with what wasn't passed filled in. */
type Settled = Omit<ComposerProps, keyof Defaults> & Defaults;

const plainKey = (event: KeyboardEvent) => !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing;

/** Enter sends on a keyboard, and ⌘ or Ctrl+Enter anywhere; Shift+Enter, or Enter on touch, is a newline. */
const sends = (event: KeyboardEvent) => event.key === "Enter" && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey || (!event.shiftKey && !coarse()));

/** The @ menu's state: what it offers, which is highlighted, and the keys that move through and pick from it. */
function useMentions(mentions: readonly Mentionable[], value: string, caret: number, onChange: (value: string) => void, placeCaret: RefObject<number | null>) {
  const [highlight, setHighlight] = useState(0);
  // The @ whose menu Escape closed; typing another opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const at = mentions.length > 0 ? mentionAt(value, caret) : null;
  const options = at && at.start !== dismissed ? matching(mentions, at.query) : [];
  const active = Math.min(highlight, options.length - 1);

  const pick = (id: string | undefined) => {
    if (at === null || id === undefined) return;
    const before = `${value.slice(0, at.start)}@${id} `;
    placeCaret.current = before.length;
    onChange(before + value.slice(caret).replace(/^\S*\s?/, ""));
    setHighlight(0);
  };

  /** Whether the key moved through, picked from or closed the menu. */
  const onKey = (event: KeyboardEvent): boolean => {
    const key = options.length > 0 && !event.nativeEvent.isComposing ? menuKey(event.key) : null;

    if (key === null) return false;
    event.preventDefault();

    if (key === "close") setDismissed(at?.start ?? null);
    else if (key === "pick") pick(options[active]?.id);
    else setHighlight(moved(active, key, options.length));

    return true;
  };

  return { options, active, pick, onKey, setHighlight };
}

/** ↑ and ↓ through what was sent. A message holds as recalled only while the text is still it. */
function useRecall(history: readonly string[], value: string, canStart: boolean, onChange: (value: string) => void, placeCaret: RefObject<number | null>) {
  const [recall, setRecall] = useState<{ index: number; text: string } | null>(null);
  const recalling = recall !== null && recall.text === value ? recall.index : null;

  const bringBack = (index: number | null) => {
    const text = index === null ? "" : (history[history.length - 1 - index] ?? "");

    setRecall(index === null ? null : { index, text });
    placeCaret.current = text.length;
    onChange(text);
  };

  /** Whether the key brought a message back. */
  return (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const { selectionStart, selectionEnd } = event.currentTarget;

    if (!plainKey(event) || selectionStart !== selectionEnd) return false;
    const index = recallStep(event.key, value.slice(0, selectionStart), value.slice(selectionEnd), recalling, canStart, history.length);

    if (index === undefined) return false;
    event.preventDefault();
    bringBack(index);

    return true;
  };
}

/** Puts the caret where a pick or a recall left it, once the text it placed it in has rendered. */
function useCaret(area: RefObject<HTMLTextAreaElement | null>, value: string, onPlaced: (caret: number) => void) {
  const placeCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = area.current;
    const caret = placeCaret.current;

    if (caret === null || element === null) return;
    element.focus();
    element.setSelectionRange(caret, caret);
    onPlaced(caret);
    placeCaret.current = null;
  }, [area, value, onPlaced]);

  return placeCaret;
}

/** Sizes the textarea to its text where the browser doesn't. */
function grow(element: HTMLElement) {
  if (fieldSizing) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

/**
 * Whether the text has wrapped, which opens the pill into a card. It closes again only when the text would fit the
 * pill's narrower line, measured against the width the pill had, so it never flips back and forth at the edge.
 * `card` is whether the card shows for another reason (something waits to be sent), when the pill's width isn't
 * there to read.
 */
function useWrapped(area: RefObject<HTMLTextAreaElement | null>, value: string, card: boolean) {
  const [open, setOpen] = useState(false);
  const pillWidth = useRef(0);
  const metrics = useRef<Metrics | null>(null);
  const showing = open || card;
  const shown = useRef(showing);

  // The pill's width, kept as layout settles rather than read (forcing a layout) on every keystroke.
  useLayoutEffect(() => {
    const element = area.current;

    if (element === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      // A resize may be a new text size, so the style is read again too.
      metrics.current = null;

      if (!shown.current) pillWidth.current = element.clientWidth;
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [area]);

  useLayoutEffect(() => {
    const element = area.current;

    if (element === null) return;

    if (shown.current !== showing) {
      shown.current = showing;
      metrics.current = null;
    }

    grow(element);
    metrics.current ??= measure(element);

    if (pillWidth.current === 0 && !showing) pillWidth.current = element.clientWidth;
    const next = wraps(value, open, metrics.current, pillWidth.current, element);

    if (next !== open) setOpen(next);
  }, [area, value, open, showing]);

  return showing;
}

/** Whether the text wraps, from whether it did: open stays open until the text fits the pill again. */
function wraps(value: string, open: boolean, metrics: Metrics, pillWidth: number, element: HTMLElement): boolean {
  if (value.includes("\n")) return true;

  if (open) return !fitsOneLine(metrics, value, pillWidth);

  // Text that plainly fits the pill cannot have wrapped; only near the edge is the layout asked.
  return !fitsOneLine(metrics, value, pillWidth) && element.scrollHeight > metrics.oneLine;
}

/** Files dropped, pasted or picked: those it takes go to the host. While a file is dragged over, the composer says so. */
function useFiles({ accepts, onAddFiles, disabled }: Pick<Settled, "accepts" | "onAddFiles" | "disabled">) {
  const [dragging, setDragging] = useState(false);
  const attach = onAddFiles !== undefined && !disabled;

  const add = (files: FileList | null | undefined, event?: { preventDefault: () => void }) => {
    const wanted = attach ? [...(files ?? [])].filter(accepts) : [];

    if (wanted.length === 0) return;
    event?.preventDefault();
    onAddFiles?.(wanted);
  };

  const drop = {
    "data-dragging": dragging,
    onDragOver: (event: DragEvent) => {
      if (!attach || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      const to = event.relatedTarget;

      if (!(to instanceof Node) || !event.currentTarget.contains(to)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      setDragging(false);
      add(event.dataTransfer.files, event);
    }
  };

  return { add, drop };
}

/** What the composer's one action is now: whether a note records, whether there is nothing to send, and whether Stop shows. */
function actionOf({ voice, value, hasAttachments, working, onStop }: Settled) {
  const recording = voice?.recording ?? null;
  const empty = value.trim() === "" && !hasAttachments;

  return { recording, empty, stop: working && empty && onStop !== undefined && recording === null };
}

/** Submitting: while recording it sends the note once it has gone up; while Stop shows, it stops; else it sends. */
function submit(props: Settled, { recording, empty, stop }: ReturnType<typeof actionOf>) {
  if (recording !== null) props.voice?.onDone(true);
  else if (stop) props.onStop?.();
  else if (!empty && !props.busy && !props.disabled) props.onSubmit();
}

/**
 * A chat's composer. A pill while it is one line, a card once the text wraps or something waits to go with it; one
 * round action at its end: the microphone while nothing is typed, Send once something is, and Stop, ringed, while a
 * turn runs and nothing is typed. Typing @ offers `mentions`; ↑ brings back `history`.
 *
 * What waits to be sent (`attachments`) and how a mention looks (`renderMention`) the host draws.
 */
export function Composer(props: ComposerProps) {
  const settled: Settled = { ...DEFAULTS, ...props };
  const area = useRef<HTMLTextAreaElement>(null);
  const action = actionOf(settled);
  const files = useFiles(settled);
  const open = useWrapped(area, settled.value, settled.hasAttachments);
  const idle = action.recording === null;

  return (
    <form
      className="composer"
      data-open={open}
      data-recording={!idle || undefined}
      {...files.drop}
      onSubmit={(event) => {
        event.preventDefault();
        submit(settled, action);
      }}
    >
      {settled.attachments === null ? null : <div className="composer-attachments">{settled.attachments}</div>}
      {settled.onAddFiles && idle ? <AttachButton disabled={settled.disabled} onFiles={(picked) => files.add(picked)} /> : null}
      {action.recording}
      <ComposerField area={area} props={settled} hidden={!idle} onPaste={files.add} />
      <div className="composer-bar">
        {idle ? settled.children : null}
        <ComposerActions voice={settled.voice} empty={action.empty} stop={action.stop} disabled={settled.disabled} busy={settled.busy} />
      </div>
    </form>
  );
}

/** The text, and the @ menu over it while what is typed after @ matches someone. */
function ComposerField({
  area,
  props,
  hidden,
  onPaste
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  props: Settled;
  hidden: boolean;
  onPaste: (files: FileList, event: { preventDefault: () => void }) => void;
}) {
  const { value, onChange } = props;
  const menuId = useId();
  const [caret, setCaret] = useState(0);
  const placeCaret = useCaret(area, value, setCaret);
  const mention = useMentions(props.mentions, value, caret, onChange, placeCaret);
  const recall = useRecall(props.history, value, value === "" && !props.hasAttachments, onChange, placeCaret);
  const menu = mention.options.length > 0;

  return (
    <>
      {menu ? <MentionMenu id={menuId} options={mention.options} active={mention.active} render={props.renderMention} onPick={mention.pick} onHover={mention.setHighlight} /> : null}
      <textarea
        ref={area}
        rows={1}
        value={value}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        aria-label={props.label}
        placeholder={props.placeholder}
        aria-autocomplete={props.mentions.length > 0 ? "list" : undefined}
        aria-controls={menu ? menuId : undefined}
        aria-activedescendant={menu ? `${menuId}-${mention.options[mention.active]?.id}` : undefined}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          onChange(event.target.value);
        }}
        hidden={hidden}
        onPaste={(event) => onPaste(event.clipboardData.files, event)}
        onKeyDown={(event) => {
          if (mention.onKey(event) || recall(event) || !sends(event)) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
    </>
  );
}

/** Attach: a bare + that opens the file picker. */
function AttachButton({ disabled, onFiles }: { disabled: boolean; onFiles: (files: FileList | null) => void }) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <>
      <button type="button" className="composer-icon pressable" aria-label="Attach images, audio or video" disabled={disabled} onClick={() => picker.current?.click()}>
        <Icon name="plus" size={17} />
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/*,audio/*,video/*"
        multiple
        hidden
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}

/** Who typing @ offers, over the composer; the host draws what goes before each @id. */
function MentionMenu({
  id,
  options,
  active,
  render,
  onPick,
  onHover
}: {
  id: string;
  options: readonly Mentionable[];
  active: number;
  render: ((id: string) => ReactNode) | undefined;
  onPick: (id: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul className="mention-menu" id={id} role="listbox" aria-label="Specialists">
      {options.map((option, index) => (
        <li
          key={option.id}
          id={`${id}-${option.id}`}
          role="option"
          aria-selected={index === active}
          className="mention-option"
          onPointerDown={(event) => {
            // Keep the focus in the text while picking.
            event.preventDefault();
            onPick(option.id);
          }}
          onPointerEnter={() => onHover(index)}
        >
          {render?.(option.id)}
          <span className="mention-id">@{option.id}</span>
          <span className="mention-description">{option.description}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The composer's end: one round action. While recording, Done and Send take the note. Otherwise the microphone shows
 * while nothing is typed, and Send takes its place once something is; while a turn runs and nothing is typed, Stop,
 * ringed, stands beside the microphone. Without a microphone Send always shows, waiting while there is nothing to send.
 */
export function ComposerActions({ voice, empty, stop, disabled, busy }: { voice: ComposerVoice | undefined; empty: boolean; stop: boolean; disabled: boolean; busy: boolean }) {
  if (voice?.recording != null) {
    return (
      <>
        <button type="button" className="composer-icon pressable" aria-label="Done recording" disabled={!voice.ready} onClick={() => voice.onDone(false)}>
          <Icon name="check" size={16} />
        </button>
        <button type="submit" className="send-button pressable" data-mode="send" aria-label="Send voice note" disabled={disabled || !voice.ready}>
          <Icon name="arrowUp" size={15} />
        </button>
      </>
    );
  }

  return (
    <>
      {voice && empty ? (
        <button type="button" className="composer-icon pressable" aria-label="Record a voice note" disabled={disabled} onClick={voice.onRecord}>
          <Icon name="mic" size={17} />
        </button>
      ) : null}
      {stop ? <StopButton disabled={disabled} /> : voice && empty ? null : <SendButton disabled={disabled || busy || empty} />}
    </>
  );
}

function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button type="submit" className="send-button pressable" data-mode="send" aria-label="Send" disabled={disabled}>
      <Icon name="arrowUp" size={15} />
    </button>
  );
}

/** Stop: the ink square on a raised circle, a thin arc turning round it while the turn runs. */
function StopButton({ disabled }: { disabled: boolean }) {
  return (
    <button type="submit" className="send-button pressable" data-mode="stop" aria-label="Stop" disabled={disabled}>
      <svg className="send-ring" viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r="16.5" />
      </svg>
      <Icon name="stop" size={11} />
    </button>
  );
}
