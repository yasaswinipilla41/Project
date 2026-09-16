import type { Priority } from "@prisma/client";
import { PRIORITY_LABEL, PRIORITY_WEIGHT } from "@/lib/domain";

/**
 * Dealing the backlog out across the people who can build it.
 *
 * Deliberately a pure function over plain data, with no database, no session
 * and no network in it. Two reasons, and both matter:
 *
 *  - **It can be checked.** "Assisted" assignment that cannot be examined is
 *    just an opaque write. Given the same backlog and the same workloads this
 *    returns the same plan every time, so a preview is a promise rather than an
 *    illustration, and a test can state exactly where the work goes.
 *  - **There is no model in it.** Nothing here calls out to anything. The
 *    "intelligence" is two rules an administrator would apply by hand — do the
 *    urgent work first, give it to whoever is least busy — applied consistently
 *    and without anybody having to hold four people's queues in their head.
 *    A service that could be slow, cost money, be unavailable or answer
 *    differently on a Tuesday has no business deciding who fixes what.
 *
 * The two rules, in order:
 *
 *   1. **Priority first.** The backlog is sorted by priority before anything is
 *      dealt, so Urgent work is placed while the queues are shortest. Issues of
 *      equal priority are ordered by key, which is stable and readable.
 *   2. **The lightest queue takes it.** Each issue goes to whoever currently
 *      holds the fewest open issues.
 *
 * And the part that makes rule 2 mean anything: **the count moves as the work
 * is dealt.** Reading each person's workload once and sorting on it would put
 * the entire backlog on whoever happened to be least busy at the start. Every
 * allocation increments that person's figure, so the next issue is weighed
 * against what they are about to be holding rather than what they held before
 * this run began.
 *
 * Ties are broken by name and then by id, never randomly. A shuffle would make
 * the preview a different answer from the one that gets applied.
 */

export interface AllocationCandidate {
  id: string;
  name: string;
  /**
   * Open issues already assigned to them.
   *
   * Prio's existing workload figure — the one Admin Home's workload panel
   * shows — rather than a second definition invented here. The caller supplies
   * it, so this module never decides what "busy" means.
   */
  workload: number;
}

export interface AllocationIssue {
  id: string;
  key: string;
  title: string;
  priority: Priority;
}

/** One issue, the person it goes to, and why. */
export interface Allocation {
  issueId: string;
  issueKey: string;
  issueTitle: string;
  priority: Priority;
  assigneeId: string;
  assigneeName: string;
  /** What they were holding when this issue was placed. */
  workloadBefore: number;
  /** And afterwards — what the next issue is weighed against. */
  workloadAfter: number;
  reason: string;
}

/**
 * Who should take the next issue: the lightest queue, ties broken by name and
 * then by id so the same inputs always give the same answer.
 */
function leastLoaded(
  candidates: AllocationCandidate[],
  load: Map<string, number>,
): AllocationCandidate {
  let best = candidates[0]!;

  for (const candidate of candidates) {
    if (candidate === best) continue;

    const mine = load.get(candidate.id) ?? 0;
    const theirs = load.get(best.id) ?? 0;

    if (mine < theirs) {
      best = candidate;
      continue;
    }
    if (mine === theirs) {
      const byName = candidate.name.localeCompare(best.name, "en");
      if (byName < 0 || (byName === 0 && candidate.id < best.id)) best = candidate;
    }
  }

  return best;
}

/**
 * The plan: every issue, in the order it was placed, and who it went to.
 *
 * Nothing is written. The caller decides whether to show this, apply it, or
 * both — and `applyBacklogAllocation` recomputes it server-side rather than
 * trusting a plan that came back from a browser.
 */
export function planBacklogAllocation(
  issues: AllocationIssue[],
  candidates: AllocationCandidate[],
): Allocation[] {
  if (candidates.length === 0 || issues.length === 0) return [];

  /* A working copy, because the whole point is that these move. */
  const load = new Map(candidates.map((person) => [person.id, person.workload]));

  const order = [...issues].sort((a, b) => {
    const byPriority = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
    if (byPriority !== 0) return byPriority;
    return a.key.localeCompare(b.key, "en");
  });

  const plan: Allocation[] = [];

  for (const issue of order) {
    const person = leastLoaded(candidates, load);
    const before = load.get(person.id) ?? 0;
    const after = before + 1;
    load.set(person.id, after);

    plan.push({
      issueId: issue.id,
      issueKey: issue.key,
      issueTitle: issue.title,
      priority: issue.priority,
      assigneeId: person.id,
      assigneeName: person.name,
      workloadBefore: before,
      workloadAfter: after,
      reason:
        `${PRIORITY_LABEL[issue.priority]} priority. ${person.name} had the ` +
        `lightest queue at ${before} open ${before === 1 ? "issue" : "issues"}.`,
    });
  }

  return plan;
}

/**
 * How much one auto-assignment run places.
 *
 * The planner sorts by priority before it deals, so a cap keeps the most urgent
 * work rather than an arbitrary slice. Without one, a project with several
 * hundred waiting issues would turn a single press into several hundred writes
 * and a request nobody should be waiting on.
 *
 * Here rather than beside the action because a `"use server"` module may only
 * export async functions, and both the server and the dialog need this number.
 */
export const MAX_PER_RUN = 25;

/** What a run would do, or did. */
export interface BacklogPlan {
  allocations: Allocation[];
  totals: { id: string; name: string; added: number; workloadAfter: number }[];
  /** Every backlog issue waiting for a developer, including beyond this run. */
  waiting: number;
  /** The cap, so the interface can state it rather than hard-code it. */
  perRun: number;
  /** How many were actually written. Zero on a preview. */
  assigned: number;
}

/** How many issues each person ended up with — for a summary line. */
export function allocationTotals(
  plan: Allocation[],
): { id: string; name: string; added: number; workloadAfter: number }[] {
  const byPerson = new Map<
    string,
    { id: string; name: string; added: number; workloadAfter: number }
  >();

  for (const row of plan) {
    const current = byPerson.get(row.assigneeId);
    if (current) {
      current.added += 1;
      current.workloadAfter = Math.max(current.workloadAfter, row.workloadAfter);
    } else {
      byPerson.set(row.assigneeId, {
        id: row.assigneeId,
        name: row.assigneeName,
        added: 1,
        workloadAfter: row.workloadAfter,
      });
    }
  }

  return [...byPerson.values()].sort((a, b) => b.added - a.added);
}
