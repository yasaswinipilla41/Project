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
import type { IssueStatus } from "@prisma/client";

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
export default async function MyWorkPage() {
  const user = await requireUser();
  const scope = issueScope(user);
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

  const [
    assigned,
    overdueCount,
    dueSoonCount,
    resolvedCount,
    completedCount,
    handedBack,
  ] = await Promise.all([
      prisma.issue.findMany({
        where: assignedWhere,
        orderBy: [{ priority: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
        select: {
          id: true,
          key: true,
          type: true,
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          updatedAt: true,
          project: { select: { key: true, name: true } },
        },
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
      prisma.issue.count({ where: { ...assignedWhere, ...overdueFilter(now) } }),
      prisma.issue.count({
        where: { ...assignedWhere, ...dueThisWeekFilter(now) },
      }),
      prisma.issue.count({
        where: {
          ...scope,
          assigneeId: user.id,
          status: { in: [...CLOSED_STATUSES] },
        },
      }),

      /*
       * Completed, for this person.
       *
       * The same fragment the list behind the tile filters on
       * (`completedBy=<id>`), so the number and the rows it opens cannot
       * disagree. Scoped like everything else on the page; see
       * `completedByFilter` for what makes finished work somebody's own.
       */
      prisma.issue.count({
        where: { ...scope, ...completedByFilter([user.id]) },
      }),

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

      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-6 col-xl-3">
          <Stat
            label="Open"
            value={assigned.length}
            tone="brand"
            hint="Assigned to me"
            href={`/issues?assignee=${user.id}&resolution=open`}
          />
        </div>
        <div className="col-6 col-xl-3">
          {/* Where Bugs used to be. Completed work is the other half of the
              answer to "what is mine", and it is this person's alone — the
              list it opens is filtered on who the session says they are. */}
          <Stat
            label="Completed"
            value={completedCount}
            icon={<IconCheck size={13} />}
            tone={completedCount > 0 ? "success" : "default"}
            hint="Completed by me"
            href={`/issues?completedBy=${user.id}`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Overdue"
            value={overdueCount}
            icon={<IconWarning size={13} />}
            tone={overdueCount > 0 ? "danger" : "default"}
            hint="Past their due date"
            href={`/issues?assignee=${user.id}&resolution=open&overdue=1`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Due this week"
            value={dueSoonCount}
            icon={<IconCalendar size={13} />}
            tone={dueSoonCount > 0 ? "warning" : "default"}
            hint={`${resolvedCount} completed all time`}
            href={`/issues?assignee=${user.id}&resolution=open&dueWeek=1&sort=due&dir=asc`}
          />
        </div>
      </div>

      {/* ------------------------------------------------ QA collaboration */}
      {/* Shown only when there is something to act on, so the page stays a
          to-do list rather than a wall of empty sections. */}
      {handedBack.length > 0 ? (
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

      {assigned.length === 0 ? (
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

                    {items.map((issue) => {
                      const overdue = isOverdue(issue.dueDate, false);
                      return (
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
                              <span className="prio-text-muted">
                                {issue.project.name}
                              </span>
                              {issue.dueDate ? (
                                <span
                                  className={
                                    overdue ? "prio-due--overdue" : "prio-text-muted"
                                  }
                                >
                                  {overdue ? "Overdue " : "Due "}
                                  {formatDateCompact(issue.dueDate)}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <span className="prio-worklink__right">
                            <PriorityIndicator
                              priority={issue.priority}
                              showLabel={false}
                            />
                          </span>
                        </Link>
                      );
                    })}
                  </CardBody>
                </Card>
              </div>
            );
          })}

        </div>
      )}
    </>
  );
}
