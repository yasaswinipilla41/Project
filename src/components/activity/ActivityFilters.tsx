"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { IconChevronDown, IconClose, IconSearch } from "@/components/ui/Icon";
import { ACTIVITY_TYPES, ACTIVITY_TYPE_LABEL, type ActivityType } from "@/lib/activity";

/**
 * Filter bar for the Activity feed (§ activity follow-up).
 *
 * Same shape as `IssueFilters`: every filter lives in the URL, so a filtered
 * view is shareable and survives a refresh, and the server re-queries rather
 * than filtering client-side. Project, User and Type are single-select here —
 * "which one project" reads more naturally than a checklist for this feed.
 */

export interface FilterOption {
  id: string;
  name: string;
}

export interface ActivityFiltersProps {
  projects: FilterOption[];
  people: FilterOption[];
  total: number;
}

/** Declared at module scope so an open menu survives a keystroke elsewhere in the bar. */
function SingleSelectMenu({
  label,
  active,
  activeLabel,
  children,
}: {
  label: string;
  active: boolean;
  activeLabel?: string;
  children: ReactNode;
}) {
  return (
    <Menu
      align="start"
      width={230}
      label={label}
      trigger={(props) => (
        <button
          type="button"
          className="prio-filterchip"
          data-active={active}
          {...props}
        >
          {active && activeLabel ? activeLabel : label}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      {children}
    </Menu>
  );
}

export function ActivityFilters({ projects, people, total }: ActivityFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get("q") ?? "");

  const apply = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      next.delete("page");
      startTransition(() => {
        router.push(`${pathname}?${next.toString()}`, { scroll: false });
      });
    },
    [params, pathname, router],
  );

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply((next) => {
      const q = query.trim();
      if (q) next.set("q", q);
      else next.delete("q");
    });
  }

  const projectId = params.get("project");
  const userId = params.get("user");
  const type = params.get("type") as ActivityType | null;

  const activeCount =
    (projectId ? 1 : 0) + (userId ? 1 : 0) + (type ? 1 : 0) + (params.get("q") ? 1 : 0);

  const clearAll = () => {
    startTransition(() => router.push(pathname, { scroll: false }));
    setQuery("");
  };

  return (
    <div className="prio-filters" data-pending={pending}>
      <form onSubmit={onSearch} role="search" className="prio-filters__search">
        <div className="prio-search">
          <span className="prio-search__icon">
            <IconSearch />
          </span>
          <input
            type="search"
            className="prio-input"
            placeholder="Search activity…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search activity by user, task or project"
          />
        </div>
      </form>

      <div className="prio-filters__chips">
        <SingleSelectMenu
          label="Project"
          active={Boolean(projectId)}
          activeLabel={projects.find((p) => p.id === projectId)?.name}
        >
          <MenuLabel>Project</MenuLabel>
          <MenuItem
            keepOpen
            selected={!projectId}
            onSelect={() => apply((n) => n.delete("project"))}
          >
            All projects
          </MenuItem>
          {projects.map((project) => (
            <MenuItem
              key={project.id}
              keepOpen
              selected={project.id === projectId}
              onSelect={() => apply((n) => n.set("project", project.id))}
            >
              {project.name}
            </MenuItem>
          ))}
        </SingleSelectMenu>

        <SingleSelectMenu
          label="User"
          active={Boolean(userId)}
          activeLabel={people.find((p) => p.id === userId)?.name}
        >
          <MenuLabel>User</MenuLabel>
          <MenuItem
            keepOpen
            selected={!userId}
            onSelect={() => apply((n) => n.delete("user"))}
          >
            All users
          </MenuItem>
          {people.map((person) => (
            <MenuItem
              key={person.id}
              keepOpen
              selected={person.id === userId}
              onSelect={() => apply((n) => n.set("user", person.id))}
            >
              {person.name}
            </MenuItem>
          ))}
        </SingleSelectMenu>

        <SingleSelectMenu
          label="Type"
          active={Boolean(type)}
          activeLabel={type ? ACTIVITY_TYPE_LABEL[type] : undefined}
        >
          <MenuLabel>Activity type</MenuLabel>
          <MenuItem keepOpen selected={!type} onSelect={() => apply((n) => n.delete("type"))}>
            All activity
          </MenuItem>
          {ACTIVITY_TYPES.map((t) => (
            <MenuItem
              key={t}
              keepOpen
              selected={t === type}
              onSelect={() => apply((n) => n.set("type", t))}
            >
              {ACTIVITY_TYPE_LABEL[t]}
            </MenuItem>
          ))}
        </SingleSelectMenu>

        {activeCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            <IconClose size={13} />
            Clear {activeCount}
          </Button>
        ) : null}

        <span className="prio-filters__total">
          {pending ? "Loading…" : `${total} ${total === 1 ? "result" : "results"}`}
        </span>
      </div>
    </div>
  );
}
