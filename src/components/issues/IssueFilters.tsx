"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { ShareSheetDialog } from "@/components/issues/ShareSheetDialog";
import {
  IssueTypeIcon,
  PriorityIndicator,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconChevronDown,
  IconClose,
  IconDownload,
  IconFilter,
  IconSearch,
  IconShare,
} from "@/components/ui/Icon";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITIES,
} from "@/lib/domain";

/**
 * Filter bar for every issue list surface.
 *
 * All state lives in the URL, so a filtered view is shareable, survives a
 * refresh and works with the back button. Selecting a filter is a navigation,
 * and the server re-queries — nothing is filtered on the client.
 */

export interface FilterOption {
  id: string;
  name: string;
  color?: string;
}

export interface IssueFiltersProps {
  projects: FilterOption[];
  people: FilterOption[];
  labels: FilterOption[];
  /**
   * Hides the Project dropdown on a surface that is already one project's —
   * a project's own List tab, where the route fixes the project and the
   * control could only ever confirm what the page already says. Every other
   * filter on the bar is unaffected.
   */
  showProjectFilter?: boolean;
  /** Hides the type filter on surfaces locked to one type, e.g. /bugs. */
  showTypeFilter?: boolean;
  currentUserId: string;
  total: number;
  /** Shows the Export Excel button — only the main /issues surface opts in. */
  enableExport?: boolean;
  /**
   * Shows the Share button — only the main /issues surface opts in, and even
   * then only for an administrator. Sharing manages who else in the
   * organization can see the sheet, which is the same bar this app sets for
   * managing project membership.
   */
  enableShare?: boolean;
  isAdmin?: boolean;
}

/**
 * A dropdown of checkable options, showing how many are active.
 *
 * Declared at module scope: a component defined inside another component's body
 * gets a new identity on every render, so React unmounts and remounts it — the
 * open menu would close on each keystroke elsewhere in the bar.
 */
function FilterMenu({
  label,
  paramKey,
  options,
  selected,
  onToggle,
  single = false,
}: {
  label: string;
  paramKey: string;
  options: { value: string; node: React.ReactNode }[];
  selected: string[];
  onToggle: (paramKey: string, value: string) => void;
  /**
   * One value at a time. Choosing another replaces what was chosen before,
   * rather than adding to it, and the panel closes once the choice is made --
   * there is nothing further to pick. Choosing the current value again clears
   * the filter, which is how clearing already worked here.
   *
   * The chip, the label, the tick and the spacing are untouched: this changes
   * how many values may be held, not how the control looks.
   */
  single?: boolean;
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
          data-active={selected.length > 0}
          {...props}
        >
          {label}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>{label}</MenuLabel>
      {options.map((option) => (
        <MenuItem
          key={option.value}
          keepOpen={!single}
          selected={selected.includes(option.value)}
          onSelect={() => onToggle(paramKey, option.value)}
        >
          {option.node}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function IssueFilters({
  projects,
  people,
  labels,
  showProjectFilter = true,
  showTypeFilter = true,
  currentUserId,
  total,
  enableExport = false,
  enableShare = false,
  isAdmin = false,
}: IssueFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const values = useCallback(
    (key: string): string[] => params.getAll(key),
    [params],
  );

  /** Rewrites one parameter and resets to page 1. */
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

  /**
   * Multi-select: each dropdown accumulates. Picking an option adds it to
   * whatever that dropdown already has; picking a selected one removes just
   * that value and leaves its siblings alone.
   *
   * The menu already showed a checkmark per option and stayed open on click,
   * and `parseIssueParams` already read these keys with `many()` — only this
   * function disagreed, clearing the whole key before appending, so a second
   * pick silently dropped the first.
   *
   * `resolution` and `overdue` deliberately do not come through here: open
   * and closed are mutually exclusive, so they set and clear a single value
   * of their own.
   */
  /**
   * One value for this filter, replacing whatever was there.
   *
   * Only the project filter uses this. Picking the value that is already on
   * removes it, so the single-select control clears the same way the
   * multi-select ones do -- by choosing the ticked entry again.
   */
  const selectOne = useCallback(
    (key: string, value: string) => {
      apply((next) => {
        const already = next.getAll(key).includes(value);
        next.delete(key);
        if (!already) next.append(key, value);
      });
    },
    [apply],
  );

  const toggle = useCallback(
    (key: string, value: string) => {
      apply((next) => {
        const current = next.getAll(key);
        const remaining = current.filter((entry) => entry !== value);

        next.delete(key);
        for (const entry of remaining) next.append(key, entry);

        // Nothing was removed, so this value is new — add it.
        if (remaining.length === current.length) next.append(key, value);
      });
    },
    [apply],
  );

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply((next) => {
      const q = query.trim();
      if (q) next.set("q", q);
      else next.delete("q");
    });
  }

  const activeCount =
    values("project").length +
    values("type").length +
    values("status").length +
    values("priority").length +
    values("assignee").length +
    values("reporter").length +
    values("label").length +
    (params.get("resolution") ? 1 : 0) +
    (params.get("overdue") ? 1 : 0) +
    /* Arrived at from the dashboard's "completed this month". It has no chip of
       its own, so counting it is what tells the reader the list is narrowed by
       something more than the chips show — and `clearAll` drops every param, so
       Clear removes it along with the rest. */
    (params.get("completedWithin") ? 1 : 0) +
    (params.get("q") ? 1 : 0);

  const clearAll = () => {
    startTransition(() => router.push(pathname, { scroll: false }));
    setQuery("");
  };

  /**
   * Downloads the current filtered/searched view as a genuine, fully
   * editable .xlsx workbook. The query string sent is exactly what is in the
   * address bar, so the export always matches what's on screen.
   */
  async function handleExport() {
    if (exporting) return;
    setExporting(true);

    try {
      const qs = params.toString();
      const response = await fetch(
        `/api/issues/export${qs ? `?${qs}` : ""}`,
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error ?? "Export failed. Please try again.",
        );
      }

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "Prio-Issues-Export.xlsx";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast(
        <>
          Exported <strong>{filename}</strong>.
        </>,
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Export failed. Please try again.",
        "error",
      );
    } finally {
      setExporting(false);
    }
  }

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
            placeholder="Search title, description, reproduction steps…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search issues"
          />
        </div>
      </form>

      <div className="prio-filters__chips">
        <span className="prio-filters__icon" aria-hidden>
          <IconFilter />
        </span>

        {showProjectFilter && projects.length > 1 ? (
          <FilterMenu
            label="Project"
            paramKey="project"
            selected={values("project")}
            /* The only single-select filter on this bar. Everything else here
               stays multi-select and keeps `toggle`. */
            single
            onToggle={selectOne}
            options={projects.map((p) => ({
              value: p.id,
              node: p.name,
            }))}
          />
        ) : null}

        {showTypeFilter ? (
          <FilterMenu
            label="Type"
            paramKey="type"
            selected={values("type")}
            onToggle={toggle}
            options={ISSUE_TYPES.map((t) => ({
              value: t,
              node: (
                <span className="prio-filters__option">
                  <IssueTypeIcon type={t} size={16} />
                  {ISSUE_TYPE_LABEL[t]}
                </span>
              ),
            }))}
          />
        ) : null}

        <FilterMenu
          label="Status"
          paramKey="status"
          selected={values("status")}
          onToggle={toggle}
          options={ISSUE_STATUSES.map((s) => ({
            value: s,
            node: <StatusPill status={s} />,
          }))}
        />

        <FilterMenu
          label="Priority"
          paramKey="priority"
          selected={values("priority")}
          onToggle={toggle}
          options={PRIORITIES.map((p) => ({
            value: p,
            node: <PriorityIndicator priority={p} />,
          }))}
        />

        <FilterMenu
          label="Assignee"
          paramKey="assignee"
          selected={values("assignee")}
          onToggle={toggle}
          options={[
            { value: currentUserId, node: "Assigned to me" },
            { value: "none", node: "Unassigned" },
            ...people
              .filter((p) => p.id !== currentUserId)
              .map((p) => ({ value: p.id, node: p.name })),
          ]}
        />

        <FilterMenu
          label="Reporter"
          paramKey="reporter"
          selected={values("reporter")}
          onToggle={toggle}
          options={[
            { value: currentUserId, node: "Reported by me" },
            ...people
              .filter((p) => p.id !== currentUserId)
              .map((p) => ({ value: p.id, node: p.name })),
          ]}
        />

        {labels.length > 0 ? (
          <FilterMenu
            label="Label"
            paramKey="label"
            selected={values("label")}
            onToggle={toggle}
            options={labels.map((l) => ({
              value: l.id,
              node: (
                <span className="prio-filters__option">
                  <span
                    className="prio-label-chip__swatch"
                    style={{ background: l.color }}
                    aria-hidden
                  />
                  {l.name}
                </span>
              ),
            }))}
          />
        ) : null}

        <Menu
          align="start"
          width={200}
          label="Resolution"
          trigger={(props) => (
            <button
              type="button"
              className="prio-filterchip"
              data-active={Boolean(
                params.get("resolution") || params.get("overdue"),
              )}
              {...props}
            >
              More
              <IconChevronDown size={12} />
            </button>
          )}
        >
          <MenuLabel>Resolution</MenuLabel>
          <MenuItem
            keepOpen
            selected={params.get("resolution") === "open"}
            onSelect={() =>
              apply((n) =>
                n.get("resolution") === "open"
                  ? n.delete("resolution")
                  : n.set("resolution", "open"),
              )
            }
          >
            Open only
          </MenuItem>
          <MenuItem
            keepOpen
            selected={params.get("resolution") === "closed"}
            onSelect={() =>
              apply((n) =>
                n.get("resolution") === "closed"
                  ? n.delete("resolution")
                  : n.set("resolution", "closed"),
              )
            }
          >
            Closed only
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            keepOpen
            selected={params.get("overdue") === "1"}
            onSelect={() =>
              apply((n) =>
                n.get("overdue") ? n.delete("overdue") : n.set("overdue", "1"),
              )
            }
          >
            Overdue only
          </MenuItem>
        </Menu>

        {activeCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            <IconClose size={13} />
            Clear {activeCount}
          </Button>
        ) : null}

        <div className="prio-filters__trailing">
          <span className="prio-filters__total">
            {pending ? "Loading…" : `${total} ${total === 1 ? "result" : "results"}`}
          </span>

          {enableExport ? (
            <Button
              variant="brand"
              size="sm"
              onClick={handleExport}
              loading={exporting}
            >
              <IconDownload size={13} />
              {exporting ? "Exporting…" : "Export Excel"}
            </Button>
          ) : null}

          {enableShare && isAdmin ? (
            <Button
              variant="brand"
              size="sm"
              onClick={() => setShareOpen(true)}
            >
              <IconShare size={13} />
              Share
            </Button>
          ) : null}
        </div>
      </div>

      {enableShare && isAdmin ? (
        <ShareSheetDialog open={shareOpen} onClose={() => setShareOpen(false)} />
      ) : null}
    </div>
  );
}
