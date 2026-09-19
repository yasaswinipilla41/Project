import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody, EmptyState, Stat } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconCalendar,
  IconCheck,
  IconEmptyBox,
  IconMyWork,
  IconWarning,
} from "@/components/ui/Icon";
import { issueScope } from "@/lib/authz";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  TEST_RESULT_LABEL,
} from "@/lib/domain";
import { formatDateCompact, isOverdue } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { completedByFilter } from "@/server/queries/completedWork";
import { dueThisWeekFilter, overdueFilter } from "@/server/queries/due";
import { requireUser } from "@/lib/session";
import type { IssueStatus, IssueType, Prisma, Priority } from "@prisma/client";

export const metadata: Metadata = { title: "My Work" };
export const dynamic = "force-dynamic";

/**
 * Everything assigned to the signed-in user, grouped by workflow status so the
 * next thing to pick up is obvious.
 *
 * One rule decides what is on this page, and every figure and every list obeys
 * it:
 *
 *     assigned to me   AND   in a project I may open
 *
 * `assignedWhere` below *is* that rule — `issueScope(user)` for the second
 * half and `assigneeId: user.id` for the first — and everything else is that
 * fragment with a category added. So a count and the rows beneath it cannot
 * describe different sets: they are the same query asked twice.
 *
 * The first half used to be missing in three places, and each one put somebody
 * else's work on a page called My Work:
 *
 *  - **Waiting for testing** listed what other people had handed over,
 *    `NOT assigneeId`. It is gone from here altogether now: it was the same
 *    workflow state as Ready for QA, which already has its own card below.
 *  - **Reported by me, assigned to someone else** was, by its own name, other
 *    people's assignments. Raising an issue is not being given it. It is gone
 *    from here; `/issues?reporter=<id>` is where that question is answered.
 *  - **Project work** was a whole project's issue table for anybody on the
 *    Testing team. Belonging to a project is not being handed its work. The
 *    project's own List and Board views still show it.
 *
 * `user` comes from `requireUser()` — the server session — and nothing on this
 * page reads an identity, a project or a filter from the URL. There is no
 * parameter to change: the query is built from who the request is
 * authenticated as, and the database applies it.
 */
/**
 * The four figures, and the one of them whose list is showing.
 *
 * The tiles used to be links to `/issues?assignee=<me>` — pressing Completed
 * left My Work for the global list, which then had to be told who "me" was in
 * its own query string. The question belongs here, so the answer does too: the
 * tile chooses which list sits beneath it and the page stays where it was.
 *
 * Held in the URL rather than in component state, for the same reason the
 * issue table's sort is: this page is server-rendered, a chosen tile survives
 * a refresh and a back button, and the list works with no JavaScript at all.
 */
const TABS = ["open", "completed", "overdue", "dueWeek"] as const;
type Tab = (typeof TABS)[number];

function tabOf(raw: string | string[] | undefined): Tab {
  const wanted = Array.isArray(raw) ? raw[0] : raw;
  return (TABS as readonly string[]).includes(wanted ?? "")
    ? (wanted as Tab)
    : "open";
}

/**
 * How many rows a list other than Open shows at once.
 *
 * Open is one person's current workload and is shown whole. The other three
 * are historical or forward-looking and have no natural end — a year of
 * completed work is not a list anybody reads to the bottom of. The figure on
 * the tile is counted separately and is never this number, so the count stays
 * the truth about how much there is.
 */
const LIST_LIMIT = 50;

/** One issue as this page draws it, in whichever list it appears. */
interface WorkRowData {
  id: string;
  key: string;
  type: IssueType;
  title: string;
  status: IssueStatus;
  priority: Priority;
  dueDate: Date | null;
  project: { key: string; name: string };
}

/**
 * A row in any of the four lists.
 *
 * Extracted so the chosen tile's list is the same row the Open list has always
 * drawn — a second, slightly different row would be the beginning of two ideas
 * of what an issue looks like here.
 */
function WorkRow({ issue, showStatus }: { issue: WorkRowData; showStatus?: boolean }) {
  const overdue = isOverdue(issue.dueDate, false);

  return (
    <Link
      href={`/issues/${issue.key.toLowerCase()}`}
      className="prio-worklink"
    >
      <IssueTypeIcon type={issue.type} size={17} />
      <span className="prio-worklink__body">
        <span className="prio-worklink__title prio-truncate">{issue.title}</span>
        <span className="prio-worklink__meta">
          <IssueKey issueKey={issue.key} />
          <span className="prio-text-muted">{issue.project.name}</span>
          {showStatus ? <StatusPill status={issue.status} /> : null}
          {issue.dueDate ? (
            <span className={overdue ? "prio-due--overdue" : "prio-text-muted"}>
              {overdue ? "Overdue " : "Due "}
              {formatDateCompact(issue.dueDate)}
            </span>
          ) : null}
        </span>
      </span>
      <span className="prio-worklink__right">
        <PriorityIndicator priority={issue.priority} showLabel={false} />
      </span>
    </Link>
  );
}

export default async function MyWorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const scope = issueScope(user);
  const tab = tabOf((await searchParams).show);
  /*
   * One clock reading for the whole page, handed to the due fragments so
   * every bucket on it describes the same instant.
   *
   * This used to be a local `dueWindow` of this page's own — "due this week"
   * meant the next seven days from now, while the tile linked to a list that
   * cut the calendar week. Two definitions, one number, and they disagreed by
   * however far into the week today happened to be.
   */
  const now = new Date();

  const assignedWhere = {
    ...scope,
    assigneeId: user.id,
    status: { in: [...OPEN_STATUSES] },
  };

  /*
   * One where-clause per tile, and each is the only definition of its figure.
   *
   * The tile counts it and the list beneath it selects it, so a count and its
   * own rows cannot describe different sets — which is the whole reason the
   * lists live here rather than on a page that would have to be told who to
   * ask about.
   *
   * Overdue and Due this week are composed with `AND` rather than by spreading
   * the fragment over `assignedWhere`. Spreading overwrote `status`: the open
   * restriction was replaced by the fragment's own, and the two only agreed
   * because the open statuses happen to be exactly the not-closed ones today.
   * The next status added to the model would have parted them silently.
   */
  const WHERE: Record<Tab, Prisma.IssueWhereInput> = {
    open: assignedWhere,
    /* Not `assigneeId`: finished work is whoever finished it, which the
       activity trail knows and the current holder does not. */
    completed: { ...scope, ...completedByFilter([user.id]) },
    overdue: {
      ...scope,
      assigneeId: user.id,
      AND: [{ status: { in: [...OPEN_STATUSES] } }, overdueFilter(now)],
    },
    dueWeek: {
      ...scope,
      assigneeId: user.id,
      AND: [{ status: { in: [...OPEN_STATUSES] } }, dueThisWeekFilter(now)],
    },
  };

  /** Everything a row on this page draws, whichever list it is in. */
  const rowSelect = {
    id: true,
    key: true,
    type: true,
    title: true,
    status: true,
    priority: true,
    dueDate: true,
    updatedAt: true,
    project: { select: { key: true, name: true } },
  } satisfies Prisma.IssueSelect;

  const [
    assigned,
    overdueCount,
    dueSoonCount,
    completedCount,
    handedBack,
  ] = await Promise.all([
      prisma.issue.findMany({
        where: assignedWhere,
        orderBy: [{ priority: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
        select: rowSelect,
      }),
      /*
       * Overdue and Due this week, from the fragments every other surface
       * counts with.
       *
       * These two used to be written here by hand — overdue from this
       * instant, and "this week" as a rolling seven days from now. The tile
       * linked to `dueWeek=1`, which cuts the calendar week, so the number and
       * the list it opened were answering two different questions and could
       * not agree. There is one answer now, in `queries/due`.
       */
      prisma.issue.count({ where: WHERE.overdue }),
      prisma.issue.count({ where: WHERE.dueWeek }),

      /*
       * Completed, for this person.
       *
       * The same fragment the list beneath the tile selects on, so the number
       * and the rows cannot disagree. See `completedByFilter` for what makes
       * finished work somebody's own — it is the trail, not the current
       * holder, because work reassigned after it was finished was still
       * finished by whoever finished it.
       */
      prisma.issue.count({ where: WHERE.completed }),

      // Their own work that QA has handed back: the developer's queue.
      prisma.issue.findMany({
        where: {
          ...scope,
          assigneeId: user.id,
          testResult: { in: ["FAILED", "BLOCKED"] },
          status: { notIn: [...CLOSED_STATUSES] },
        },
        orderBy: [{ priority: "asc" }, { testedAt: "desc" }],
        take: 10,
        select: {
          id: true,
          key: true,
          type: true,
          title: true,
          priority: true,
          testResult: true,
          testedAt: true,
          project: { select: { name: true } },
          testedBy: { select: { name: true } },
        },
      }),
    ]);

  /*
   * The rows for the chosen tile, selected with that tile's own where-clause.
   *
   * Open is already loaded whole above — it is the page's own subject and the
   * status grouping needs all of it. The other three are loaded only when
   * their tile is the chosen one, so choosing a tile costs one query rather
   * than the page costing four.
   */
  const chosen =
    tab === "open"
      ? []
      : await prisma.issue.findMany({
          where: WHERE[tab],
          orderBy:
            tab === "completed"
              ? [{ completedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }]
              : [{ dueDate: { sort: "asc", nulls: "last" } }, { priority: "asc" }],
          take: LIST_LIMIT,
          select: rowSelect,
        });

  const counts: Record<Tab, number> = {
    open: assigned.length,
    completed: completedCount,
    overdue: overdueCount,
    dueWeek: dueSoonCount,
  };

  const TAB_TITLE: Record<Tab, string> = {
    open: "Open",
    completed: "Completed by me",
    overdue: "Overdue",
    dueWeek: "Due this week",
  };

  const EMPTY_TITLE: Record<Tab, string> = {
    open: "Nothing assigned to you",
    completed: "Nothing finished yet",
    overdue: "Nothing overdue",
    dueWeek: "Nothing due this week",
  };

  const EMPTY_BODY: Record<Tab, string> = {
    open: "When someone assigns you an issue or a bug it will appear here.",
    completed:
      "Work you move to Done — or hand to testing and testing passes — is counted here, even if somebody else holds it now.",
    overdue: "Nothing assigned to you is past its due date.",
    dueWeek: "Nothing assigned to you falls due before the week is out.",
  };

  /** Where a tile points: this page, with that tile chosen. */
  const tabHref = (which: Tab) =>
    which === "open" ? "/my-work" : `/my-work?show=${which}`;

  // Group in memory: this is one person's open work, not a large set.
  const byStatus = new Map<IssueStatus, typeof assigned>();
  for (const status of OPEN_STATUSES) byStatus.set(status, []);
  for (const issue of assigned) {
    byStatus.get(issue.status)?.push(issue);
  }

  const firstName = user.name.split(" ")[0] ?? user.name;

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconMyWork />
            My Work
          </h1>
          <p className="prio-page-header__subtitle">
            {assigned.length === 0
              ? `Nothing is assigned to you right now, ${firstName}.`
              : `${assigned.length} open ${assigned.length === 1 ? "item" : "items"} assigned to you.`}
          </p>
        </div>
      </div>

      {/*
        * The four figures, each choosing the list below it.
        *
        * Every tile stays a link, so the keyboard, the back button and a
        * middle click all still work and the page needs no JavaScript to
        * change what it shows — it is the destination that changed, from the
        * global issue list to this page with a different tile chosen.
        */}
      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-6 col-xl-3">
          <Stat
            label="Open"
            value={counts.open}
            tone="brand"
            hint="Assigned to me"
            href={tabHref("open")}
            selected={tab === "open"}
            pendingIndicator
          />
        </div>
        <div className="col-6 col-xl-3">
          {/* Where Bugs used to be. Completed work is the other half of the
              answer to "what is mine", and it is this person's alone — the
              list is filtered on who the session says they are. */}
          <Stat
            label="Completed"
            value={counts.completed}
            icon={<IconCheck size={13} />}
            tone={counts.completed > 0 ? "success" : "default"}
            hint="Completed by me"
            href={tabHref("completed")}
            selected={tab === "completed"}
            pendingIndicator
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Overdue"
            value={counts.overdue}
            icon={<IconWarning size={13} />}
            tone={counts.overdue > 0 ? "danger" : "default"}
            hint="Past their due date"
            href={tabHref("overdue")}
            selected={tab === "overdue"}
            pendingIndicator
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Due this week"
            value={counts.dueWeek}
            icon={<IconCalendar size={13} />}
            tone={counts.dueWeek > 0 ? "warning" : "default"}
            hint="Due before the week is out"
            href={tabHref("dueWeek")}
            selected={tab === "dueWeek"}
            pendingIndicator
          />
        </div>
      </div>

      {/* ------------------------------------------------ QA collaboration */}
      {/* Shown only when there is something to act on, so the page stays a
          to-do list rather than a wall of empty sections — and only beside
          the open work it is about. */}
      {tab === "open" && handedBack.length > 0 ? (
        <div className="row g-4" style={{ marginBottom: "var(--prio-space-4)" }}>
          {handedBack.length > 0 ? (
            <div className="col-12 col-xl-6">
              <Card style={{ height: "100%" }}>
                <CardBody>
                  <h2 className="prio-issue__section-title">
                    Testing sent this back
                    <span className="prio-text-muted">{handedBack.length}</span>
                  </h2>
                  {handedBack.map((issue) => (
                    <Link
                      key={issue.id}
                      href={`/issues/${issue.key.toLowerCase()}`}
                      className="prio-worklink"
                    >
                      <IssueTypeIcon type={issue.type} size={17} />
                      <span className="prio-worklink__body">
                        <span className="prio-worklink__title prio-truncate">
                          {issue.title}
                        </span>
                        <span className="prio-worklink__meta">
                          <IssueKey issueKey={issue.key} />
                          <span
                            className="prio-testresult"
                            data-result={issue.testResult}
                          >
                            {TEST_RESULT_LABEL[issue.testResult]}
                          </span>
                          {issue.testedBy ? (
                            <span className="prio-text-muted">
                              by {issue.testedBy.name}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <PriorityIndicator priority={issue.priority} showLabel={false} />
                    </Link>
                  ))}
                </CardBody>
              </Card>
            </div>
          ) : null}

        </div>
      ) : null}

      {/*
        * One list at a time, and it is the chosen tile's.
        *
        * Open keeps its status grouping — it is a queue, and which column the
        * work is in is the first thing somebody wants from it. The other three
        * are one flat list each: a set defined by a date or by history has no
        * useful grouping, only an order.
        */}
      {tab === "open" ? (
        assigned.length === 0 ? (
          <Card>
            <EmptyState
              icon={<IconEmptyBox />}
              title="Nothing assigned to you"
              body="When someone assigns you an issue or a bug it will appear here, grouped by status."
            />
          </Card>
        ) : (
          <div className="row g-4">
            {OPEN_STATUSES.map((status) => {
              const items = byStatus.get(status) ?? [];
              if (items.length === 0) return null;

              return (
                <div key={status} className="col-12 col-xl-6">
                  <Card style={{ height: "100%" }}>
                    <CardBody>
                      <h2 className="prio-issue__section-title">
                        <StatusPill status={status} />
                        <span className="prio-text-muted">{items.length}</span>
                      </h2>

                      {items.map((issue) => (
                        <WorkRow key={issue.id} issue={issue} />
                      ))}
                    </CardBody>
                  </Card>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <Card>
          <CardBody>
            <h2 className="prio-issue__section-title">
              {TAB_TITLE[tab]}
              <span className="prio-text-muted">{counts[tab]}</span>
            </h2>

            {chosen.length === 0 ? (
              <EmptyState
                icon={<IconEmptyBox />}
                title={EMPTY_TITLE[tab]}
                body={EMPTY_BODY[tab]}
              />
            ) : (
              <>
                {chosen.map((issue) => (
                  <WorkRow key={issue.id} issue={issue} showStatus />
                ))}

                {/* The figure above counts everything; this list is capped.
                    Said plainly, so a reader is never left working out why
                    the number and the rows differ. */}
                {counts[tab] > chosen.length ? (
                  <p className="prio-text-muted" style={{ marginTop: "var(--prio-space-3)" }}>
                    Showing the first {chosen.length} of {counts[tab]}.
                  </p>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}
