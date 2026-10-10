import { lazy, Suspense, useContext, useEffect, useState } from "react";
import { FilesContext } from "./Attachments";
import { Counts, plural, useReview } from "./change-review";
import { latestDiff, patchSummary } from "./review";
import { Icon } from "./Icon";

// A machine task's code changes, from the newest patch its `ky diff` shared:
// a collapsed row with the totals, then a file list, then each file's diff.
// Tapping a line leaves a comment; the comments go to the task as one message.
// The row reads its totals from the patch text; the diff library, and the
// Shiki it brings, load only when the row is opened.

const ChangesBody = lazy(() => import("./ChangesBody"));

const patches = new Map<string, Promise<string>>();

/** A patch's text, fetched once per page: its id never names other bytes. */
function patchText(id: string): Promise<string> {
  let text = patches.get(id);

  if (!text) {
    text = fetch(`/files/${id}`).then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))));
    patches.set(id, text);
  }

  return text;
}

/** The patch's text; null while it loads, or if it could not be read. */
function usePatch(id: string | undefined): string | null {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setText(null);
    patchText(id).then(
      (value) => live && setText(value),
      () => live && setText(null)
    );

    return () => {
      live = false;
    };
  }, [id]);

  return text;
}

export function Changes({ task }: { task: string }) {
  const diff = latestDiff(useContext(FilesContext), task);
  const patch = usePatch(diff?.id);

  if (!diff || patch === null) return null;

  return <ChangeSet task={task} id={diff.id} caption={diff.caption} patch={patch} />;
}

type ChangeSetProps = { task: string; id: string; caption: string | null; patch: string };

function ChangeSet({ task, id, caption, patch }: ChangeSetProps) {
  const [open, setOpen] = useState(false);
  const review = useReview(task);
  const summary = patchSummary(patch);

  if (summary.files === 0) return null;

  return (
    <div className="tool changes">
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="branch" size={14} />
        <span className="verb">Changes</span>
        <span className="target">{plural(summary.files, "file")}</span>
        <span className="trail">
          <Counts {...summary} />
          <Icon name="chevronRight" size={12} className="chevron" />
        </span>
      </button>
      {open ? (
        <Suspense fallback={null}>
          <ChangesBody id={id} caption={caption} patch={patch} review={review} />
        </Suspense>
      ) : null}
    </div>
  );
}
