"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  IconClose,
  IconMaximize,
  IconMinimize,
  IconRestoreWindow,
} from "@/components/ui/Icon";

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
  /**
   * Adds Minimise and Maximise beside Close, for a dialog somebody works in
   * for a while rather than answers and dismisses.
   *
   * Both are presentation only. The dialog stays mounted and so does
   * everything in it — a form keeps every value and every staged file — and
   * Close is untouched. Minimised, it folds to its title bar at the bottom of
   * the window and stops being modal, so the rest of Prio can be used; restored,
   * it is modal again. Opt-in, so every other dialog is exactly as it was.
   */
  windowControls?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Every currently-open `Dialog`, most recently opened last. A handful of
 * surfaces open one dialog from inside another (the screenshot editor from
 * inside Create) — without this, pressing Escape would be seen by *both*
 * dialogs' document-level listeners and close the outer one instead of the
 * one the user is actually looking at. Only the top of this stack acts on a
 * given Escape press; every other open dialog defers to it.
 */
const openDialogs: symbol[] = [];

/**
 * Lets a focused descendant (a floating text input, say) handle Escape
 * itself instead of the dialog closing under it — set
 * `data-local-escape="true"` on the element while it wants this.
 */
function activeElementOwnsEscape(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.dataset.localEscape === "true";
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  busy = false,
  description,
  windowControls = false,
}: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dialogIdRef = useRef<symbol | null>(null);
  dialogIdRef.current ??= Symbol("dialog");

  /* Window state. Only ever set when `windowControls` is on, so every other
     dialog renders exactly as before. Minimised wins over maximised, and
     restoring from minimised returns to whichever size it had. */
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const id = dialogIdRef.current!;
    openDialogs.push(id);
    return () => {
      const index = openDialogs.indexOf(id);
      if (index !== -1) openDialogs.splice(index, 1);
    };
  }, [open]);

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

  /*
   * Focus moves in once, when the dialog opens.
   *
   * This used to share an effect with the key handling below, which depends on
   * `requestClose` -- and `requestClose` is rebuilt whenever `onClose` changes
   * identity, which is every render, because every caller passes `onClose` as
   * an inline arrow. So the effect re-ran on each render, and each re-run
   * called `.focus()` on the dialog's first focusable element again.
   *
   * While a dialog merely sits there that is invisible. While somebody is
   * typing into it, it is not: each keystroke re-renders, focus jumps out of
   * the field to the header's close button, and the very next character goes
   * nowhere. Exactly one character could be typed into any input in any dialog
   * in the application.
   *
   * Depending only on `open` is what fixes it -- opening is the event that
   * should move focus, and nothing else is.
   */
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
  }, [open]);

  /* The page lock belongs with the opening too, not with the key handler:
     applied and undone on every keystroke it would flicker the scrollbar.
     A minimised dialog is not modal, so it releases the page. */
  useEffect(() => {
    if (!open || minimized) return;

    /*
     * Lock the page behind the dialog, without moving it.
     *
     * Hiding the body's overflow is what stops the page scrolling underneath.
     * On its own it also takes the page's scrollbar away, and on a platform
     * that reserves space for one -- Windows, most Linux desktops -- the whole
     * layout then jumps sideways by the width of the gutter the instant the
     * dialog opens, and jumps back when it closes. Replacing that width with
     * padding keeps everything exactly where it was.
     *
     * `innerWidth - clientWidth` is the gutter's real width as this browser
     * draws it, which is 0 wherever scrollbars are drawn as an overlay, so
     * nothing is added on the platforms that do not need it.
     */
    const { overflow, paddingRight } = document.body.style;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gutter > 0) {
      const current = Number.parseFloat(
        getComputedStyle(document.body).paddingRight,
      );
      document.body.style.paddingRight = `${(Number.isFinite(current) ? current : 0) + gutter}px`;
    }

    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [open, minimized]);

  useEffect(() => {
    /* Minimised, it neither traps focus nor answers Escape: the rest of Prio
       is in use, and a stray Escape there must not throw the form away. */
    if (!open || minimized) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Not the topmost dialog — whichever is on top handles this Escape.
        if (openDialogs[openDialogs.length - 1] !== dialogIdRef.current) return;
        // A focused descendant wants to handle its own Escape first (e.g. a
        // floating text input cancelling itself) rather than the dialog closing.
        if (activeElementOwnsEscape()) return;
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
    };
  }, [open, minimized, requestClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const panelClass = [
    "prio-dialog",
    size !== "md" ? `prio-dialog--${size}` : "",
    maximized && !minimized ? "prio-dialog--maximized" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div
      className="prio-dialog-backdrop"
      data-minimized={minimized || undefined}
      data-maximized={(maximized && !minimized) || undefined}
      onMouseDown={(event) => {
        if (!minimized && event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={minimized ? "false" : "true"}
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={panelClass}
        data-minimized={minimized || undefined}
        tabIndex={-1}
      >
        <div className="prio-dialog__header">
          <h2 id={titleId} className="prio-dialog__title">
            {title}
          </h2>
          {windowControls ? (
            <>
              <button
                type="button"
                className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
                onClick={() => setMinimized((value) => !value)}
                aria-label={minimized ? "Restore dialog" : "Minimize dialog"}
                title={minimized ? "Restore" : "Minimize"}
              >
                {minimized ? <IconRestoreWindow /> : <IconMinimize />}
              </button>
              <button
                type="button"
                className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
                onClick={() => {
                  setMaximized((value) => !value);
                  setMinimized(false);
                }}
                aria-label={
                  maximized && !minimized ? "Restore dialog size" : "Maximize dialog"
                }
                title={maximized && !minimized ? "Restore size" : "Maximize"}
              >
                {maximized && !minimized ? <IconRestoreWindow /> : <IconMaximize />}
              </button>
            </>
          ) : null}
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

        {/* Hidden rather than unmounted while minimised, so nothing inside —
            typed text, a chosen project, staged files — is lost. */}
        <div className="prio-dialog__body prio-scroll">{children}</div>

        {footer ? <div className="prio-dialog__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
