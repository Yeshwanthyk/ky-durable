import { type DiffLineAnnotation, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import { Counts, plural, type Review } from "./change-review";
import { useMode } from "./use-mode";
import { countsOf, fileLabel, type Note, notesOn } from "./review";
import { Icon } from "../chat-kit/Icon";

// The open Changes row: the file list, each file's diff, and line comments.
// `@pierre/diffs` and Shiki live in this chunk, so they load on first open.

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


type BodyProps = { id: string; caption: string | null; patch: string; review: Review };

export default function ChangesBody({ id, caption, patch, review }: BodyProps) {
  const files = useMemo(() => parsePatchFiles(patch, id).flatMap((parsed) => parsed.files), [patch, id]);
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
