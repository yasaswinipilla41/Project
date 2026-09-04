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
 *
 * Being single-select is also why none of these items sets `keepOpen`:
 * picking a project *replaces* the previous one, so once a choice is made
 * there is nothing further to pick, and leaving the panel open only hides
 * the results it just changed. The multi-select filters elsewhere (Status,
 * Priority and Labels on the board and the issue list) do keep theirs open,
 * because there ticking one value is usually not the whole answer.
 */

export interface FilterOption {
  id: string;
  name: string;
}

export interface ActivityFiltersProps {
  projects: FilterOption[];
  people: FilterOption[];
  total: number;
  /**
   * Hides the Project dropdown on a feed that is already one project's — a
   * project's own Activity tab, where the route fixes the project and the
   * control could only ever confirm what the page already says. Every other
   * filter on the bar is unaffected.
   */
  showProjectFilter?: boolean;
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

export function ActivityFilters({
  projects,
  people,
  total,
  showProjectFilter = true,
}: ActivityFiltersProps) {
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
        {showProjectFilter ? (
        <SingleSelectMenu
          label="Project"
          active={Boolean(projectId)}
          activeLabel={projects.find((p) => p.id === projectId)?.name}
        >
          <MenuLabel>Project</MenuLabel>
          <MenuItem
            selected={!projectId}
            onSelect={() => apply((n) => n.delete("project"))}
          >
            All projects
          </MenuItem>
          {projects.map((project) => (
            <MenuItem
              key={project.id}
              selected={project.id === projectId}
              onSelect={() => apply((n) => n.set("project", project.id))}
            >
              {project.name}
            </MenuItem>
          ))}
        </SingleSelectMenu>
        ) : null}

        <SingleSelectMenu
          label="User"
          active={Boolean(userId)}
          activeLabel={people.find((p) => p.id === userId)?.name}
        >
          <MenuLabel>User</MenuLabel>
          <MenuItem
            selected={!userId}
            onSelect={() => apply((n) => n.delete("user"))}
          >
            All users
          </MenuItem>
          {people.map((person) => (
            <MenuItem
              key={person.id}
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
          <MenuItem selected={!type} onSelect={() => apply((n) => n.delete("type"))}>
            All activity
          </MenuItem>
          {ACTIVITY_TYPES.map((t) => (
            <MenuItem
              key={t}
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
