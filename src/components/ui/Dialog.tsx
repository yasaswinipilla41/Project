"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IconClose } from "@/components/ui/Icon";

/**
 * Accessible modal dialog (§42).
 *
 * - `role="dialog"` + `aria-modal` + labelled by its title
 * - focus moves in on open and returns to the opener on close
 * - Tab is trapped inside; Escape closes
 * - background scroll is locked while open
 */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Prevents closing by backdrop click / Escape — used while submitting. */
  busy?: boolean;
  description?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  busy = false,
  description,
}: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  /*
   * Remember who opened the dialog and return focus there when it goes away.
   *
   * The restoration lives in the effect *cleanup* rather than an `open === false`
   * branch: callers mount this component only while it is open, so a closing
   * dialog unmounts and a "now closed" render never happens. Restoring on
   * cleanup covers both closing and unmounting, so a keyboard user always lands
   * back on the control they came from.
   */
  useEffect(() => {
    if (!open) return;

    openerRef.current = document.activeElement as HTMLElement | null;

    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      // Deferred a frame: React is still tearing the dialog down, and focusing
      // during that teardown is discarded.
      requestAnimationFrame(() => opener?.focus?.());
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        requestClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((el) => el.offsetParent !== null);

      if (focusable.length === 0) return;

      const firstEl = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
    };
  }, [open, requestClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="prio-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={`prio-dialog${size !== "md" ? ` prio-dialog--${size}` : ""}`}
        tabIndex={-1}
      >
        <div className="prio-dialog__header">
          <h2 id={titleId} className="prio-dialog__title">
            {title}
          </h2>
          <button
            type="button"
            className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
            onClick={requestClose}
            aria-label="Close dialog"
            disabled={busy}
          >
            <IconClose />
          </button>
        </div>

        {description ? (
          <p id={descId} className="prio-visually-hidden">
            {description}
          </p>
        ) : null}

        <div className="prio-dialog__body prio-scroll">{children}</div>

        {footer ? <div className="prio-dialog__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
