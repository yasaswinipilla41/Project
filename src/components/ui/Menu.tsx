"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Accessible dropdown menu (§42).
 *
 * - trigger exposes `aria-haspopup` / `aria-expanded` / `aria-controls`
 * - Escape closes and returns focus to the trigger
 * - Arrow keys / Home / End move between items, Enter and Space activate
 * - clicking outside or tabbing away closes
 *
 * Positioning is CSS-driven relative to the wrapper so no measuring library is
 * needed for the alignments Prio uses.
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
}

export function Menu({
  trigger,
  children,
  align = "start",
  offset = 6,
  width,
  label,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  // Focus the first item when the menu opens by keyboard or click.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]),[role="menuitemradio"]:not([aria-disabled="true"])',
    );
    first?.focus();
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

      {open ? (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="prio-menu prio-scroll"
          onKeyDown={onMenuKeyDown}
          onClick={(event) => {
            // Any activated item closes the menu unless it opts out.
            const target = event.target as HTMLElement;
            if (target.closest("[data-menu-keep-open]")) return;
            if (target.closest('[role="menuitem"],[role="menuitemradio"]')) close(false);
          }}
          style={{
            top: `calc(100% + ${offset}px)`,
            ...(align === "end" ? { right: 0 } : { left: 0 }),
            ...(width ? { width, minWidth: 0 } : null),
          }}
        >
          {children}
        </div>
      ) : null}
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

  const content = (
    <>
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {trailing}
    </>
  );

  // `menuitem` does not support a selected state; a choice within a menu is a
  // `menuitemradio` carrying aria-checked.
  const role = selected === undefined ? "menuitem" : "menuitemradio";
  const checked = selected === undefined ? undefined : selected;

  if (href && !disabled) {
    return (
      <a
        role={role}
        aria-checked={checked}
        href={href}
        className={className}
        data-menu-keep-open={keepOpen || undefined}
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
      tabIndex={-1}
    >
      {content}
    </button>
  );
}
