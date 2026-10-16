import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { DreamLedgerRow } from "../protocol";
import { Icon, type IconName } from "./Icon";
import { day } from "./time";

type LedgerActions = {
  /** Whether the socket is open: the list reads when it opens, and again on each reconnect. */
  readonly open: boolean;
  /** The latest dream's changes, oldest first. */
  readonly onView: () => Promise<readonly DreamLedgerRow[]>;
  /** Put one back; rejects with the server's reason when it can't, as when the skill changed since. */
  readonly onUndo: (entry: number) => Promise<string>;
};

/** What Activity › Last night reads and does; provided around the panel. */
export const LedgerContext = createContext<LedgerActions>({
  open: false,
  onView: () => Promise.reject(new Error("Not connected.")),
  onUndo: () => Promise.reject(new Error("Not connected."))
});

/** A change in words, its glyph, and the line under it: the dream's reason, or what a forget dropped. */
type Described = { readonly title: string; readonly icon: IconName; readonly sub: string | null };

const verbs = {
  create: ["Made", "plus"],
  edit: ["Rewrote", "pencil"],
  patch: ["Edited", "pencil"],
  archive: ["Archived", "archive"],
  restore: ["Restored", "unarchive"],
  revert: ["Reverted", "refresh"]
} as const satisfies Record<string, readonly [string, IconName]>;

const isVerb = (action: string): action is keyof typeof verbs => Object.hasOwn(verbs, action);

// A forget keeps the summary it dropped as its before.
const forgot = ({ before, reason }: DreamLedgerRow): Described => ({
  title: "Forgot a memory summary",
  icon: "thought",
  sub: before === null ? reason : `“${before}”`
});

function describe(row: DreamLedgerRow): Described {
  const { kind, action, target, absorbed_into, reason } = row;

  if (kind === "memory") return forgot(row);

  if (absorbed_into !== null) return { title: `Merged ${target} into ${absorbed_into}`, icon: "compress", sub: reason };

  const [verb, icon]: readonly [string, IconName] = isVerb(action) ? verbs[action] : [action, "list"];

  return { title: `${verb} ${target}`, icon, sub: reason };
}

const recent = new Set(["Today", "Yesterday"]);

/** "Last night" while the dream was this morning or yesterday; an older one says its day. */
function heading(rows: readonly DreamLedgerRow[], now: number): string {
  const when = day(rows.at(-1)?.at ?? now, now);

  return recent.has(when) ? "Last night" : `Last dream · ${when}`;
}

// What the latest dream changed, each with its reason and an undo; an undone change says so, and a refused undo says why.
export function LastNight({ now }: { now: number }) {
  const actions = useContext(LedgerContext);
  const [rows, setRows] = useState<readonly DreamLedgerRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [refusals, setRefusals] = useState<Readonly<Record<number, string | undefined>>>({});
  const load = useCallback(() => actions.onView().then(setRows, () => undefined), [actions]);

  useEffect(() => {
    if (actions.open) void load();
  }, [actions.open, load]);

  if (rows.length === 0) return null;

  const undo = (entry: number) => {
    setBusy(entry);
    setRefusals((current) => ({ ...current, [entry]: undefined }));
    void actions
      .onUndo(entry)
      .catch((error: Error) => setRefusals((current) => ({ ...current, [entry]: error.message })))
      .then(load)
      .finally(() => setBusy(null));
  };

  return (
    <section className="feed-group last-night" aria-label="Last night">
      <h3 className="feed-head">{heading(rows, now)}</h3>
      <ul className="feed">
        {rows.map((row) => (
          <LedgerChange key={row.id} row={row} busy={busy === row.id} refusal={refusals[row.id]} onUndo={() => undo(row.id)} />
        ))}
      </ul>
    </section>
  );
}

// One change: what it did, why, why an undo was refused, and Undo, or Undone once it is.
function LedgerChange({ row, busy, refusal, onUndo }: { row: DreamLedgerRow; busy: boolean; refusal: string | undefined; onUndo: () => void }) {
  const { title, icon, sub } = describe(row);
  const undone = row.undone_at !== null;

  return (
    <li className="feed-item ledger-change" aria-label={title} data-undone={undone || undefined}>
      <span className="feed-button">
        <span className="feed-glyph">
          <Icon name={icon} size={16} />
        </span>
        <span className="feed-text">
          <span className="feed-title">{title}</span>
          {sub === null ? null : <span className="ledger-reason">{sub}</span>}
          {refusal === undefined ? null : (
            <span className="ledger-refusal" role="status">
              {refusal}
            </span>
          )}
        </span>
        <UndoControl title={title} undone={undone} busy={busy} onUndo={onUndo} />
      </span>
    </li>
  );
}

function UndoControl({ title, undone, busy, onUndo }: { title: string; undone: boolean; busy: boolean; onUndo: () => void }) {
  if (undone) return <span className="ledger-undone">Undone</span>;

  return (
    <button type="button" className="automation-text pressable" aria-label={`Undo: ${title}`} disabled={busy} onClick={onUndo}>
      Undo
    </button>
  );
}
