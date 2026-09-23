"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition, type FormEvent } from "react";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { IconChevronDown, IconClose, IconSearch } from "@/components/ui/Icon";
import { ASSIGNMENT_KINDS } from "@/lib/activity";

/**
 * The controls above Backlog History.
 *
 * Built the way every other list bar in Prio is: the state lives in the URL,
 * choosing a filter is a navigation, and the server re-queries. A filtered
 * history is therefore shareable — "look at what happened to this on the
 * 14th" is a link — and the back button does what it looks like it does.
 *
 * The date pair is the one control Prio did not already have. Two plain date
 * inputs rather than a calendar popover: the question here is almost always
 * "that week" or "that day", which a person types faster than they click.
 */

export interface HistoryPerson {
  id: string;
  name: string;
}

export function AssignmentHistoryFilters({
  people,
  total,
}: {
  people: HistoryPerson[];
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get("q") ?? "");

  const apply = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      /* Any change of filter is a new first page; leaving `page` behind is how
         a filter appears to return nothing at all. */
      next.delete("page");
      startTransition(() =>
        router.push(`${pathname}?${next.toString()}`, { scroll: false }),
      );
    },
    [params, pathname, router],
  );

  const set = (key: string, value: string | null) =>
    apply((next) => {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    });

  function search(event: FormEvent) {
    event.preventDefault();
    set("q", query.trim() || null);
  }

  const kind = params.get("kind");
  const who = params.get("user");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  const active =
    (params.get("q") ? 1 : 0) +
    (kind ? 1 : 0) +
    (who ? 1 : 0) +
    (from ? 1 : 0) +
    (to ? 1 : 0);

  const chosen = people.find((person) => person.id === who);

  return (
    <div className="prio-filters" data-pending={pending || undefined}>
      <form className="prio-filters__search" onSubmit={search} role="search">
        <div className="prio-search">
          <span className="prio-search__icon" aria-hidden>
            <IconSearch size={15} />
          </span>
          <input
            type="search"
            className="prio-input"
            placeholder="Search work items"
            aria-label="Search work items"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </form>

      <div className="prio-filters__chips">
        <Menu
          align="start"
          width={200}
          label="Assignment type"
          trigger={(props) => (
            <button
              type="button"
              className="prio-filterchip"
              data-active={kind !== null}
              {...props}
            >
              {kind ?? "Assignment type"}
              <IconChevronDown size={12} />
            </button>
          )}
        >
          <MenuLabel>Assignment type</MenuLabel>
          <MenuItem selected={kind === null} onSelect={() => set("kind", null)}>
            All
          </MenuItem>
          {ASSIGNMENT_KINDS.map((option) => (
            <MenuItem
              key={option}
              selected={kind === option}
              onSelect={() => set("kind", kind === option ? null : option)}
            >
              {option}
            </MenuItem>
          ))}
        </Menu>

        <Menu
          align="start"
          width={240}
          label="Person"
          trigger={(props) => (
            <button
              type="button"
              className="prio-filterchip"
              data-active={who !== null}
              {...props}
            >
              {chosen?.name ?? "Person"}
              <IconChevronDown size={12} />
            </button>
          )}
        >
          {/* Anybody involved, not only who received it — the row somebody is
              looking for is as often the one where work left them. */}
          <MenuLabel>Assigned to, from, or by</MenuLabel>
          <MenuItem selected={who === null} onSelect={() => set("user", null)}>
            Anyone
          </MenuItem>
          {people.map((person) => (
            <MenuItem
              key={person.id}
              selected={who === person.id}
              onSelect={() =>
                set("user", who === person.id ? null : person.id)
              }
            >
              {person.name}
            </MenuItem>
          ))}
        </Menu>

        <label className="prio-filters__date">
          <span className="prio-visually-hidden">From date</span>
          <input
            type="date"
            className="prio-input prio-input--sm"
            value={from}
            max={to || undefined}
            onChange={(event) => set("from", event.target.value || null)}
          />
        </label>
        <span className="prio-text-muted">to</span>
        <label className="prio-filters__date">
          <span className="prio-visually-hidden">To date</span>
          <input
            type="date"
            className="prio-input prio-input--sm"
            value={to}
            min={from || undefined}
            onChange={(event) => set("to", event.target.value || null)}
          />
        </label>

        {active > 0 ? (
          <button
            type="button"
            className="prio-filterchip"
            onClick={() => {
              setQuery("");
              startTransition(() => router.push(pathname, { scroll: false }));
            }}
          >
            <IconClose size={12} />
            Clear {active}
          </button>
        ) : null}

        <span className="prio-filters__trailing">
          <span className="prio-filters__total">
            {pending
              ? "Loading…"
              : `${total} ${total === 1 ? "assignment" : "assignments"}`}
          </span>
        </span>
      </div>
    </div>
  );
}
