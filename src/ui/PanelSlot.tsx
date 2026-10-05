import type { ReactNode } from "react";
import type { PanelState } from "./use-panel";

const genieDirection = (panel: PanelState) => (panel.closing ? "out" : "in");

// Where the panel sits, and the genie that pours it out of the agent pill and back.
export function PanelSlot({ panel, children }: { panel: PanelState; children: ReactNode }) {
  if (!panel.open) return null;

  return (
    <div
      ref={panel.panelRef}
      className="panel-slot"
      data-genie={panel.genie ? genieDirection(panel) : undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) panel.settle();
      }}
    >
      {children}
    </div>
  );
}
