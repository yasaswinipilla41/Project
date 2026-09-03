"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/primitives";

export interface PickerLabel {
  id: string;
  name: string;
  color: string;
}

/**
 * Choosing a label from the project's own list, and creating one when none
 * matches.
 *
 * Opening the control shows what the project already has, so picking an
 * existing label is a choice from a list rather than a guess at a name — you
 * cannot select from a vocabulary you cannot see. Typing narrows that list;
 * only when nothing on it answers to what was typed is creating offered. The
 * list scrolls, so a project with a long vocabulary costs the form no height.
 *
 * Matching is case-insensitive and ignores surrounding whitespace, the same
 * rule the server applies when it decides whether a label already exists. That
 * is what stops "QA", "qa" and " Qa " becoming three labels: the interface
 * cannot even offer to create the second one, and if it somehow did, the
 * server would hand back the first.
 */
export function LabelPicker({
  labels,
  selectedIds,
  disabled = false,
  busy = false,
  onSelect,
  onCreate,
}: {
  labels: PickerLabel[];
  selectedIds: string[];
  disabled?: boolean;
  busy?: boolean;
  onSelect: (labelId: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();
  const folded = trimmed.toLowerCase();

  const matches = useMemo(() => {
    const available = labels.filter((label) => !selectedIds.includes(label.id));
    /* Nothing typed: the project's own labels, in full. Already-selected ones
       are left out because picking them again would do nothing — they are
       still on the issue as removable chips above this control. */
    if (folded.length === 0) return open ? available : [];
    return available
      .filter((label) => label.name.toLowerCase().includes(folded))
      .slice(0, 6);
  }, [labels, selectedIds, folded, open]);

  /* Creating is offered only when nothing on the project already answers to
     this name — including a label already picked, which would otherwise look
     missing simply because it is not in `matches`. */
  const exists = labels.some((label) => label.name.toLowerCase() === folded);
  const canCreate = trimmed.length > 0 && !exists;

  const options = matches.length + (canCreate ? 1 : 0);
  const active = options === 0 ? -1 : Math.min(highlight, options - 1);

  function choose(index: number) {
    const label = matches[index];
    if (label) {
      onSelect(label.id);
      reset();
      return;
    }
    if (canCreate && index === matches.length) {
      void onCreate(trimmed).then(reset);
    }
  }

  function reset() {
    setQuery("");
    setHighlight(0);
    setOpen(false);
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      setOpen(false);
      return;
    }
    if (options === 0) {
      // Arrowing into a closed list is how a combobox is opened.
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      // Enter on an empty or whitespace-only query does nothing at all.
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((i) => (i + 1) % options);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((i) => (i - 1 + options) % options);
      return;
    }
    if (event.key === "Enter") {
      // Enter belongs to the picker here, not to the form around it.
      event.preventDefault();
      choose(active);
    }
  }

  const listId = "create-label-options";

  return (
    <div className="prio-labelpicker">
      <input
        ref={input}
        className="prio-input"
        type="text"
        value={query}
        placeholder="Search or create a label…"
        aria-label="Search or create a label"
        aria-autocomplete="list"
        aria-expanded={options > 0}
        aria-controls={options > 0 ? listId : undefined}
        aria-activedescendant={
          active >= 0 ? `${listId}-${active}` : undefined
        }
        role="combobox"
        disabled={disabled}
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

      {options > 0 ? (
        <ul className="prio-labelpicker__list" role="listbox" id={listId}>
          {matches.map((label, index) => (
            <li key={label.id}>
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
                <span
                  className="prio-label-chip__swatch"
                  style={{ background: label.color }}
                  aria-hidden
                />
                {label.name}
              </button>
            </li>
          ))}

          {canCreate ? (
            <li>
              <button
                type="button"
                id={`${listId}-${matches.length}`}
                role="option"
                aria-selected={matches.length === active}
                className="prio-labelpicker__option"
                data-active={matches.length === active || undefined}
                data-create
                onMouseEnter={() => setHighlight(matches.length)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(matches.length)}
                disabled={busy}
              >
                + Create “{trimmed}”
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {canCreate ? (
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={busy}
          loading={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void onCreate(trimmed).then(reset)}
        >
          Add
        </Button>
      ) : null}
    </div>
  );
}
