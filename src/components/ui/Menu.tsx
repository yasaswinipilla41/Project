"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Accessible dropdown menu (§42).
 *
 * - trigger exposes `aria-haspopup` / `aria-expanded` / `aria-controls`
 * - Escape closes and returns focus to the trigger
 * - Arrow keys / Home / End move between items, Enter and Space activate
 * - clicking outside or tabbing away closes
 *
 * The panel is portalled to `document.body` and positioned with `fixed`
 * coordinates measured from the trigger. It used to be an absolutely
 * positioned child, which meant any scroll container between it and the page
 * clipped it — `.prio-table-wrap` sets `overflow-x: auto`, and a computed
 * overflow on one axis forces a scrollport on both, so the People row menu was
 * cut off at the table's edge. A portal is the fix for that; raising
 * `z-index` cannot help, because clipping by an ancestor's overflow happens
 * regardless of stacking order.
 *
 * Coordinates are recomputed on scroll and resize while open, and the panel
 * flips above the trigger when there is not enough room below.
 */

export type MenuAlign = "start" | "end";

export interface MenuProps {
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
  }) => ReactNode;
  children: ReactNode;
  align?: MenuAlign;
  /** Distance from the trigger, in px. */
  offset?: number;
  width?: number | string;
  label?: string;
  className?: string;
  /**
   * Told whenever the panel opens or closes.
   *
   * For a menu whose contents have to be fetched: opening is the moment the
   * request is worth making, and nothing outside can see that moment because
   * the open state is this component's own. Optional, and every existing menu
   * passes nothing and behaves exactly as before.
   */
  onOpenChange?: (open: boolean) => void;
  /** Extra class for the portalled panel itself — `className` sits on the
   *  wrapper around the trigger, which the panel is not inside. */
  panelClassName?: string;
}

export function Menu({
  trigger,
  children,
  align = "start",
  offset = 6,
  width,
  label,
  className,
  onOpenChange,
  panelClassName,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /*
   * Measured and written straight to the node before paint, so the panel never
   * appears in one place and jumps to another. Deliberately imperative rather
   * than React state: this runs on every scroll frame while the menu is open,
   * and re-rendering the whole menu to move it two pixels would be wasteful.
   * `fixed` coordinates are viewport-relative, which is why it has to re-run
   * whenever anything underneath scrolls at all.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const anchor = trigger.getBoundingClientRect();
    const panel = menu.getBoundingClientRect();
    const margin = 8;
    const below = window.innerHeight - anchor.bottom - offset - margin;
    const above = anchor.top - offset - margin;

    // Flip up only when below genuinely cannot hold it and above is roomier.
    const flip = panel.height > below && above > below;
    const maxHeight = Math.max(120, flip ? above : below);
    const top = flip
      ? Math.max(margin, anchor.top - offset - Math.min(panel.height, maxHeight))
      : anchor.bottom + offset;

    const rawLeft =
      align === "end" ? anchor.right - panel.width : anchor.left;
    const left = Math.min(
      Math.max(margin, rawLeft),
      Math.max(margin, window.innerWidth - panel.width - margin),
    );

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.visibility = "visible";
  }, [align, offset]);

  useLayoutEffect(() => {
    if (!open) return;
    place();

    /* `true` captures scrolls on any ancestor, not just the page — the menu
       is anchored to a trigger that may sit inside its own scrollport. */
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);

    /*
     * And when the panel's own contents change size.
     *
     * A menu whose items are fetched opens at the height of its loading row
     * and then grows to the height of the list, and the coordinates measured
     * for the first would place the second wrongly — a panel that had flipped
     * above its trigger would grow back down across it. Re-measuring settles
     * immediately: `place` writes the same coordinates for the same size, so
     * the observer stops firing rather than chasing itself.
     */
    const panel = menuRef.current;
    const observer =
      panel && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => place())
        : null;
    if (panel && observer) observer.observe(panel);

    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  /*
   * Whoever owns the menu's contents, told that they are now on screen.
   *
   * In an effect rather than at each `setOpen`, so every route into and out of
   * the open state — the trigger, Escape, a click outside, Tab, choosing an
   * item — reports itself without having to remember to. Held in a ref so the
   * effect depends on `open` alone: a caller that passes a fresh closure on
   * every render would otherwise be told "still open" on every render too,
   * which for a caller that fetches on open is a request loop.
   */
  const notifyOpen = useRef(onOpenChange);
  useEffect(() => {
    notifyOpen.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => {
    notifyOpen.current?.(open);
  }, [open]);

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  /*
   * Focus the first item when the menu opens by keyboard or click — and again
   * if the items only arrive afterwards.
   *
   * A menu whose rows are fetched has none to focus at the moment it opens, so
   * focus stayed on the trigger and the arrow keys — handled on the panel —
   * never reached anything: the list was on screen and unreachable from the
   * keyboard. The observer covers that, and the guard is what keeps it from
   * being a nuisance anywhere else: once focus is inside the panel, a row
   * being ticked, a list re-filtered or a note replaced moves nothing.
   */
  useEffect(() => {
    if (!open) return;
    const panel = menuRef.current;
    if (!panel) return;

    const focusFirst = () => {
      if (panel.contains(document.activeElement)) return;
      panel
        .querySelector<HTMLElement>(
          '[role="menuitem"]:not([aria-disabled="true"]),[role="menuitemradio"]:not([aria-disabled="true"])',
        )
        ?.focus();
    };

    focusFirst();

    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(focusFirst);
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  function moveFocus(direction: 1 | -1 | "first" | "last") {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"]),[role="menuitemradio"]:not([aria-disabled="true"])',
      ) ?? [],
    );
    if (items.length === 0) return;

    const currentIndex = items.findIndex((el) => el === document.activeElement);
    let nextIndex: number;

    if (direction === "first") nextIndex = 0;
    else if (direction === "last") nextIndex = items.length - 1;
    else {
      nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + direction + items.length) % items.length;
    }

    items[nextIndex]?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus("first");
        break;
      case "End":
        event.preventDefault();
        moveFocus("last");
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function onTriggerKeyDown(event: React.KeyboardEvent) {
    /*
     * Only the arrow keys are handled here.
     *
     * The trigger is a <button>, so Enter and Space already activate it and
     * fire a click — which the onClick handler turns into a toggle. Opening
     * the menu here as well meant the subsequent click closed it again, and
     * the menu could not be opened from the keyboard at all.
     */
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div
      className={className}
      style={{ position: "relative", display: "inline-flex" }}
    >
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((v) => !v),
        onKeyDown: onTriggerKeyDown,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
      })}

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              id={menuId}
              ref={menuRef}
              role="menu"
              aria-label={label}
              className={
                panelClassName
                  ? `prio-menu prio-scroll ${panelClassName}`
                  : "prio-menu prio-scroll"
              }
              onKeyDown={onMenuKeyDown}
              onClick={(event) => {
                // Any activated item closes the menu unless it opts out.
                const target = event.target as HTMLElement;
                if (target.closest("[data-menu-keep-open]")) return;
                if (target.closest('[role="menuitem"],[role="menuitemradio"]'))
                  close(false);
              }}
              /* Hidden until `place()` has measured it — it is laid out at
                 its natural size first so the measurement is real, and only
                 then revealed at the coordinates that measurement produced. */
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                visibility: "hidden",
                ...(width ? { width, minWidth: 0 } : null),
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/* ----------------------------------------------------------------- items */

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="prio-menu__label">{children}</p>;
}

export function MenuSeparator() {
  return <div className="prio-menu__separator" role="separator" />;
}

export function MenuItem({
  children,
  onSelect,
  href,
  danger,
  selected,
  disabled,
  keepOpen,
  icon,
  trailing,
}: {
  children: ReactNode;
  onSelect?: () => void;
  href?: string;
  danger?: boolean;
  selected?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  const className = [
    "prio-menu__item",
    danger ? "prio-menu__item--danger" : null,
  ]
    .filter(Boolean)
    .join(" ");

  /*
   * A row is an icon, a name, and sometimes a note at the end of it — a
   * project's key, a count.
   *
   * The name used to be sized with `flex: 1; min-width: 0` and nothing else,
   * which gives the box the right width but lets the text paint straight out
   * of it: a long project name ran across the key beside it and past the
   * menu's own edge. The stylesheet clips it to its box with an ellipsis now,
   * and keeps the note at its own width, so the two can never meet.
   */
  const content = (
    <>
      {icon}
      <span className="prio-menu__itemlabel">{children}</span>
      {trailing ? (
        <span className="prio-menu__itemtrail">{trailing}</span>
      ) : null}
    </>
  );

  // `menuitem` does not support a selected state; a choice within a menu is a
  // `menuitemradio` carrying aria-checked.
  const role = selected === undefined ? "menuitem" : "menuitemradio";
  const checked = selected === undefined ? undefined : selected;

  /*
   * Escape belongs to the menu while one of its items has focus.
   *
   * A menu opened from inside a dialog is the topmost layer, so Escape should
   * shut the menu and leave the dialog alone. It did the opposite: `Dialog`
   * listens in the capture phase and the menu in the bubble phase, so the
   * dialog always saw the key first and closed — which, from the Add files
   * menu in Create Issue, threw away a half-written issue to dismiss a
   * dropdown.
   *
   * `data-local-escape` is the mechanism `Dialog` already documents for
   * exactly this: a focused descendant saying it wants its own Escape.
   * Opening the menu moves focus to an item, so marking the items is what
   * makes the dialog defer.
   */
  if (href && !disabled) {
    return (
      <a
        role={role}
        aria-checked={checked}
        href={href}
        className={className}
        data-menu-keep-open={keepOpen || undefined}
        data-local-escape="true"
        tabIndex={-1}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      className={className}
      onClick={disabled ? undefined : onSelect}
      aria-disabled={disabled || undefined}
      data-menu-keep-open={keepOpen || undefined}
      data-local-escape="true"
      tabIndex={-1}
    >
      {content}
    </button>
  );
}
