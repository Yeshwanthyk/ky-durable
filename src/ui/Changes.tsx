import { type DiffLineAnnotation, type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { FilesContext } from "./Attachments";
import { countsOf, feedbackMessage, latestDiff, type LineComment } from "./review";
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

function usePatch(id: string | undefined): FileDiffMetadata[] | "failed" | null {
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
    if (text === null || text === "failed") return text;

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

type Draft = Omit<LineComment, "text">;

type Note = { comment: LineComment; index: number } | { draft: Draft };

export function Changes({ task }: { task: string }) {
  const diff = latestDiff(useContext(FilesContext), task);
  const send = useContext(SendTaskContext);
  const files = usePatch(diff?.id);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [comments, setComments] = useState<readonly LineComment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [split, setSplit] = useState(false);
  const [sent, setSent] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const wide = useWide(box);
  const mode = useMode();

  if (!diff || files === null) return null;

  if (files === "failed" || files.length === 0) return null;
  const total = countsOf(files);

  const toggle = (name: string) =>
    setExpanded((current) => {
      const next = new Set(current);

      if (!next.delete(name)) next.add(name);

      return next;
    });

  const submit = () => {
    send(task, feedbackMessage(comments));
    setComments([]);
    setDraft(null);
    setSent(true);
  };

  return (
    <div className="tool changes" ref={setBox}>
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="branch" size={14} />
        <span className="verb">Changes</span>
        <span className="target">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span className="trail">
          <Counts {...total} />
          <Icon name="chevronRight" size={12} className="chevron" />
        </span>
      </button>
      {open ? (
        <div className="changes-body">
          {diff.caption ? <p className="changes-caption">{diff.caption}</p> : null}
          {wide ? (
            <div className="changes-tools">
              <button type="button" className="pill" aria-pressed={split} onClick={() => setSplit((value) => !value)}>
                {split ? "Unified" : "Split"}
              </button>
            </div>
          ) : null}
          <ul className="change-files">
            {files.map((file) => {
              const shown = expanded.has(file.name);
              const notes = comments.filter((comment) => comment.file === file.name);

              const annotations: DiffLineAnnotation<Note>[] = comments.flatMap((comment, index) =>
                comment.file === file.name
                  ? [{ side: comment.side, lineNumber: comment.line, metadata: { comment, index } }]
                  : []
              );

              if (draft?.file === file.name) annotations.push({ side: draft.side, lineNumber: draft.line, metadata: { draft } });

              return (
                <li key={file.name} className="change-file">
                  <button type="button" className="change-file-row" aria-expanded={shown} onClick={() => toggle(file.name)}>
                    <Icon name="chevronRight" size={12} className="chevron" />
                    <span className="change-file-name" title={file.name}>
                      {file.prevName && file.prevName !== file.name ? `${file.prevName} → ` : ""}
                      {file.name}
                    </span>
                    {notes.length > 0 ? (
                      <span className="change-file-notes" aria-label={`${notes.length} comments`}>
                        <Icon name="chat" size={12} />
                        {notes.length}
                      </span>
                    ) : null}
                    <Counts {...countsOf([file])} />
                  </button>
                  {shown ? (
                    <FileDiff<Note>
                      className="change-diff"
                      fileDiff={file}
                      options={{
                        diffStyle: wide && split ? "split" : "unified",
                        overflow: "wrap",
                        disableFileHeader: true,
                        themeType: mode,
                        lineHoverHighlight: "both",
                        onLineClick: ({ lineNumber, annotationSide, lineElement }) => {
                          setSent(false);
                          setDraft({ file: file.name, line: lineNumber, side: annotationSide, code: lineElement.textContent ?? "" });
                        }
                      }}
                      lineAnnotations={annotations}
                      renderAnnotation={({ metadata }) =>
                        "draft" in metadata ? (
                          <CommentForm
                            onCancel={() => setDraft(null)}
                            onSave={(text) => {
                              setComments((current) => [...current, { ...metadata.draft, text }]);
                              setDraft(null);
                            }}
                          />
                        ) : (
                          <div className="change-comment">
                            <p>{metadata.comment.text}</p>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Delete comment"
                              onClick={() => setComments((current) => current.filter((_, at) => at !== metadata.index))}
                            >
                              <Icon name="x" size={12} />
                            </button>
                          </div>
                        )
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {comments.length > 0 ? (
            <div className="changes-send">
              <span>
                {comments.length} {comments.length === 1 ? "comment" : "comments"} for this task
              </span>
              <button type="button" className="pill" onClick={submit}>
                <Icon name="send" size={13} />
                Send to task
              </button>
            </div>
          ) : sent ? (
            <p className="changes-caption" role="status">
              Sent to the task.
            </p>
          ) : (
            <p className="changes-caption">Tap a line to comment on it.</p>
          )}
        </div>
      ) : null}
    </div>
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
