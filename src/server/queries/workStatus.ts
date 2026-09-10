import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  accessibleProjectIds,
  DEVELOPMENT_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  workRoleFromTeams,
} from "@/lib/authz";
import {
  laneAcceptsWorkRole,
  WORK_LANE_STATUSES,
  type WorkLane,
  type WorkStatusData,
  type WorkStatusIssue,
  type WorkStatusLane,
  type WorkStatusMember,
  type WorkStatusProject,
} from "@/lib/workLanes";
import type { CurrentUser } from "@/lib/session";

/**
 * Work Status, as queries.
 *
 * What a lane *is* — its statuses, its label, who may be given its work — is in
 * `lib/workLanes`, because the card that draws it runs in the browser and this
 * module imports Prisma. Here is only the reading: the counts Admin Home shows,
 * the projects it offers, and the issues and people inside one of them.
 *
 * Every one of them composes `WORK_LANE_STATUSES` rather than repeating it, so
 * a number and the list it opens are the same question asked twice.
 */

/**
 * Somebody who does *not* do this lane's half of the job, as a filter on User.
 *
 * The negation of `doesQaWork` / `doesDeveloperWork`, written in the two facts
 * those are derived from — the account role and the team rows — because the
 * question is being asked of a column in a query rather than of a value in
 * hand. An administrator does everything and is therefore never one of these.
 *
 *   not QA work         a MEMBER who is not on Testing
 *   not developer work  a MEMBER who is on Testing and not on Development
 *
 * The second reads oddly until you remember the long-standing default: a
 * member on neither team is a developer, so the only member who does not build
 * is one who is explicitly on Testing alone.
 */
function doesNotDoLaneWork(lane: WorkLane): Prisma.UserWhereInput {
  const onTesting = {
    teamMemberships: { some: { team: { slug: TESTING_TEAM_SLUG } } },
  };
  const onDevelopment = {
    teamMemberships: { some: { team: { slug: DEVELOPMENT_TEAM_SLUG } } },
  };

  if (lane === "QA") return { role: "MEMBER", NOT: onTesting };
  return { role: "MEMBER", ...onTesting, NOT: onDevelopment };
}

/**
 * The Prisma fragment for work a lane is still waiting to hand out.
 *
 * Two halves, and both are needed:
 *
 *  - **the status.** Ready for QA for one lane; New, Reopen or Backlog for the
 *    other. This is what makes the work eligible at all.
 *  - **nobody who could do it is holding it.** Either the issue is unassigned,
 *    or the person holding it does not do that half of the job.
 *
 * The second half is what makes the count on the card mean something. Without
 * it "Ready for QA = 1020" would count work already being tested, and handing
 * an issue out would leave the figure unchanged — a to-do list that never
 * shrinks. With it, assigning one issue drops the number by one, without the
 * status having been touched: assignment and transition stay separate, and it
 * is the *holder* that changed, not where the work is.
 *
 * It also has to be this rather than the simpler `assigneeId: null`. A Ready
 * for QA issue is normally still assigned to the developer who built it and
 * marked it ready — that is what the hand-off looks like — so a lane that only
 * held unassigned work would be empty almost all of the time.
 *
 * Composed with a project scope by every caller — the counter, the project
 * list and the issue list — so none of them carries its own idea of what is
 * waiting.
 */
export function laneIssueFilter(lane: WorkLane): Prisma.IssueWhereInput {
  return {
    status: { in: [...WORK_LANE_STATUSES[lane]] },
    OR: [{ assigneeId: null }, { assignee: doesNotDoLaneWork(lane) }],
  };
}

/**
 * Both lanes, counted and broken down by project, in two grouped queries.
 *
 * The count is the sum of the per-project counts rather than a separate
 * `count()` — one query cannot disagree with itself, and a second one asking
 * the same question with the same fragment is still a second answer waiting to
 * drift.
 *
 * Scoped by `accessibleProjectIds`, which is where every other Home figure gets
 * its scope and which already leaves out archived projects. Assigning work in a
 * project nobody is working in is not what this card is for.
 */
export async function loadWorkStatus(user: CurrentUser): Promise<WorkStatusData> {
  const projectIds = await accessibleProjectIds(user);

  if (projectIds.length === 0) {
    return {
      qa: { lane: "QA", count: 0, projects: [] },
      developer: { lane: "DEVELOPER", count: 0, projects: [] },
    };
  }

  const scope = { projectId: { in: projectIds } };

  /* One grouped pass per lane, because each lane's filter reaches into the
     assignee and the two cannot be answered by a single grouping. Still a
     fixed number of queries however many projects or issues there are. */
  const [projects, qaRows, developerRows] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, key: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.issue.groupBy({
      by: ["projectId"],
      where: { ...scope, ...laneIssueFilter("QA") },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["projectId"],
      where: { ...scope, ...laneIssueFilter("DEVELOPER") },
      _count: { _all: true },
    }),
  ]);

  function lane(
    which: WorkLane,
    grouped: { projectId: string; _count: { _all: number } }[],
  ): WorkStatusLane {
    const counts = new Map(
      grouped.map((row) => [row.projectId, row._count._all]),
    );

    const rows: WorkStatusProject[] = [];
    let total = 0;

    for (const project of projects) {
      const count = counts.get(project.id) ?? 0;
      if (count === 0) continue;
      rows.push({ ...project, count });
      total += count;
    }

    return { lane: which, count: total, projects: rows };
  }

  return {
    qa: lane("QA", qaRows),
    developer: lane("DEVELOPER", developerRows),
  };
}

/**
 * Every waiting issue in one project — every one of them, deliberately.
 *
 * There is no `take` here and that is the point. A project with forty issues
 * waiting for a developer must offer forty, not the first ten with the rest
 * unreachable: an administrator who cannot see a piece of work cannot hand it
 * out, and a cap is a silent decision that some work does not get assigned.
 * The picker searches this whole set and draws a few rows at a time, so the
 * limit is on what is rendered and never on what can be found.
 *
 * The same fragment the card counted with, so the number and these rows are
 * one question asked twice.
 */
export async function listLaneIssues(
  lane: WorkLane,
  projectId: string,
): Promise<WorkStatusIssue[]> {
  const rows = await prisma.issue.findMany({
    where: { projectId, ...laneIssueFilter(lane) },
    orderBy: [{ status: "asc" }, { key: "asc" }],
    select: {
      id: true,
      key: true,
      title: true,
      status: true,
      assignee: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title,
    status: row.status,
    assigneeName: row.assignee?.name ?? null,
  }));
}

/**
 * The people in one project who may be handed this lane's work.
 *
 * Two rules, both of them ones Prio already has: they are on the project, and
 * they do the half of the job the lane is about — `doesQaWork` for testing,
 * `doesDeveloperWork` for building. Belonging to the project is not enough on
 * its own, which is the whole reason the second rule is asked: a project's
 * developers are not its testers.
 *
 * The work role is derived from team rows loaded with the members, through
 * `workRoleFromTeams` — the same rule `workRoleOf` is written in terms of, so
 * a Full Stack Developer appears in both lanes here for exactly the reason
 * they hold both halves everywhere else.
 */
export async function listLaneMembers(
  lane: WorkLane,
  projectId: string,
): Promise<WorkStatusMember[]> {
  const rows = await prisma.user.findMany({
    where: {
      isActive: true,
      projectMemberships: { some: { projectId } },
    },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      jobTitle: true,
      role: true,
      teamMemberships: {
        where: {
          team: { slug: { in: [TESTING_TEAM_SLUG, DEVELOPMENT_TEAM_SLUG] } },
        },
        select: { team: { select: { slug: true } } },
      },
    },
    orderBy: { name: "asc" },
  });

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      image: row.image,
      jobTitle: row.jobTitle,
      workRole: workRoleFromTeams(
        row.role,
        row.teamMemberships.map((m) => m.team.slug),
      ),
    }))
    .filter((person) => laneAcceptsWorkRole(lane, person.workRole));
}
