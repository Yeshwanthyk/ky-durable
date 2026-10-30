import { createContext, type FormEvent, useContext, useState } from "react";
import { VERDICT_REASON_CHARS } from "../dreaming/contract";
import type { PostVerdict as Verdict, VerdictView } from "../protocol";
import { RowValue } from "./Controls";
import { Icon } from "./Icon";

type VerdictActions = {
  /** The last 30 days' verdicts, by post. */
  readonly verdicts: Readonly<Record<string, VerdictView>>;
  /** Of the last 30 days' verdicts, how many were 👍; null until ky says. */
  readonly rate: { readonly useful: number; readonly judged: number } | null;
  /** Keep the user's verdict on a post; resolves with why not, if it wasn't kept. */
  readonly onJudge: (item: string, verdict: Verdict, reason?: string) => Promise<string | undefined>;
};

/** The user's verdicts on ky's unasked posts, and how to give one; provided around the thread. */
export const VerdictContext = createContext<VerdictActions>({
  verdicts: {},
  rate: null,
  onJudge: () => Promise.resolve("Not connected.")
});

/** How many of ky's unasked posts helped, of those the user judged in the last 30 days: a row for Settings › Proactivity. */
export function UsefulRate() {
  const { rate } = useContext(VerdictContext);

  if (rate === null) return null;

  return (
    <div className="card">
      <div className="row">
        <span className="row-text">
          <span className="row-label">Useful</span>
          <span className="row-sub">Of the posts you rated in the last 30 days</span>
        </span>
        <RowValue>{rate.judged === 0 ? "None rated yet" : `${Math.round((rate.useful / rate.judged) * 100)}% · ${rate.useful} of ${rate.judged}`}</RowValue>
      </div>
    </div>
  );
}

/** 👍 or 👎 under one of ky's unasked posts; a 👎 asks why, in a line the user may leave blank. */
export function PostVerdict({ item }: { readonly item: string }) {
  const { verdicts, onJudge } = useContext(VerdictContext);
  const kept = verdicts[item];
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const judge = (verdict: Verdict, why?: string) => {
    setProblem(null);
    void onJudge(item, verdict, why).then((refused) => setProblem(refused ?? null));
  };

  const down = () => {
    judge("not-useful");
    setAsking(true);
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    setAsking(false);

    if (reason.trim() !== "") judge("not-useful", reason.trim());
  };

  return (
    <span className="post-verdict" data-judged={kept?.verdict}>
      <button type="button" className="icon-button pressable" aria-label="Useful" aria-pressed={kept?.verdict === "useful"} onClick={() => judge("useful")}>
        <Icon name="thumbUp" size={14} />
      </button>
      <button type="button" className="icon-button pressable" aria-label="Not useful" aria-pressed={kept?.verdict === "not-useful"} onClick={down}>
        <Icon name="thumbDown" size={14} />
      </button>
      {asking ? (
        <form className="post-verdict-why" onSubmit={send}>
          <input
            aria-label="Why not useful"
            placeholder="Why? (optional)"
            maxLength={VERDICT_REASON_CHARS}
            value={reason}
            autoFocus
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAsking(false);
            }}
          />
          <button type="submit" className="chip-confirm pressable">
            {reason.trim() === "" ? "Skip" : "Send"}
          </button>
        </form>
      ) : kept?.reason ? (
        <span className="quiet post-verdict-reason">{kept.reason}</span>
      ) : null}
      {problem === null ? null : <span className="post-verdict-problem">{problem}</span>}
    </span>
  );
}
