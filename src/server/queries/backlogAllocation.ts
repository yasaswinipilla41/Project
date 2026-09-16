import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { OPEN_STATUSES } from "@/lib/domain";
import { laneIssueFilter, listLaneMembers } from "@/server/queries/workStatus";
import type {
  AllocationCandidate,
  AllocationIssue,
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
  const [issues, members] = await Promise.all([
    prisma.issue.findMany({
      where: { projectId, ...backlogToAllocateFilter() },
      select: { id: true, key: true, title: true, priority: true },
      /* Priority first, then key — the planner's own order, so the cap below
         keeps the most urgent work rather than the lowest-numbered. */
      orderBy: [{ priority: "asc" }, { key: "asc" }],
      take: limit,
    }),
    listLaneMembers("DEVELOPER", projectId),
  ]);

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
