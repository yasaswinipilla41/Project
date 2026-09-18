import type { IssueStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { OPEN_STATUSES } from "@/lib/domain";
import { laneIssueFilter, listLaneMembers } from "@/server/queries/workStatus";
import type { WorkStatusMember } from "@/lib/workLanes";
import {
  developerToReturnWorkTo,
  testerToReturnWorkTo,
} from "@/server/activity";
import type {
  AllocationCandidate,
  AllocationIssue,
  AllocationStage,
} from "@/lib/backlogAllocation";

/**
 * What the backlog allocator is given to work with.
 *
 * Two loads, and both are existing definitions rather than new ones:
 *
 *  - **the work.** `laneIssueFilter("DEVELOPER")` already says what "waiting
 *    for somebody to build it" means — in the right status, with nobody who
 *    could do the work holding it — and this narrows that to the backlog
 *    alone. Reusing it is what keeps the auto-assignment and the manual Assign
 *    Work to Developer dialog talking about the same issues.
 *  - **the people, and how busy they are.** The candidates are the project's
 *    members who do development work, from `listLaneMembers`; the workload is
 *    open issues assigned, which is the figure Admin Home's workload panel
 *    already shows. A second definition of "busy" would eventually disagree
 *    with the one on screen.
 */

/**
 * Backlog work waiting for a developer.
 *
 * Only `BACKLOG`. The developer lane also holds New and Reopen, and those are
 * deliberately left out: New is work somebody has just raised and may still be
 * shaping, and Reopen goes back to whoever built it rather than to whoever is
 * free. The backlog is the pile that genuinely has nobody's name on it.
 *
 * And only work nobody who could build it is holding, which is the second half
 * of `laneIssueFilter` and the reason this never takes an issue off somebody.
 */
export function backlogToAllocateFilter(): Prisma.IssueWhereInput {
  const waiting = laneIssueFilter("DEVELOPER");
  return { status: "BACKLOG", OR: waiting.OR };
}

/**
 * Everything one run will consider, across the life of the work.
 *
 * The backlog was the whole of it once, and that left the two states where the
 * right person is *known* to be handed out by hand: work sitting in Ready for
 * QA with no tester on it, and work testing has sent back with nobody
 * building it. Those are not "who is least busy" questions at all — they have
 * an answer already, in the issue's own history — so the engine now looks at
 * them first and the backlog last.
 *
 * Both lane filters, unchanged, so this holds exactly the work the two Assign
 * Work dialogs hold: in the right status, and with nobody who could do that
 * half of the job already holding it.
 */
export function assignableWorkFilter(): Prisma.IssueWhereInput {
  return { OR: [laneIssueFilter("QA"), laneIssueFilter("DEVELOPER")] };
}

/** Which stage of its life an issue is at, from the status alone. */
function stageOf(status: IssueStatus): AllocationStage {
  if (status === "IN_REVIEW") return "READY_FOR_QA";
  if (status === "REOPENED") return "REOPENED";
  if (status === "TODO") return "NEW";
  return "BACKLOG";
}

/**
 * Who may be handed work by the engine rather than by a person.
 *
 * Narrower than who *may hold* work, deliberately. An administrator and a full
 * stack developer are both eligible when somebody chooses them — they do the
 * job, and the manual dialogs still offer them — but neither should be handed
 * work by a rule running on its own: an administrator's queue is not a
 * developer's queue, and a full stack developer is the person a team reaches
 * for deliberately rather than by rotation. A tester is refused development
 * work here for the same reason they are refused it everywhere else.
 *
 * So: the developer pool is developers, and the QA pool is testers.
 */
function autoAssignable(
  members: WorkStatusMember[],
  role: "DEVELOPER" | "QA",
): WorkStatusMember[] {
  return members.filter((member) => member.workRole === role);
}

export interface AllocationInputs {
  issues: AllocationIssue[];
  candidates: AllocationCandidate[];
}

/**
 * The backlog and the people, for one project.
 *
 * `limit` caps how much is placed in a single run. The planner sorts by
 * priority before anything is dealt, so a cap takes the most urgent work
 * rather than an arbitrary slice — and it is applied to the same list the
 * preview is built from, so what was shown is what gets written. Without one, a
 * project with several hundred waiting issues would turn one press into several
 * hundred writes.
 */
export async function loadAllocationInputs(
  projectId: string,
  limit: number,
): Promise<AllocationInputs> {
  const [rows, developerLane, qaLane] = await Promise.all([
    prisma.issue.findMany({
      where: { projectId, ...assignableWorkFilter() },
      select: {
        id: true,
        key: true,
        title: true,
        priority: true,
        status: true,
        reporterId: true,
      },
      /* Status first, because the enum is declared in lifecycle order and
         Ready for QA and Reopen are what this run answers before the pile.
         Then priority and key — the planner's own order, so the cap keeps the
         most urgent work rather than the lowest-numbered. */
      orderBy: [{ status: "asc" }, { priority: "asc" }, { key: "asc" }],
      take: limit,
    }),
    listLaneMembers("DEVELOPER", projectId),
    listLaneMembers("QA", projectId),
  ]);

  const developers = autoAssignable(developerLane, "DEVELOPER");
  const testers = autoAssignable(qaLane, "QA");
  const developerById = new Map(developers.map((p) => [p.id, p]));
  const testerById = new Map(testers.map((p) => [p.id, p]));

  /*
   * The person each issue already belongs to, where its records name one.
   *
   * Read through the same two helpers the workflow itself uses when it returns
   * work — `testerToReturnWorkTo` for a hand-off and `developerToReturnWorkTo`
   * for a reopen — so the engine and the workflow cannot come to different
   * answers about whose work something is. Neither is re-derived here.
   *
   * Whatever they name is then required to be in the pool above. That is what
   * enforces the exclusions in one place: a previous developer who has since
   * become an administrator, left the project, gone inactive or moved to
   * testing is simply not in the map, and the issue falls through to the
   * ordinary rule with nothing special-cased.
   */
  const issues: AllocationIssue[] = await Promise.all(
    rows.map(async (row) => {
      const stage = stageOf(row.status);
      const base = {
        id: row.id,
        key: row.key,
        title: row.title,
        priority: row.priority,
        stage,
      };

      if (stage === "READY_FOR_QA") {
        const testerId = await testerToReturnWorkTo(prisma, {
          reporterId: row.reporterId,
          projectId,
        });
        const tester = testerId ? testerById.get(testerId) : undefined;
        return {
          ...base,
          preferred: tester
            ? {
                id: tester.id,
                name: tester.name,
                because: `Waiting for testing. ${tester.name} raised it and tests on this project.`,
              }
            : null,
        };
      }

      if (stage === "REOPENED") {
        const builderId = await developerToReturnWorkTo(prisma, {
          issueId: row.id,
          projectId,
        });
        const builder = builderId ? developerById.get(builderId) : undefined;
        return {
          ...base,
          preferred: builder
            ? {
                id: builder.id,
                name: builder.name,
                because: `Reopened. ${builder.name} built it, so it goes back to them.`,
              }
            : null,
        };
      }

      return base;
    }),
  );

  const members = developers;
  if (members.length === 0) return { issues, candidates: [] };

  /*
   * How busy each of them is: open issues assigned, across everything they
   * hold rather than this project alone. Somebody buried in another project is
   * not available here either, and the workload panel counts it the same way.
   */
  const open = await prisma.issue.groupBy({
    by: ["assigneeId"],
    where: {
      status: { in: [...OPEN_STATUSES] },
      assigneeId: { in: members.map((member) => member.id) },
    },
    _count: { _all: true },
  });

  const workload = new Map(
    open.flatMap((row) =>
      row.assigneeId ? [[row.assigneeId, row._count._all] as const] : [],
    ),
  );

  return {
    issues,
    candidates: members.map((member) => ({
      id: member.id,
      name: member.name,
      workload: workload.get(member.id) ?? 0,
    })),
  };
}
