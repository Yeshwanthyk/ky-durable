import type { ReactNode } from "react";

/** Where a piece of work stands. "needs" is what waits on the user, the only one drawn in amber. */
export type GlyphStatus = "working" | "needs" | "done" | "failed" | "open";

const NAMES: Record<GlyphStatus, string> = { working: "Working", needs: "Needs you", done: "Done", failed: "Failed", open: "Open" };

// Each status has its own shape, so it reads without its colour: an open ring, a diamond, a checked disc, a crossed
// square, an empty circle.
const MARKS: Record<GlyphStatus, ReactNode> = {
  working: <path className="kit-glyph-line" d="M7 1.75a5.25 5.25 0 1 1-5.25 5.25" />,
  needs: <path d="M7 1.25 12.75 7 7 12.75 1.25 7z" />,
  done: (
    <>
      <circle cx="7" cy="7" r="6" />
      <path className="kit-glyph-cut" d="M4.25 7.25 6.1 9l3.65-3.75" />
    </>
  ),
  failed: (
    <>
      <rect x="1.25" y="1.25" width="11.5" height="11.5" rx="2.5" />
      <path className="kit-glyph-cut" d="m5 5 4 4m0-4-4 4" />
    </>
  ),
  open: <circle className="kit-glyph-line" cx="7" cy="7" r="5.25" />
};

/** A 14px glyph for a status, in its status colour, named for screen readers. */
export function StatusGlyph({ status, label }: { status: GlyphStatus; label?: string }) {
  return (
    <svg className="kit-glyph" data-status={status} role="img" aria-label={label ?? NAMES[status]} width="14" height="14" viewBox="0 0 14 14">
      {MARKS[status]}
    </svg>
  );
}
