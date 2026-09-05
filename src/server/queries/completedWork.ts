import { prisma } from "@/lib/prisma";
import type { CompletedByPerson } from "@/components/projects/CompletedWork";

/**
 * Who completed the work — read from the activity trail, never from
 * `assigneeId`. `completersFor` is the shared lookup; `loadCompletedByPerson`
 * is the project summary's grouped view built on top of it.
 */

export interface Completer {
  id: string;
  name: string;
  image: string | null;
}

/**
 * Who actually completed each of the given issues, by issue id.
 *
 * The single place that answers that question, so the project summary's
 * Completed section and the issue list's "Completed by" column cannot drift
 * apart. It reads the activity trail — `updateIssue` writes an
 * `ActivityLogEntry` with `field: "status"` and `newValue: "DONE"` naming the
 * actor — and never `assigneeId`, which only says who holds the issue now.
 *
 * The most recent Done wins: work that was completed, reopened and completed
 * again was last finished by whoever finished it last. An issue with no such
 * entry is simply absent from the map — unknown, rather than attributed to
 * whoever happens to hold it.
 */
export async function completersFor(
  issueIds: string[],
): Promise<Map<string, Completer>> {
  const byIssue = new Map<string, Completer>();
  if (issueIds.length === 0) return byIssue;

  const entries = await prisma.activityLogEntry.findMany({
    where: { field: "status", newValue: "DONE", issueId: { in: issueIds } },
    select: {
      issueId: true,
      actor: { select: { id: true, name: true, image: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  for (const entry of entries) {
    // Newest first, so the first one seen for an issue is the one that counts.
    if (!byIssue.has(entry.issueId)) byIssue.set(entry.issueId, entry.actor);
  }
  return byIssue;
}

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

  const completerByIssue = await completersFor(
    doneIssues.map((issue) => issue.id),
  );

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
