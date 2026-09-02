"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type ReactNode,
} from "react";
import type { IssueStatus, IssueType, Priority } from "@prisma/client";
import { Avatar, AvatarStack } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  LabelChip,
  PriorityIndicator,
  StatusPill,
} from "@/components/ui/Indicators";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconReports,
  IconSearch,
} from "@/components/ui/Icon";
import { IssueRowActions } from "@/components/issues/IssueRowActions";
import { BOARD_STATUSES, boardColumnFor } from "@/lib/board";
import {
  canTransition,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import { updateIssue } from "@/server/issues";

/**
 * The project Flow Board, laid out and styled to match the approved Flow
 * Board design: breadcrumb, page header, a filter toolbar, and one column per
 * status in `BOARD_STATUSES` — Backlog included, so filed-but-unplanned work
 * is visible on the board rather than only in the issue list.
 *
 * No column carries a rule of its own. Which moves are offered, and which
 * drops are refused, come from `canTransition` below — so Backlog is an
 * ordinary column that happens to lead into Todo, In Progress and Cancelled,
 * and is never a stand-in for review or QA.
 *
 * Dragging a card between columns — the board's only way to change status,
 * matching the reference design's plain, menu-free cards — calls the same
 * `updateIssue` server action the issue detail page's own status field uses.
 * The move is shown immediately via `useOptimistic` and reconciled against the
 * server once `updateIssue` and the following `router.refresh()` resolve.
 */

export interface BoardIssue {
  id: string;
  key: string;
  type: IssueType;
  title: string;
  status: IssueStatus;
  priority: Priority;
  sortIndex: number;
  reporterId: string;
  assignee: { id: string; name: string; image: string | null } | null;
  labels: { label: { id: string; name: string; color: string } }[];
}

export interface BoardColumn {
  status: IssueStatus;
  issues: BoardIssue[];
}

export interface BoardProjectRef {
  id: string;
  key: string;
  name: string;
}

export interface BoardMember {
  id: string;
  name: string;
  image: string | null;
}

export interface BoardLabel {
  id: string;
  name: string;
  color: string;
}

type MoveAction = { issueId: string; status: IssueStatus };

const UNASSIGNED = "unassigned";

/**
 * Grouping choices actually backed by real Prio data. "Project" and "Epic"
 * are deliberately absent: this board is already scoped to one project (every
 * issue on it shares the same `projectId`, so grouping by project would
 * produce a single group), and while EPIC is now a real issue type, nothing
 * links an issue to an epic — they are flat types, so there is no grouping to
 * derive.
 */
type GroupBy = "NONE" | "ASSIGNEE" | "PRIORITY" | "LABEL";

const GROUP_BY_OPTIONS: GroupBy[] = ["NONE", "ASSIGNEE", "PRIORITY", "LABEL"];

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  NONE: "None",
  ASSIGNEE: "Assignee",
  PRIORITY: "Priority",
  LABEL: "Labels",
};

/** One rendered board column, whichever grouping produced it. */
interface BoardGroup {
  key: string;
  /** Set only for the default status grouping — everything status-specific
   *  (drag-and-drop, the coloured top border, the TODO/IN_PROGRESS header
   *  buttons) keys off this being non-null. */
  status: IssueStatus | null;
  title: string;
  issues: BoardIssue[];
}

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/**
 * A toolbar dropdown styled like the reference design's filter buttons.
 *
 * `data-active` keeps the Search-Bar-style highlight (see board.css) on a
 * filter that has a selection, even after the dropdown itself has closed —
 * `aria-expanded`, forwarded straight from `Menu`, covers the "open right
 * now" half of that same highlight on its own.
 */
function ToolbarMenu({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
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
          data-active={Boolean(count) || undefined}
          {...props}
        >
          {label}
          {count ? <span className="prio-filterchip__count">{count}</span> : null}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      {children}
    </Menu>
  );
}

export function FlowBoard({
  project,
  allProjects,
  members,
  labels,
  columns,
  currentUserId,
  isAdmin,
  insights,
}: {
  project: BoardProjectRef;
  allProjects: BoardProjectRef[];
  members: BoardMember[];
  labels: BoardLabel[];
  columns: BoardColumn[];
  currentUserId: string;
  isAdmin: boolean;
  /**
   * This project's Insights, rendered on the server by the board's page and
   * handed over as content. Passing the finished element rather than fetching
   * on demand is what lets Insights open without leaving the board: there is
   * no route to change and nothing to wait for.
   */
  insights?: ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>("NONE");

  /* What Clear will undo. Group by is included: it is a view the person
     chose, and "clear" that left it applied would be lying about what it did. */
  const activeFilterCount =
    (query.trim() ? 1 : 0) +
    statusFilter.length +
    assigneeFilter.length +
    priorityFilter.length +
    labelFilter.length +
    (groupBy === "NONE" ? 0 : 1);

  function clearFilters() {
    setQuery("");
    setStatusFilter([]);
    setAssigneeFilter([]);
    setPriorityFilter([]);
    setLabelFilter([]);
    setGroupBy("NONE");
  }

  /* Insights replaces the columns rather than sitting above them: the board is
     wide and the figures are tall, and stacking the two would put one of them
     off-screen whichever came first. The toolbar stays, so the way back is in
     the same place as the way in. */
  const [showInsights, setShowInsights] = useState(false);

  /*
   * The board ends where the window does.
   *
   * The columns used to be as tall as their tallest column, so the board's
   * horizontal scrollbar sat at the bottom of the *content* -- to reach the
   * control that scrolls the board sideways you first had to scroll the page
   * down past every card, and on a full board it was several screens away.
   *
   * Bounding the column area to the space actually left below it puts that
   * scrollbar at the bottom of the board as it is seen, and takes the vertical
   * scrolling into the board instead of the page.
   *
   * The distance from the top is measured rather than assumed: it changes with
   * the toolbar's height, which wraps at narrow widths and grows when Clear
   * appears. A hard-coded offset would be right at one width and wrong at the
   * next.
   */
  const columnsRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = columnsRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    el.style.setProperty("--prio-board-top", `${Math.max(0, Math.round(top))}px`);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    /* The toolbar above can change height without the window doing anything --
       a filter chip wrapping onto a second line moves the board down. */
    const observer = new ResizeObserver(measure);
    const board = columnsRef.current?.parentElement;
    if (board) observer.observe(board);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [measure]);

  const [dragIssueId, setDragIssueId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<IssueStatus | null>(null);
  /* Ids ticked for a bulk move. Kept as a Set because every card asks "am I
     in this?" on each render. */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelected(issueId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(issueId)) next.add(issueId);
      return next;
    });
  }

  const baseIssues = useMemo(
    () => columns.flatMap((column) => column.issues),
    [columns],
  );

  const [issues, moveIssue] = useOptimistic(
    baseIssues,
    (state, action: MoveAction) =>
      state.map((issue) =>
        issue.id === action.issueId
          ? { ...issue, status: action.status }
          : issue,
      ),
  );

  const q = query.trim().toLowerCase();
  const visible = issues.filter((issue) => {
    if (q && !issue.title.toLowerCase().includes(q) && !issue.key.toLowerCase().includes(q)) {
      return false;
    }
    /* Filtered by column, not by raw status: the Status menu offers the
       board's columns, so picking New must keep the reopened issues drawn in
       New rather than hiding them. */
    if (
      statusFilter.length &&
      !statusFilter.includes(boardColumnFor(issue.status))
    ) {
      return false;
    }
    if (priorityFilter.length && !priorityFilter.includes(issue.priority)) return false;
    if (assigneeFilter.length) {
      const id = issue.assignee?.id ?? UNASSIGNED;
      if (!assigneeFilter.includes(id)) return false;
    }
    if (labelFilter.length) {
      const ids = issue.labels.map(({ label }) => label.id);
      if (!labelFilter.some((id) => ids.includes(id))) return false;
    }
    return true;
  });

  /**
   * The board's columns. "None" reproduces the original five status columns
   * exactly (same drag-and-drop, same per-column header buttons); every other
   * grouping re-buckets the same already-filtered `visible` list by a
   * different key, so a search term or any toolbar filter narrows the board
   * the same way regardless of how it's grouped.
   *
   * Assignee and label groups are seeded from `members` / `labels` — every
   * project member and label gets a column even at zero issues — rather than
   * only from issues that happen to be visible, so a group doesn't wink out
   * of existence the moment its last visible issue is filtered away.
   */
  const groups: BoardGroup[] = useMemo(() => {
    if (groupBy === "NONE") {
      return BOARD_STATUSES.map((status) => ({
        key: status,
        status,
        title: STATUS_LABEL[status].toUpperCase(),
        // Same mapping the page used, so an optimistic move lands in the same
        // column the server would have put it in.
        issues: visible.filter((issue) => boardColumnFor(issue.status) === status),
      }));
    }

    if (groupBy === "PRIORITY") {
      return PRIORITIES.map((priority) => ({
        key: priority,
        status: null,
        title: PRIORITY_LABEL[priority].toUpperCase(),
        issues: visible.filter((issue) => issue.priority === priority),
      }));
    }

    if (groupBy === "ASSIGNEE") {
      const named = [...members]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((member): BoardGroup => ({
          key: member.id,
          status: null,
          title: member.name.toUpperCase(),
          issues: visible.filter((issue) => issue.assignee?.id === member.id),
        }));

      return [
        ...named,
        {
          key: UNASSIGNED,
          status: null,
          title: "UNASSIGNED",
          issues: visible.filter((issue) => !issue.assignee),
        },
      ];
    }

    // LABEL — an issue carrying more than one label appears in each of them,
    // the same convention Jira-style label grouping uses.
    const byLabel = [...labels]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((label): BoardGroup => ({
        key: label.id,
        status: null,
        title: label.name.toUpperCase(),
        issues: visible.filter((issue) =>
          issue.labels.some(({ label: l }) => l.id === label.id),
        ),
      }));

    return [
      ...byLabel,
      {
        key: "no-label",
        status: null,
        title: "NO LABEL",
        issues: visible.filter((issue) => issue.labels.length === 0),
      },
    ];
  }, [groupBy, visible, members, labels]);

  /*
   * Moving one card and moving a selection are the same code path — a single
   * drag is just a move of one. Each issue is sent on its own request because
   * `updateIssue` is what writes the activity entry and the notification for
   * that issue; batching them into one call would collapse several distinct
   * events into one and lose that history.
   */
  function move(issueIds: string[], status: IssueStatus) {
    const candidates = issueIds
      .map((id) => issues.find((i) => i.id === id))
      .filter((issue): issue is (typeof issues)[number] => Boolean(issue))
      .filter((issue) => issue.status !== status);

    /*
     * The workflow decides what may land here, using the same rules as the
     * issue page's status menu and the server. Refusing the drop outright is
     * better than moving the card optimistically and watching it spring back
     * when `updateIssue` says no.
     */
    const moving = candidates
      .filter((issue) => canTransition(issue.status, status))
      .map((issue) => issue.id);

    const refused = candidates.filter(
      (issue) => !canTransition(issue.status, status),
    );
    if (refused.length > 0) {
      const first = refused[0];
      toast(
        refused.length === 1 && first
          ? `${first.key} cannot move straight from ${STATUS_LABEL[first.status]} to ${STATUS_LABEL[status]}.`
          : `${refused.length} issues cannot move to ${STATUS_LABEL[status]} from where they are.`,
        "error",
      );
    }

    if (moving.length === 0) return;

    startTransition(async () => {
      for (const issueId of moving) moveIssue({ issueId, status });

      const results = await Promise.all(
        moving.map((issueId) => updateIssue({ issueId, status })),
      );
      const errors = results.flatMap((r) => (r.ok ? [] : [r.error]));
      if (errors.length > 0) {
        toast(
          errors.length === 1
            ? errors[0]
            : `${errors.length} issues could not be moved.`,
          "error",
        );
      }
      setSelected(new Set());
      router.refresh();
    });
  }

  /*
   * While a card is in the air, which columns will take it. Only the dragged
   * card is considered when it sits outside the selection, matching what the
   * drop itself will do.
   */
  const draggingStatuses = (() => {
    if (!dragIssueId) return [];
    const ids = selected.has(dragIssueId) ? [...selected] : [dragIssueId];
    return ids
      .map((id) => issues.find((i) => i.id === id)?.status)
      .filter((s): s is IssueStatus => Boolean(s));
  })();

  const columnAccepts = (status: IssueStatus): boolean =>
    draggingStatuses.length === 0 ||
    draggingStatuses.some((from) => canTransition(from, status));

  function handleDrop(event: DragEvent<HTMLDivElement>, status: IssueStatus) {
    event.preventDefault();
    setDropTarget(null);
    const issueId = event.dataTransfer.getData("text/plain") || dragIssueId;
    setDragIssueId(null);
    if (!issueId) return;

    /* Dragging a card that is part of the selection moves the whole
       selection; dragging one outside it moves only that card, which is what
       makes an accidental tick harmless. */
    const ids = selected.has(issueId) ? [...selected] : [issueId];
    move(ids, status);
  }

  return (
    <div className="prio-board">
      <div className="prio-board__toolbar">
        <div className="prio-board__toolbar-left">
          <div className="prio-search prio-board__search">
            <span className="prio-search__icon">
              <IconSearch size={16} />
            </span>
            <input
              type="search"
              className="prio-input"
              placeholder="Search issues…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search issues on this board"
            />
          </div>

          <div className="prio-board__divider" aria-hidden />

          <div className="prio-board__filters">
            <ToolbarMenu label="Project">
              <MenuLabel>Go to project</MenuLabel>
              {allProjects.map((p) => (
                <MenuItem
                  key={p.id}
                  href={`/projects/${p.key.toLowerCase()}/board`}
                  selected={p.id === project.id}
                  icon={
                    <span className="prio-project-chip" aria-hidden>
                      {p.key.slice(0, 2)}
                    </span>
                  }
                  trailing={<span className="prio-key">{p.key}</span>}
                >
                  {p.name}
                </MenuItem>
              ))}
            </ToolbarMenu>

            <ToolbarMenu label="Status" count={statusFilter.length}>
              {BOARD_STATUSES.map((status) => (
                <MenuItem
                  key={status}
                  keepOpen
                  selected={statusFilter.includes(status)}
                  onSelect={() => setStatusFilter((prev) => toggleValue(prev, status))}
                >
                  <StatusPill status={status} />
                </MenuItem>
              ))}
            </ToolbarMenu>

            <Menu
              align="start"
              width={230}
              label="Assignee"
              trigger={(props) => (
                <button
                  type="button"
                  className="prio-filterchip prio-board__assignee-trigger"
                  data-active={assigneeFilter.length > 0 || undefined}
                  {...props}
                >
                  <span>Assignee</span>
                  {members.length > 0 ? (
                    <AvatarStack people={members} max={2} />
                  ) : null}
                  {assigneeFilter.length > 0 ? (
                    <span className="prio-filterchip__count">
                      {assigneeFilter.length}
                    </span>
                  ) : null}
                  <IconChevronDown size={12} />
                </button>
              )}
            >
              <MenuLabel>Filter by assignee</MenuLabel>
              <MenuItem
                keepOpen
                selected={assigneeFilter.includes(UNASSIGNED)}
                onSelect={() => setAssigneeFilter((prev) => toggleValue(prev, UNASSIGNED))}
                icon={<Avatar name={null} empty size="xs" />}
              >
                Unassigned
              </MenuItem>
              {members.map((member) => (
                <MenuItem
                  key={member.id}
                  keepOpen
                  selected={assigneeFilter.includes(member.id)}
                  onSelect={() => setAssigneeFilter((prev) => toggleValue(prev, member.id))}
                  icon={<Avatar name={member.name} image={member.image} size="xs" />}
                >
                  {member.name}
                </MenuItem>
              ))}
            </Menu>

            <ToolbarMenu label="Priority" count={priorityFilter.length}>
              {PRIORITIES.map((priority) => (
                <MenuItem
                  key={priority}
                  keepOpen
                  selected={priorityFilter.includes(priority)}
                  onSelect={() => setPriorityFilter((prev) => toggleValue(prev, priority))}
                >
                  <PriorityIndicator priority={priority} />
                </MenuItem>
              ))}
            </ToolbarMenu>

            <ToolbarMenu label="Labels" count={labelFilter.length}>
              {labels.length === 0 ? (
                <MenuLabel>No labels in this project</MenuLabel>
              ) : (
                labels.map((label) => (
                  <MenuItem
                    key={label.id}
                    keepOpen
                    selected={labelFilter.includes(label.id)}
                    onSelect={() => setLabelFilter((prev) => toggleValue(prev, label.id))}
                    icon={
                      <span
                        className="prio-label-chip__swatch"
                        style={{ background: label.color }}
                        aria-hidden
                      />
                    }
                  >
                    {label.name}
                  </MenuItem>
                ))
              )}
            </ToolbarMenu>

            {/* Same control the issue list carries, in the same place beside
                the chips it clears. */}
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="prio-btn prio-btn--ghost prio-btn--sm"
                onClick={clearFilters}
              >
                <IconClose size={13} />
                Clear {activeFilterCount}
              </button>
            ) : null}
          </div>
        </div>

        <div className="prio-board__toolbar-right">
          <div className="prio-board__groupby">
            <span>Group by</span>
            <Menu
              align="end"
              width={160}
              label="Group issues by"
              trigger={(props) => (
                <button
                  type="button"
                  className="prio-btn prio-btn--secondary"
                  data-active={groupBy !== "NONE" || undefined}
                  {...props}
                >
                  {GROUP_BY_LABEL[groupBy]}
                  <IconChevronDown size={16} />
                </button>
              )}
            >
              {GROUP_BY_OPTIONS.map((option) => (
                <MenuItem
                  key={option}
                  selected={groupBy === option}
                  onSelect={() => setGroupBy(option)}
                >
                  {GROUP_BY_LABEL[option]}
                </MenuItem>
              ))}
            </Menu>
          </div>

          {/*
            * Insights opens here rather than at /reports. It used to be a link
            * away from the board, which meant losing the board -- its filters,
            * its scroll position and the project it was showing -- to read
            * figures about that same project. It is a view of the board's own
            * content, so it belongs on the board.
            */}
          {insights ? (
            <button
              type="button"
              className="prio-btn prio-btn--secondary"
              onClick={() => setShowInsights((open) => !open)}
              aria-pressed={showInsights}
              aria-expanded={showInsights}
            >
              <IconReports size={18} style={{ color: "var(--prio-primary-600)" }} />
              {showInsights ? "Back to board" : "Insights"}
            </button>
          ) : (
            <a href="/reports" className="prio-btn prio-btn--secondary">
              <IconReports size={18} style={{ color: "var(--prio-primary-600)" }} />
              Insights
            </a>
          )}
        </div>
      </div>

      {/* Only present while something is ticked, so the board is unchanged
          for anyone not moving things in bulk. */}
      {selected.size > 0 ? (
        <div className="prio-board__selection" role="status">
          <span>
            {selected.size} issue{selected.size === 1 ? "" : "s"} selected —
            drag any one of them to move them together
          </span>
          <button
            type="button"
            className="prio-btn prio-btn--ghost prio-btn--sm"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
      ) : null}

      {showInsights ? (
        <div className="prio-board__insights">{insights}</div>
      ) : (
      <div className="prio-board__columns prio-scroll" ref={columnsRef}>
        {groups.map((group) => {
          const status = group.status;

          return (
            <div
              key={group.key}
              className="prio-board__column"
              data-status={status ?? undefined}
              data-drop-active={(status && dropTarget === status) || undefined}
              data-refuses={
                status && dragIssueId && !columnAccepts(status) ? "true" : undefined
              }
              onDragOver={
                status
                  ? (event) => {
                      event.preventDefault();
                      /* "none" turns the cursor into the no-entry sign, so the
                         workflow is visible before the card is let go rather
                         than explained afterwards. */
                      const ok = columnAccepts(status);
                      event.dataTransfer.dropEffect = ok ? "move" : "none";
                      if (ok && dropTarget !== status) setDropTarget(status);
                    }
                  : undefined
              }
              onDragLeave={
                status
                  ? (event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                      setDropTarget((current) => (current === status ? null : current));
                    }
                  : undefined
              }
              onDrop={status ? (event) => handleDrop(event, status) : undefined}
            >
              <div className="prio-board__column-header">
                <h2 className="prio-board__column-title">
                  {group.title}
                  {status === "DONE" ? (
                    <IconCheck size={14} className="prio-board__column-check" />
                  ) : null}
                  <span className="prio-board__column-count">{group.issues.length}</span>
                </h2>

              </div>

              <div className="prio-board__column-body prio-scroll">
                {group.issues.length === 0 ? (
                  <div className="prio-board__column-empty">
                    {status ? "Drop issues here" : "No issues"}
                  </div>
                ) : (
                  group.issues.map((issue) => (
                    <BoardCard
                      key={issue.id}
                      issue={issue}
                      draggable={status !== null}
                      showStatus={status === null}
                      currentUserId={currentUserId}
                      isAdmin={isAdmin}
                      dragging={
                        dragIssueId === issue.id ||
                        (dragIssueId !== null &&
                          selected.has(issue.id) &&
                          selected.has(dragIssueId))
                      }
                      selected={selected.has(issue.id)}
                      onToggleSelected={() => toggleSelected(issue.id)}
                      onDragStart={(event) => {
                        setDragIssueId(issue.id);
                        event.dataTransfer.setData("text/plain", issue.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragIssueId(null);
                        setDropTarget(null);
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

function BoardCard({
  issue,
  draggable,
  showStatus,
  currentUserId,
  isAdmin,
  dragging,
  selected,
  onToggleSelected,
  onDragStart,
  onDragEnd,
}: {
  issue: BoardIssue;
  /** False whenever the column isn't a status — a group like "Assignee" has
   *  no matching drop target for a dragged card to land in. */
  draggable: boolean;
  /** True once the column no longer encodes the issue's status by itself. */
  showStatus: boolean;
  currentUserId: string;
  isAdmin: boolean;
  dragging: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const href = `/issues/${issue.key.toLowerCase()}`;
  const cancelled = issue.status === "CANCELLED";

  /*
   * The whole card used to be a link. On a board whose primary interaction is
   * dragging that is the wrong default: a drag that ends near where it started
   * still produces a click, so moving a card between columns could navigate
   * away from the board instead. Opening an issue is now something you aim at
   * — the key below, or "Open / edit" in the card's own menu — and the card
   * surface is left to do the one job it exists for.
   */
  return (
    <div
      className="prio-board__card"
      draggable={draggable}
      data-dragging={dragging || undefined}
      data-selected={selected || undefined}
      data-cancelled={cancelled || undefined}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <div className="prio-board__card-top">
        {/* Ticking cards is how several move at once. `draggable={false}`
            and the stopped propagation are the same guards the card menu
            below uses: without them, reaching for the box starts a drag. */}
        {draggable ? (
          <label
            className="prio-board__card-select"
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelected}
              aria-label={`Select ${issue.key}`}
            />
          </label>
        ) : null}

        <p className="prio-board__card-title">{issue.title}</p>

        {/*
         * The card itself is draggable and its own click navigates to the
         * issue. `draggable={false}` here is what actually stops a drag
         * starting from the menu — per the HTML drag-and-drop algorithm, an
         * explicit `draggable=false` on a descendant halts the walk up to
         * the card's own `draggable=true` rather than merely opting the
         * button itself out, so it cannot fall through to the ancestor.
         * `stopPropagation` on click separately keeps the same interaction
         * from also bubbling into the card's own onClick and navigating.
         */}
        <div
          className="prio-board__card-menu"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <IssueRowActions
            issueId={issue.id}
            issueKey={issue.key}
            reporterId={issue.reporterId}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
          />
        </div>
      </div>

      {issue.labels.length > 0 ? (
        <div className="prio-board__card-labels">
          {issue.labels.map(({ label }) => (
            <LabelChip key={label.id} name={label.name} color={label.color} />
          ))}
        </div>
      ) : null}

      <div className="prio-board__card-footer">
        {/* `draggable={false}` stops a drag starting here from being taken
            as a link drag, the same guard the card menu above uses. */}
        <Link
          href={href}
          className="prio-board__card-key"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
        >
          <IssueTypeIcon type={issue.type} size={14} />
          <IssueKey issueKey={issue.key} />
        </Link>

        {showStatus ? <StatusPill status={issue.status} /> : null}

        {issue.assignee ? (
          <Avatar name={issue.assignee.name} image={issue.assignee.image} />
        ) : null}
      </div>
    </div>
  );
}
