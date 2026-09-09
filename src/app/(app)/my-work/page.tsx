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
import {
  accessibleProjectIds,
  isTeamMember,
  issueScope,
  workRoleOf,
  TESTING_TEAM_SLUG,
} from "@/lib/authz";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  TEST_RESULT_LABEL,
} from "@/lib/domain";
import { formatDateCompact, isOverdue } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { dueThisWeekFilter, overdueFilter } from "@/server/queries/due";
import { requireUser } from "@/lib/session";
import {
  listIssues,
  loadIssueProgress,
  SORT_FIELDS,
  type SortField,
} from "@/server/queries/issues";
import {
  ProjectWorkTable,
  type WorkTableRow,
} from "@/components/work/ProjectWorkTable";
import { ProjectWorkPicker } from "@/components/work/ProjectWorkPicker";
import type { IssueStatus } from "@prisma/client";

export const metadata: Metadata = { title: "My Work" };
export const dynamic = "force-dynamic";

/**
 * Everything assigned to the signed-in user, grouped by workflow status so the
 * next thing to pick up is obvious.
 */
export default async function MyWorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
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

  /*
   * The project work table belongs to the Testing team.
   *
   * The check is here, on the server, before anything is queried — not a
   * hidden element in the markup. Somebody who is not on the team gets no
   * table, no rows, and nothing extra in the payload, whatever they put in the
   * URL. Being an administrator is deliberately not enough: administering Prio
   * and being on the testing team are different claims.
   */
  const onTestingTeam = await isTeamMember(user, TESTING_TEAM_SLUG);
  const workRole = await workRoleOf(user);

  /* Project access is still the ordinary rule. Team membership decides whether
     this view exists at all; it grants access to no project on its own, so the
     picker only ever lists projects the person could already open. */
  const workProjects = onTestingTeam
    ? await prisma.project.findMany({
        where: {
          isArchived: false,
          id: { in: await accessibleProjectIds(user) },
        },
        select: { id: true, key: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const requestedProject = one(params.project);
  const selectedProject =
    workProjects.find((p) => p.id === requestedProject) ?? null;

  const rawSort = one(params.sort);
  const workSort: SortField = (SORT_FIELDS as readonly string[]).includes(
    rawSort ?? "",
  )
    ? (rawSort as SortField)
    : "updated";
  const workDir = one(params.dir) === "asc" ? "asc" : "desc";

  const workList = selectedProject
    ? await listIssues(user, {
        projectIds: [selectedProject.id],
        sort: workSort,
        dir: workDir,
        pageSize: 100,
      })
    : null;

  const workProgress = workList
    ? await loadIssueProgress(workList.rows.map((r) => r.id))
    : new Map<string, { done: number; total: number }>();

  const workDescriptions = workList
    ? new Map(
        (
          await prisma.issue.findMany({
            where: { id: { in: workList.rows.map((r) => r.id) } },
            select: { id: true, description: true },
          })
        ).map((row) => [row.id, row.description]),
      )
    : new Map<string, string | null>();

  const workRows: WorkTableRow[] = (workList?.rows ?? []).map((row) => ({
    ...row,
    progress: workProgress.get(row.id) ?? null,
    description: workDescriptions.get(row.id) ?? null,
  }));

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

      {/* ------------------------------------------- project work table */}
      {/* Rendered only for the team that owns it. A non-member's page does not
          contain this markup at all — there is nothing here to reveal. */}
      {onTestingTeam ? (
        <Card style={{ marginBottom: "var(--prio-space-4)" }}>
          <CardBody>
            <div className="prio-projectmembers__head">
              <h2 className="prio-issue__section-title">Project work</h2>
              {selectedProject ? (
                <span className="prio-text-muted">
                  {workRows.length} item{workRows.length === 1 ? "" : "s"} in{" "}
                  {selectedProject.name}
                </span>
              ) : null}
            </div>

            <ProjectWorkPicker
              projects={workProjects}
              selectedId={selectedProject?.id ?? null}
              basePath="/my-work"
            />

            {selectedProject ? (
              <div style={{ marginTop: "var(--prio-space-4)" }}>
                <ProjectWorkTable
                  rows={workRows}
                  basePath="/my-work"
                  searchParams={params}
                  sort={workSort}
                  dir={workDir}
                  currentUserId={user.id}
                  isAdmin={user.role === "ADMIN"}
                  workRole={workRole}
                />
              </div>
            ) : workProjects.length > 0 ? (
              <p className="prio-text-muted" style={{ marginTop: "var(--prio-space-4)" }}>
                Choose a project to see its work items.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

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
