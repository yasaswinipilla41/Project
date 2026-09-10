"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface SearchOption {
  id: string;
  /** What is matched against, and what the chip and the row show. */
  label: string;
  /** Second line in the list — a designation, a project key, an assignee. */
  meta?: string;
  /**
   * Matched against, but never shown.
   *
   * For when the thing people search by is not the thing worth displaying. A
   * person's row shows their designation, and colleagues look each other up by
   * email — so the email lives here and the field keeps finding them by it
   * without putting an address on every row.
   */
  keywords?: string;
  /** Rendered before the label in the list, e.g. an avatar. */
  adornment?: ReactNode;
}

/**
 * A field that is typed into and picked from — one value or many.
 *
 * Administration's assignment dialogs used a plain `<select>` for the project
 * and a scrolling wall of buttons for people and issues, which is fine at five
 * of anything and unusable at two hundred. This is the same combobox pattern
 * `LabelPicker` already established on the Create dialog: type to narrow, arrow
 * and Enter to choose, Escape to close. It reuses that control's classes
 * (`prio-labelpicker*`, `prio-chipset*`) rather than introducing a second look
 * for the same interaction, so nothing about the dialogs' design changes.
 *
 * What is chosen sits above the input as chips. In `multiple` mode they are
 * removable and the input stays open for the next search, which is what
 * "continue searching after selection" needs; in single mode picking replaces
 * the choice.
 *
 * The option list is rendered into `document.body` and positioned against the
 * field, rather than laid out inside it. Absolutely positioned, it was clipped
 * the moment the field sat low in a dialog: `.prio-dialog` hides its overflow
 * and `.prio-dialog__body` scrolls, so a list opening downwards was cut off at
 * the panel's edge and the last options could not be read or reached. Escaping
 * to the body is the same answer `Menu` already uses for the same reason, and
 * it brings the rest of that behaviour with it — the list flips above the
 * field when there is more room there, is capped to the space actually
 * available so it scrolls rather than running off the screen, and follows the
 * field when any ancestor scrolls.
 *
 * This is presentation. Every dialog that uses it posts ids to a server action
 * that re-checks who is asking and what they named — nothing here is a
 * permission.
 */
export function SearchSelect({
  id,
  options,
  selected,
  onChange,
  multiple = false,
  placeholder,
  ariaLabel,
  disabled = false,
  emptyHint,
}: {
  id: string;
  options: SearchOption[];
  /** Chosen ids. Single mode uses the first, if any. */
  selected: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  /** Shown in place of the list when there is nothing to offer at all. */
  emptyHint?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const byId = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const chosen = selected
    .map((value) => byId.get(value))
    .filter((option): option is SearchOption => Boolean(option));

  const folded = query.trim().toLowerCase();

  const matches = useMemo(() => {
    /* One choice: everything stays on the list, because picking a different
       one is how the choice is changed and an option that vanishes when it is
       current makes the list a different length each time it opens. Many
       choices: what is already chosen is a chip above, and offering it again
       would do nothing. */
    const available = multiple
      ? options.filter((option) => !selected.includes(option.id))
      : options;
    const narrowed = folded
      ? available.filter(
          (option) =>
            option.label.toLowerCase().includes(folded) ||
            (option.meta ?? "").toLowerCase().includes(folded) ||
            (option.keywords ?? "").toLowerCase().includes(folded),
        )
      : available;
    /* Capped so a project with a thousand issues does not render a thousand
       rows into a dialog. Typing narrows against the whole list, not against
       the slice — the cap is on what is drawn, never on what is searched. */
    return open ? narrowed.slice(0, 8) : [];
  }, [options, selected, folded, open, multiple]);

  /*
   * Put the list where the field is.
   *
   * Imperative and re-run on every scroll frame, like `Menu`: moving a panel
   * a few pixels is not worth a render. `fixed` coordinates are
   * viewport-relative, so anything scrolling underneath — the dialog body
   * included — has to move it again, which is what the capturing scroll
   * listener below is for.
   */
  const place = useCallback(() => {
    const field = anchor.current;
    const panel = list.current;
    if (!field || !panel) return;

    const rect = field.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;

    /* Flip up only when below genuinely cannot hold the list and above is
       roomier — otherwise a list that merely got short would jump sides. */
    const natural = panel.scrollHeight;
    const flip = natural > below && above > below;
    const maxHeight = Math.min(220, Math.max(120, flip ? above : below));

    panel.style.width = `${rect.width}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.top = flip
      ? `${Math.max(margin, rect.top - gap - Math.min(natural, maxHeight))}px`
      : `${rect.bottom + gap}px`;
    panel.style.visibility = "visible";
  }, []);

  /*
   * Re-measured after every render, deliberately without a dependency list.
   *
   * Choosing an option in `multiple` mode adds a chip above the field, which
   * pushes the field down — and the list has to come with it. Keying this on
   * `matches.length` was not enough: the list draws at most eight rows, so
   * with nine or more candidates the count does not change when one is taken,
   * the effect did not re-run, and the list stayed where the field used to be.
   * It then covered the field it belongs to and swallowed the next click.
   *
   * Two `getBoundingClientRect` calls per render is nothing next to getting
   * this wrong, and there is no other reliable signal: anything inside the
   * dialog can move the field.
   */
  useLayoutEffect(() => {
    if (matches.length > 0) place();
  });

  useLayoutEffect(() => {
    if (matches.length === 0) return;

    /* `true` captures scrolls on any ancestor, not only the page: the field
       usually sits inside a dialog body with a scrollport of its own. */
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [matches.length, place]);

  function choose(index: number) {
    const option = matches[index];
    if (!option) return;
    onChange(multiple ? [...selected, option.id] : [option.id]);
    setQuery("");
    setHighlight(0);
    if (!multiple) setOpen(false);
    input.current?.focus();
  }

  function remove(optionId: string) {
    onChange(selected.filter((value) => value !== optionId));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      setOpen(false);
      return;
    }
    /* Backspace on an empty field takes the last chip off, which is how every
       token field behaves and saves reaching for the mouse mid-typing. */
    if (event.key === "Backspace" && query === "" && selected.length > 0) {
      event.preventDefault();
      onChange(selected.slice(0, -1));
      return;
    }
    if (matches.length === 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((i) => (i + 1) % matches.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((i) => (i - 1 + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter") {
      // Enter belongs to the picker, not to the dialog's submit button.
      event.preventDefault();
      choose(Math.min(highlight, matches.length - 1));
    }
  }

  const listId = `${id}-options`;
  const active = matches.length === 0 ? -1 : Math.min(highlight, matches.length - 1);

  return (
    <>
      {chosen.length > 0 ? (
        <div className="prio-chipset" style={{ marginBottom: "var(--prio-space-2)" }}>
          {chosen.map((option) => (
            <span
              key={option.id}
              className="prio-chipset__chip"
              data-selected="true"
            >
              {option.label}
              <button
                type="button"
                className="prio-chipset__remove"
                aria-label={`Remove ${option.label}`}
                title={`Remove ${option.label}`}
                disabled={disabled}
                onClick={() => remove(option.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="prio-labelpicker" ref={anchor}>
        <input
          ref={input}
          id={id}
          className="prio-input"
          type="text"
          role="combobox"
          value={query}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          aria-controls={matches.length > 0 ? listId : undefined}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          disabled={disabled}
          /* While the list is open, Escape belongs to the list. Without this
             the key bubbles to the dialog's own handler and shuts the whole
             popup when the person only meant to dismiss the options. The
             attribute is the hook `Dialog` already offers for exactly this. */
          data-local-escape={matches.length > 0 ? "true" : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onMouseDown={() => setOpen(true)}
          onBlur={() => {
            // Let a click on an option land before the list disappears.
            window.setTimeout(() => {
              setQuery("");
              setOpen(false);
            }, 150);
          }}
        />

        {matches.length > 0 && typeof document !== "undefined"
          ? createPortal(
          <ul
            ref={list}
            className="prio-labelpicker__list prio-scroll"
            role="listbox"
            id={listId}
            /* Hidden until `place()` has measured it: laid out at its natural
               height first so the measurement is real, then revealed at the
               coordinates that measurement produced. */
            style={{ position: "fixed", top: 0, left: 0, visibility: "hidden" }}
          >
            {matches.map((option, index) => (
              <li key={option.id}>
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="prio-labelpicker__option"
                  data-active={index === active || undefined}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  {option.adornment}
                  <span className="prio-searchselect__text">
                    <span>{option.label}</span>
                    {option.meta ? (
                      <span className="prio-memberpicker__meta">{option.meta}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
            )
          : null}
      </div>

      {options.length === 0 && emptyHint ? (
        <p className="prio-text-muted" style={{ marginTop: "var(--prio-space-2)" }}>
          {emptyHint}
        </p>
      ) : null}
    </>
  );
}
