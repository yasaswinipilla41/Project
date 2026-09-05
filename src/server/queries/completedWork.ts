import { prisma } from "@/lib/prisma";
import type { CompletedByPerson } from "@/components/projects/CompletedWork";

/**
 * A project's completed work, grouped by the person who actually completed it.
 *
 * The distinction the whole query exists for: **the assignee is not
 * necessarily the person who finished the work.** An issue can be reassigned,
 * picked up by whoever was free, or closed by a reviewer, and `assigneeId`
 * only ever says who holds it now. Who moved it to Done is a separate fact,
 * and Prio already records it — `updateIssue` writes an `ActivityLogEntry`
 * with `field: "status"` and `newValue: "DONE"` naming the actor.
 *
 * Two rules follow from that:
 *
 *  - **The most recent Done wins.** Work that was completed, reopened and
 *    completed again was last finished by whoever finished it last.
 *  - **No guessing.** Where no such entry exists — work completed before the
 *    trail did, or imported — the person is genuinely unknown and is reported
 *    as unknown. Falling back to the assignee would attribute somebody else's
 *    work to whoever happens to hold the issue today, which is precisely the
 *    mistake this exists to avoid.
 *
 * Scoped by `projectId` throughout, and the activity read is further narrowed
 * to this project's own completed issues, so nothing from another project can
 * reach the result.
 */
export async function loadCompletedByPerson(
  projectId: string,
): Promise<CompletedByPerson[]> {
  /* "Completed" is DONE and nothing else, exactly as the Completion card on
     the same page defines it: cancelled and rejected work is closed, not
     finished, and counting it here would flatter the section. */
  const doneIssues = await prisma.issue.findMany({
    where: { projectId, status: "DONE" },
    select: { id: true, key: true, title: true, type: true },
    orderBy: [
      { completedAt: { sort: "desc", nulls: "last" } },
      { updatedAt: "desc" },
    ],
  });

  if (doneIssues.length === 0) return [];

  const entries = await prisma.activityLogEntry.findMany({
    where: {
      field: "status",
      newValue: "DONE",
      issueId: { in: doneIssues.map((issue) => issue.id) },
    },
    select: {
      issueId: true,
      actor: { select: { id: true, name: true, image: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const completerByIssue = new Map<string, (typeof entries)[number]["actor"]>();
  for (const entry of entries) {
    // Newest first, so the first one seen for an issue is the one that counts.
    if (!completerByIssue.has(entry.issueId)) {
      completerByIssue.set(entry.issueId, entry.actor);
    }
  }

  const people: CompletedByPerson[] = [];
  const indexByPerson = new Map<string, number>();

  for (const issue of doneIssues) {
    const person = completerByIssue.get(issue.id) ?? null;
    const groupKey = person?.id ?? "unknown";

    let index = indexByPerson.get(groupKey);
    if (index === undefined) {
      index = people.length;
      indexByPerson.set(groupKey, index);
      people.push({
        id: person?.id ?? null,
        /* Not "Unassigned": nobody said who did this, which is a different
           thing from nobody holding it. */
        name: person?.name ?? "Not recorded",
        image: person?.image ?? null,
        issues: [],
      });
    }
    people[index]!.issues.push(issue);
  }

  /* Busiest finisher first; the unattributed group last whatever its size, so
     it reads as a footnote rather than as the project's most productive
     person. */
  return people.sort((a, b) => {
    if ((a.id === null) !== (b.id === null)) return a.id === null ? 1 : -1;
    return b.issues.length - a.issues.length;
  });
}
