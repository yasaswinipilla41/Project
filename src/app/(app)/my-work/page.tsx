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
  IconBug,
  IconCalendar,
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
 *    `NOT assigneeId`. It now lists work handed to *this* person.
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
    waitingForTesting,
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
       * The two QA-shaped questions, both of them about this person's own
       * work: what they have handed over and are waiting on, and what came
       * back. Neither is a project queue.
       */

      /*
       * Handed to this person and not yet judged.
       *
       * It used to be the opposite — `NOT assigneeId`, every issue in reach
       * that somebody *else* had submitted, on the strength of the reader
       * being on the Testing team. That is a project queue, and this page is
       * not one: it put other people's work under a heading that says My Work,
       * and the count beside it counted other people's work too.
       *
       * The category is unchanged: Ready for QA, no verdict yet. Only who
       * qualifies changed, which is the whole of what was wrong.
       */
      prisma.issue.findMany({
        where: {
          ...assignedWhere,
          status: "IN_REVIEW",
          testResult: "NOT_TESTED",
        },
        orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
        take: 10,
        select: {
          id: true,
          key: true,
          type: true,
          title: true,
          priority: true,
          updatedAt: true,
          project: { select: { name: true } },
        },
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

  const bugCount = assigned.filter((i) => i.type === "BUG").length;

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
          <Stat
            label="Bugs"
            value={bugCount}
            icon={<IconBug size={13} />}
            tone={bugCount > 0 ? "danger" : "default"}
            hint="Open, assigned to me"
            href={`/issues?assignee=${user.id}&resolution=open&type=BUG`}
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
      {handedBack.length > 0 || waitingForTesting.length > 0 ? (
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

          {waitingForTesting.length > 0 ? (
            <div className="col-12 col-xl-6">
              <Card style={{ height: "100%" }}>
                <CardBody>
                  <h2 className="prio-issue__section-title">
                    Waiting for testing
                    <span className="prio-text-muted">
                      {waitingForTesting.length}
                    </span>
                  </h2>
                  {waitingForTesting.map((issue) => (
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
                          {/* The holder is the reader, so naming them here
                              would only ever say "from yourself". */}
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
