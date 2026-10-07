import { createContext, useContext, useState } from "react";
import { type Draft, feedbackMessage, type LineComment } from "./review";

// What the Changes row and its lazily loaded body share: the review of one
// task's changes, and how a change's size is shown.

export const SendTaskContext = createContext<(task: string, message: string) => void>(() => {});

export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="change-counts tabular">
      <span className="added">+{additions}</span>
      <span className="removed">−{deletions}</span>
    </span>
  );
}

/** The user's line comments on one task's changes, and sending them to the task. */
export function useReview(task: string) {
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

export type Review = ReturnType<typeof useReview>;

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
