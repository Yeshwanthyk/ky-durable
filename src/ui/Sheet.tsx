import { type ReactNode, type RefObject, useEffect } from "react";
import { Icon } from "./Icon";

// A sheet over the page: a close button, a title, optional tools, and a scrolling body. `dialog` lets the caller close it.
export function Sheet({
  dialog,
  label,
  className = "",
  onClose,
  tools,
  children,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  label: string;
  className?: string;
  onClose: () => void;
  tools?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    dialog.current?.showModal();
  }, [dialog]);

  return (
    <dialog
      ref={dialog}
      className={`soul-sheet ${className}`.trim()}
      aria-label={label}
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not on its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <header className="soul-sheet-head">
        <button type="button" className="soul-round pressable" aria-label="Close" onClick={() => dialog.current?.close()}>
          <Icon name="chevronDown" size={18} />
        </button>
        <h2 className="soul-sheet-title">{label}</h2>
        {tools}
      </header>
      <div className="soul-sheet-body" data-scroll>
        {children}
      </div>
    </dialog>
  );
}
