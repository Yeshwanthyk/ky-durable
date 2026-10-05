import { type DiffLineAnnotation, type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { FilesContext } from "./Attachments";
import { countsOf, type Draft, feedbackMessage, fileLabel, latestDiff, type LineComment, type Note, notesOn } from "./review";
import { Icon } from "./Icon";

// A machine task's code changes, from the newest patch its `ky-diff` shared:
// a collapsed row with the totals, then a file list, then each file's diff.
// Tapping a line leaves a comment; the comments go to the task as one message.

export const SendTaskContext = createContext<(task: string, message: string) => void>(() => {});

const patches = new Map<string, Promise<string>>();

/** A patch's text, fetched once per page: its id never names other bytes. */
function patchText(id: string): Promise<string> {
  let text = patches.get(id);

  if (!text) {
    text = fetch(`/api/files/${id}`).then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))));
    patches.set(id, text);
  }

  return text;
}

/** The patch's files; none while it loads, or if it could not be read. */
function usePatch(id: string | undefined): FileDiffMetadata[] {
  const [text, setText] = useState<string | "failed" | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setText(null);
    patchText(id).then(
      (value) => live && setText(value),
      () => live && setText("failed")
    );

    return () => {
      live = false;
    };
  }, [id]);

  return useMemo(() => {
    if (text === null || text === "failed") return [];

    return parsePatchFiles(text, id).flatMap((patch) => patch.files);
  }, [text, id]);
}

/** Whether the element is wide enough for two columns: the thread on a desktop, not a phone or the Activity panel. */
function useWide(element: HTMLElement | null): boolean {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= SPLIT_WIDTH));
    observer.observe(element);

    return () => observer.disconnect();
  }, [element]);

  return wide;
}

const SPLIT_WIDTH = 600;

/** The light or dark mode use-theme sets on <html>. */
function useMode(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.mode === "dark" ? "dark" : "light");
  const [mode, setMode] = useState(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

    return () => observer.disconnect();
  }, []);

  return mode;
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="change-counts tabular">
      <span className="added">+{additions}</span>
      <span className="removed">−{deletions}</span>
    </span>
  );
}

/** The user's line comments on one task's changes, and sending them to the task. */
function useReview(task: string) {
  const send = useContext(SendTaskContext);
  const [comments, setComments] = useState<readonly LineComment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sent, setSent] = useState(false);

  return {
    comments,
    draft,
    sent,
    pick: (line: Draft) => {
      setSent(false);
      setDraft(line);
    },
    cancel: () => setDraft(null),
    save: (text: string) => {
      setComments((current) => (draft ? [...current, { ...draft, text }] : current));
      setDraft(null);
    },
    remove: (index: number) => setComments((current) => current.filter((_, at) => at !== index)),
    submit: () => {
      send(task, feedbackMessage(comments));
      setComments([]);
      setDraft(null);
      setSent(true);
    }
  };
}

type Review = ReturnType<typeof useReview>;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function Changes({ task }: { task: string }) {
  const diff = latestDiff(useContext(FilesContext), task);
  const files = usePatch(diff?.id);

  if (!diff || files.length === 0) return null;

  return <ChangeSet task={task} caption={diff.caption} files={files} />;
}

function ChangeSet({ task, caption, files }: { task: string; caption: string | null; files: FileDiffMetadata[] }) {
  const [open, setOpen] = useState(false);
  const review = useReview(task);

  return (
    <div className="tool changes">
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="branch" size={14} />
        <span className="verb">Changes</span>
        <span className="target">{plural(files.length, "file")}</span>
        <span className="trail">
          <Counts {...countsOf(files)} />
          <Icon name="chevronRight" size={12} className="chevron" />
        </span>
      </button>
      {open ? <ChangesBody caption={caption} files={files} review={review} /> : null}
    </div>
  );
}

function ChangesBody({ caption, files, review }: { caption: string | null; files: FileDiffMetadata[]; review: Review }) {
  const [split, setSplit] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const wide = useWide(box);
  const mode = useMode();
  const style = wide && split ? "split" : "unified";

  return (
    <div className="changes-body" ref={setBox}>
      <Caption text={caption} />
      {wide ? <SplitToggle split={split} onToggle={() => setSplit((value) => !value)} /> : null}
      <ul className="change-files">
        {files.map((file) => (
          <ChangeFile key={file.name} file={file} review={review} style={style} mode={mode} />
        ))}
      </ul>
      <ReviewFooter review={review} />
    </div>
  );
}

function Caption({ text }: { text: string | null }) {
  return text ? <p className="changes-caption">{text}</p> : null;
}

function SplitToggle({ split, onToggle }: { split: boolean; onToggle: () => void }) {
  return (
    <div className="changes-tools">
      <button type="button" className="pill" aria-pressed={split} onClick={onToggle}>
        {split ? "Unified" : "Split"}
      </button>
    </div>
  );
}

type FileProps = { file: FileDiffMetadata; review: Review; style: "split" | "unified"; mode: "light" | "dark" };

function ChangeFile({ file, review, style, mode }: FileProps) {
  const [shown, setShown] = useState(false);
  const count = review.comments.filter((comment) => comment.file === file.name).length;

  return (
    <li className="change-file">
      <button type="button" className="change-file-row" aria-expanded={shown} onClick={() => setShown((value) => !value)}>
        <Icon name="chevronRight" size={12} className="chevron" />
        <span className="change-file-name" title={file.name}>
          {fileLabel(file)}
        </span>
        <NoteCount count={count} />
        <Counts {...countsOf([file])} />
      </button>
      {shown ? <ChangeDiff file={file} review={review} style={style} mode={mode} /> : null}
    </li>
  );
}

function NoteCount({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <span className="change-file-notes" aria-label={`${count} comments`}>
      <Icon name="chat" size={12} />
      {count}
    </span>
  );
}

/** Where a note sits in the diff. */
function annotationOf(note: Note): DiffLineAnnotation<Note> {
  if ("draft" in note) return { side: note.draft.side, lineNumber: note.draft.line, metadata: note };

  return { side: note.comment.side, lineNumber: note.comment.line, metadata: note };
}

function ChangeDiff({ file, review, style, mode }: FileProps) {
  const annotations = notesOn(file.name, review.comments, review.draft).map(annotationOf);

  return (
    <FileDiff<Note>
      className="change-diff"
      fileDiff={file}
      options={{
        diffStyle: style,
        overflow: "wrap",
        disableFileHeader: true,
        themeType: mode,
        lineHoverHighlight: "both",
        onLineClick: ({ lineNumber, annotationSide, lineElement }) =>
          review.pick({ file: file.name, line: lineNumber, side: annotationSide, code: lineElement.textContent ?? "" })
      }}
      lineAnnotations={annotations}
      renderAnnotation={({ metadata }) => <Annotation note={metadata} review={review} />}
    />
  );
}

function Annotation({ note, review }: { note: Note; review: Review }) {
  if ("draft" in note) return <CommentForm onCancel={review.cancel} onSave={review.save} />;

  return (
    <div className="change-comment">
      <p>{note.comment.text}</p>
      <button type="button" className="icon-button" aria-label="Delete comment" onClick={() => review.remove(note.index)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

function ReviewFooter({ review }: { review: Review }) {
  if (review.comments.length > 0) {
    return (
      <div className="changes-send">
        <span>{plural(review.comments.length, "comment")} for this task</span>
        <button type="button" className="pill" onClick={review.submit}>
          <Icon name="send" size={13} />
          Send to task
        </button>
      </div>
    );
  }

  return review.sent ? (
    <p className="changes-caption" role="status">
      Sent to the task.
    </p>
  ) : (
    <p className="changes-caption">Tap a line to comment on it.</p>
  );
}

function CommentForm({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");

  return (
    <form
      className="change-comment-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (text.trim()) onSave(text.trim());
      }}
    >
      <textarea
        aria-label="Comment on this line"
        placeholder="What should change here?"
        rows={2}
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="change-comment-actions">
        <button type="button" className="pill" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pill" disabled={!text.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}
