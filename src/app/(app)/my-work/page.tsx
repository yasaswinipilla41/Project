import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody, EmptyState, Stat } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  SeverityChip,
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
import { requireUser } from "@/lib/session";
import type { IssueStatus } from "@prisma/client";

export const metadata: Metadata = { title: "My Work" };
export const dynamic = "force-dynamic";

/**
 * Everything assigned to the signed-in user, grouped by workflow status so the
 * next thing to pick up is obvious.
 */
/**
 * Reference timestamps for the "overdue" and "due this week" buckets. Kept out
 * of the component body so the render does not read the clock.
 */
function dueWindow(): { now: Date; weekAhead: Date } {
  const now = new Date();
  return { now, weekAhead: new Date(now.getTime() + 7 * 86_400_000) };
}

export default async function MyWorkPage() {
  const user = await requireUser();
  const scope = issueScope(user);
  const { now, weekAhead } = dueWindow();

  const assignedWhere = {
    ...scope,
    assigneeId: user.id,
    status: { in: [...OPEN_STATUSES] },
  };

  const [
    assigned,
    reported,
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
          severity: true,
          dueDate: true,
          updatedAt: true,
          project: { select: { key: true, name: true } },
        },
      }),
      prisma.issue.findMany({
        where: {
          ...scope,
          reporterId: user.id,
          status: { in: [...OPEN_STATUSES] },
          NOT: { assigneeId: user.id },
        },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: {
          id: true,
          key: true,
          type: true,
          title: true,
          status: true,
          priority: true,
          assignee: { select: { name: true } },
        },
      }),
      prisma.issue.count({
        where: { ...assignedWhere, dueDate: { lt: now } },
      }),
      prisma.issue.count({
        where: {
          ...assignedWhere,
          dueDate: { gte: now, lte: weekAhead },
        },
      }),
      prisma.issue.count({
        where: {
          ...scope,
          assigneeId: user.id,
          status: { in: [...CLOSED_STATUSES] },
        },
      }),

      /*
       * The two QA-shaped questions this page could not answer before.
       *
       * Both reuse `scope`, so they can only ever surface issues this person
       * could already open — this is a different slice of the same authorized
       * set, not a new source of data.
       */

      // Submitted by somebody else and not yet judged: the tester's queue.
      // Excludes their own work, because nobody signs off their own.
      prisma.issue.findMany({
        where: {
          ...scope,
          status: "IN_REVIEW",
          testResult: "NOT_TESTED",
          NOT: { assigneeId: user.id },
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
          assignee: { select: { name: true } },
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
          <Stat label="Open" value={assigned.length} tone="brand" hint="Assigned to me" />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Bugs"
            value={bugCount}
            icon={<IconBug size={13} />}
            tone={bugCount > 0 ? "danger" : "default"}
            hint="Open, assigned to me"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Overdue"
            value={overdueCount}
            icon={<IconWarning size={13} />}
            tone={overdueCount > 0 ? "danger" : "default"}
            hint="Past their due date"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Due this week"
            value={dueSoonCount}
            icon={<IconCalendar size={13} />}
            tone={dueSoonCount > 0 ? "warning" : "default"}
            hint={`${resolvedCount} completed all time`}
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
                          {issue.assignee ? (
                            <span className="prio-text-muted">
                              from {issue.assignee.name}
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
                            {issue.severity ? (
                              <SeverityChip severity={issue.severity} />
                            ) : null}
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

          {reported.length > 0 ? (
            <div className="col-12">
              <Card>
                <CardBody>
                  <h2 className="prio-issue__section-title">
                    Reported by me, assigned to someone else
                  </h2>
                  {reported.map((issue) => (
                    <Link
                      key={issue.id}
                      href={`/issues/${issue.key.toLowerCase()}`}
                      className="prio-relatedrow"
                    >
                      <IssueTypeIcon type={issue.type} size={17} />
                      <IssueKey issueKey={issue.key} />
                      <span className="prio-relatedrow__title prio-truncate">
                        {issue.title}
                      </span>
                      <span className="prio-text-muted">
                        {issue.assignee?.name ?? "Unassigned"}
                      </span>
                      <StatusPill status={issue.status} />
                    </Link>
                  ))}
                </CardBody>
              </Card>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
