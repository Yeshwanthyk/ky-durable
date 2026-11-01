import { type ReactNode, useState } from "react";

/**
 * A body that opens in place: its grid row grows from 0fr to 1fr, so what is below glides down rather than jumping. It
 * mounts on the first open and stays, so closing animates too; while closed it is inert, so it takes no clicks or focus
 * and screen readers skip it.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);

  if (open && !opened) setOpened(true);

  return (
    <div className="reveal" data-open={open} inert={!open}>
      <div className="reveal-inner">{opened ? children : null}</div>
    </div>
  );
}
