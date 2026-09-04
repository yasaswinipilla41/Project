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
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconReports,
  IconSearch,
} from "@/components/ui/Icon";
import { IssueRowActions } from "@/components/issues/IssueRowActions";
import { BOARD_STATUSES, boardColumnFor, dropStatusFor } from "@/lib/board";
import {
  ISSUE_STATUSES,
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
  /**
   * Whether this person administers Prio. Read by the Assignee filter, which
   * offers members an "Admin" bucket instead of a roster of their colleagues'
   * names — so the board has to know which assignees are administrators
   * without the viewer being told who they are.
   */
  isAdmin: boolean;
}

export interface BoardLabel {
  id: string;
  name: string;
  color: string;
}

type MoveAction = { issueId: string; status: IssueStatus };

const UNASSIGNED = "unassigned";

/**
 * Assignee filter values that are not a person.
 *
 * A member's Assignee dropdown does not list the team. It offers the three
 * questions somebody working a board actually asks of it — is this mine, is
 * this nobody's, is this with an administrator — and none of them requires
 * knowing who else is on the project. An administrator's dropdown is
 * unchanged and still lists everyone, because assigning and re-assigning work
 * is an administrator's job and it cannot be done blind.
 *
 * `MINE` is not a sentinel: it is the viewer's own id, so it filters through
 * exactly the same path a picked name does.
 */
const ADMIN_ASSIGNEES = "admins";

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
  /**
   * The project this board is showing, or `null` for the all-projects board
   * reached from the sidebar. Only the Project dropdown reads it — the
   * columns, the cards and every filter work the same either way, because
   * the page above has already decided which issues to hand over.
   */
  project: BoardProjectRef | null;
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

  /* Who counts as an administrator on this board. Used to resolve the
     "Admin" filter value, and to decide whether that option is offered at
     all — there is no point in a bucket nobody could be in. */
  const adminIds = useMemo(
    () => new Set(members.filter((m) => m.isAdmin).map((m) => m.id)),
    [members],
  );

  const q = query.trim().toLowerCase();
  const visible = issues.filter((issue) => {
    if (q && !issue.title.toLowerCase().includes(q) && !issue.key.toLowerCase().includes(q)) {
      return false;
    }
    /* Filtered by column, not by raw status: the Status menu offers the
       board's columns, so picking New must keep the reopened issues drawn in
       New rather than hiding them. */
    /* Filtered by column *or* by the issue's own status. A column's name still
       selects everything drawn in it -- picking New keeps the reopened issues
       drawn in New, which is what it always did -- and Reopen and Reject can
       now be asked for on their own, which a column-only match could never
       express because neither is a column. */
    if (
      statusFilter.length &&
      !statusFilter.some(
        (value) => value === issue.status || value === boardColumnFor(issue.status),
      )
    ) {
      return false;
    }
    if (priorityFilter.length && !priorityFilter.includes(issue.priority)) return false;
    if (assigneeFilter.length) {
      const id = issue.assignee?.id ?? UNASSIGNED;
      /* "Admin" stands for a set of people rather than one, so it is resolved
         against the roster here; every other value is still a plain id. */
      const matches = assigneeFilter.some((value) =>
        value === ADMIN_ASSIGNEES ? adminIds.has(id) : value === id,
      );
      if (!matches) return false;
    }
    if (labelFilter.length) {
      /* Matched by name, not id. A label is project-scoped and unique by name
         within its project, so on one project's board this is exactly the id
         match it replaces — and on the all-projects board it is what lets a
         single "QA" entry mean QA in every project that has one, rather than
         one project's QA and a menu full of repeats. */
      const names = issue.labels.map(({ label }) => label.name);
      if (!labelFilter.some((name) => names.includes(name))) return false;
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
   *
   * `resolve` decides, per issue, what the move actually means. A drop asks
   * the column what it does with a card coming from that status; a pick from a
   * card's own status menu asks for one status exactly. Resolving per issue
   * rather than once for the whole batch is what lets a mixed selection land
   * correctly — dragging a Done card and an In Progress card onto New reopens
   * the first and moves the second, which is what each of them means.
   */
  function applyStatus(
    issueIds: string[],
    resolve: (from: IssueStatus) => IssueStatus | null,
    destination: string,
  ) {
    const candidates = issueIds
      .map((id) => issues.find((i) => i.id === id))
      .filter((issue): issue is (typeof issues)[number] => Boolean(issue));

    /*
     * The workflow decides what may land here, using the same rules as the
     * issue page's status menu and the server. Refusing the drop outright is
     * better than moving the card optimistically and watching it spring back
     * when `updateIssue` says no.
     */
    const planned = candidates.map((issue) => ({
      issue,
      to: resolve(issue.status),
    }));

    const moving = planned.filter(
      (plan): plan is { issue: (typeof candidates)[number]; to: IssueStatus } =>
        plan.to !== null && plan.to !== plan.issue.status,
    );

    const refused = planned.filter((plan) => plan.to === null);
    if (refused.length > 0) {
      const first = refused[0];
      toast(
        refused.length === 1 && first
          ? `${first.issue.key} cannot move straight from ${STATUS_LABEL[first.issue.status]} to ${destination}.`
          : `${refused.length} issues cannot move to ${destination} from where they are.`,
        "error",
      );
    }

    if (moving.length === 0) return;

    startTransition(async () => {
      for (const { issue, to } of moving) {
        moveIssue({ issueId: issue.id, status: to });
      }

      const results = await Promise.all(
        moving.map(({ issue, to }) => updateIssue({ issueId: issue.id, status: to })),
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

  /** A drop onto a column: the column decides what it means. */
  function move(issueIds: string[], column: IssueStatus) {
    applyStatus(
      issueIds,
      (from) => dropStatusFor(from, column),
      STATUS_LABEL[column],
    );
  }

  /**
   * A pick from a card's own status menu: exactly the status chosen.
   *
   * No workflow gate, deliberately — this is the same contract the issue
   * page's status menu has. `STATUS_TRANSITIONS` describes the ordinary path
   * and is what drag and drop follows, but choosing a status outright is a
   * decision a person is allowed to make, and the server accepts it.
   */
  function setCardStatus(issueId: string, status: IssueStatus) {
    applyStatus([issueId], () => status, STATUS_LABEL[status]);
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

  /* Asks exactly what the drop will ask, so the no-entry cursor and the drop
     can never disagree: a column takes a card if it has *any* status it can
     put it in, its own or the one it also holds. */
  const columnAccepts = (column: IssueStatus): boolean =>
    draggingStatuses.length === 0 ||
    draggingStatuses.some((from) => dropStatusFor(from, column) !== null);

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
              {/*
               * The board reached from the sidebar is every project's, and
               * this is the way back to it — and the way in, for anyone who
               * arrived on a single project's board. It is what "All
               * Projects" is selected as on `/board`, so the control always
               * names the board being looked at.
               */}
              <MenuItem
                href="/board"
                selected={project === null}
                icon={
                  <span className="prio-project-chip" aria-hidden>
                    ALL
                  </span>
                }
              >
                All Projects
              </MenuItem>
              <MenuSeparator />
              {allProjects.map((p) => (
                <MenuItem
                  key={p.id}
                  href={`/projects/${p.key.toLowerCase()}/board`}
                  selected={p.id === project?.id}
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

            {/* Every status, not only the seven that are columns. Picking a
                column's name still selects everything drawn in that column,
                exactly as before; Reopen and Reject are additionally
                selectable on their own, which naming a column could never
                do. */}
            <ToolbarMenu label="Status" count={statusFilter.length}>
              {ISSUE_STATUSES.map((status) => (
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

              {/*
               * "Assigned to me" leads the list, for everybody.
               *
               * This is the Issues bar's own convention, reused rather than
               * re-invented: `IssueFilters` offers `{ value: currentUserId,
               * node: "Assigned to me" }` first, then Unassigned, then
               * everyone *except* the viewer by name. The label is the only
               * thing that differs from a person's entry — the value carried
               * is `currentUserId`, the same id their name would have carried,
               * so filtering, multi-select and the tick are untouched. There
               * is no second current-user mechanism here and no name is
               * hard-coded: `currentUserId` is the session's own id, handed
               * down by the board's page.
               *
               * A member sees roles rather than colleagues below this —
               * Unassigned and Admin — while an administrator sees the roster.
               * Only the options differ; the control is the same in both.
               */}
              <MenuItem
                keepOpen
                selected={assigneeFilter.includes(currentUserId)}
                onSelect={() =>
                  setAssigneeFilter((prev) => toggleValue(prev, currentUserId))
                }
                icon={<Avatar name={null} empty size="xs" />}
              >
                Assigned to me
              </MenuItem>

              <MenuItem
                keepOpen
                selected={assigneeFilter.includes(UNASSIGNED)}
                onSelect={() => setAssigneeFilter((prev) => toggleValue(prev, UNASSIGNED))}
                icon={<Avatar name={null} empty size="xs" />}
              >
                Unassigned
              </MenuItem>

              {/* Offered only when an administrator could actually hold work
                  here — an empty bucket is a filter that can only ever return
                  nothing. */}
              {!isAdmin && adminIds.size > 0 ? (
                <MenuItem
                  keepOpen
                  selected={assigneeFilter.includes(ADMIN_ASSIGNEES)}
                  onSelect={() =>
                    setAssigneeFilter((prev) => toggleValue(prev, ADMIN_ASSIGNEES))
                  }
                  icon={<Avatar name={null} empty size="xs" />}
                >
                  Admin
                </MenuItem>
              ) : null}

              {/* Everyone else by name. The viewer is filtered out because
                  "Assigned to me" above already carries their id — listing
                  them again would put the same filter on the menu twice, once
                  under a label and once under a name. */}
              {isAdmin
                ? members
                    .filter((member) => member.id !== currentUserId)
                    .map((member) => (
                      <MenuItem
                        key={member.id}
                        keepOpen
                        selected={assigneeFilter.includes(member.id)}
                        onSelect={() =>
                          setAssigneeFilter((prev) => toggleValue(prev, member.id))
                        }
                        icon={<Avatar name={member.name} image={member.image} size="xs" />}
                      >
                        {member.name}
                      </MenuItem>
                    ))
                : null}
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
                    selected={labelFilter.includes(label.name)}
                    onSelect={() => setLabelFilter((prev) => toggleValue(prev, label.name))}
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
                      onStatusChange={(next) => setCardStatus(issue.id, next)}
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
  onStatusChange,
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
  /** Sets this issue's status outright, without moving it by hand. */
  onStatusChange: (status: IssueStatus) => void;
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

        {/*
         * The card's own status, and the way to change it.
         *
         * It used to appear only when the grouping was something other than
         * status, on the reasoning that a column already says what its cards
         * are. That holds only while a column has one status in it: New also
         * holds Reopen and Done also holds Reject / Not an Issue, so a card in
         * either column said nothing about which of the two it was. Showing it
         * always is what makes a reopened issue recognisable as reopened
         * rather than merely as something in New.
         *
         * The same guards the card menu above uses -- `draggable={false}` and
         * a stopped propagation -- so reaching for the status never starts a
         * drag.
         */}
        <div
          className="prio-board__card-status"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Menu
            align="end"
            width={210}
            label={`Change status of ${issue.key}`}
            trigger={(props) => (
              <button
                type="button"
                className="prio-board__card-statustrigger"
                draggable={false}
                {...props}
              >
                <StatusPill status={issue.status} />
                <IconChevronDown size={11} />
              </button>
            )}
          >
            <MenuLabel>Move to</MenuLabel>
            {/* The whole vocabulary, the same set and the same order the issue
                page's own status menu offers -- Reopen and Reject / Not an
                Issue included, because both are statuses an issue may hold. */}
            {ISSUE_STATUSES.map((option) => (
              <MenuItem
                key={option}
                selected={option === issue.status}
                onSelect={() =>
                  option !== issue.status && onStatusChange(option)
                }
              >
                <StatusPill status={option} />
              </MenuItem>
            ))}
          </Menu>
        </div>

        {issue.assignee ? (
          <Avatar name={issue.assignee.name} image={issue.assignee.image} />
        ) : null}
      </div>
    </div>
  );
}
