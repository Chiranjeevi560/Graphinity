import { useEffect, useId, useRef, type ReactNode } from 'react';
import { SquircleLayers } from './Squircle.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** The buttons, most important last (Apple puts the action on the right). */
  actions: ReactNode;
}

/**
 * A modal built on the native <dialog>: the browser traps focus inside it,
 * closes it with Escape, and hides the page behind it from screen readers.
 */
export function Dialog({ open, onClose, title, children, actions }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Each dialog its own id: a page can hold several (one per answer).
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={e => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-panel sq-host">
        <SquircleLayers radius={1.25} />
        <h2 id={titleId} className="text-title3">
          {title}
        </h2>
        <div className="dialog-body text-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </dialog>
  );
}
