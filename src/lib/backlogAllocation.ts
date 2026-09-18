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

/**
 * Where an issue is in its life, which is what decides who should get it.
 *
 * Ordered as the engine considers them: work already handed to testing goes to
 * a tester before anything else is dealt, work that has come back goes to
 * whoever built it, and only then is the unclaimed pile shared out.
 */
export const ALLOCATION_STAGES = [
  "READY_FOR_QA",
  "REOPENED",
  "NEW",
  "BACKLOG",
] as const;
export type AllocationStage = (typeof ALLOCATION_STAGES)[number];

const STAGE_RANK: Record<AllocationStage, number> =
  Object.fromEntries(ALLOCATION_STAGES.map((stage, index) => [stage, index])) as Record<
    AllocationStage,
    number
  >;

export interface AllocationIssue {
  id: string;
  key: string;
  title: string;
  priority: Priority;
  /** Defaults to `BACKLOG`, which is the only stage this engine used to have. */
  stage?: AllocationStage;
  /**
   * The one person this issue belongs to, when its history names one.
   *
   * Resolved by the caller from authoritative records — the tester the work
   * was handed to, or the developer who built what has come back — and already
   * checked for eligibility there. When it is present the queues do not get a
   * vote: returning work to whoever it belongs to is the point, and the
   * lightest queue is only how the unclaimed pile is shared.
   */
  preferred?: { id: string; name: string; because: string } | null;
}

/** An issue the engine deliberately left alone, and what it was waiting for. */
export interface UnplacedIssue {
  issueId: string;
  issueKey: string;
  issueTitle: string;
  stage: AllocationStage;
  reason: string;
}

/** Everything one run would do: what it places, and what it will not. */
export interface AllocationPlan {
  allocations: Allocation[];
  unplaced: UnplacedIssue[];
}

/** One issue, the person it goes to, and why. */
export interface Allocation {
  issueId: string;
  issueKey: string;
  issueTitle: string;
  priority: Priority;
  stage: AllocationStage;
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
): AllocationPlan {
  if (issues.length === 0) return { allocations: [], unplaced: [] };

  /* A working copy, because the whole point is that these move. */
  const load = new Map(candidates.map((person) => [person.id, person.workload]));

  /*
   * Stage first, then priority, then key.
   *
   * Stage leads because the stages are not equally urgent in the same sense:
   * work sitting in Ready for QA is finished work waiting on one person, and
   * work that has come back is somebody's own mistake waiting to be corrected.
   * Both are ahead of a pile nobody has started. Within a stage the existing
   * order is untouched — urgent work placed while the queues are shortest,
   * ties broken by a key rather than by chance.
   */
  const stageOf = (issue: AllocationIssue): AllocationStage =>
    issue.stage ?? "BACKLOG";

  const order = [...issues].sort((a, b) => {
    const byStage = STAGE_RANK[stageOf(a)] - STAGE_RANK[stageOf(b)];
    if (byStage !== 0) return byStage;
    const byPriority = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
    if (byPriority !== 0) return byPriority;
    return a.key.localeCompare(b.key, "en");
  });

  const allocations: Allocation[] = [];
  const unplaced: UnplacedIssue[] = [];

  const place = (
    issue: AllocationIssue,
    person: { id: string; name: string },
    reason: string,
  ) => {
    const before = load.get(person.id) ?? 0;
    const after = before + 1;
    load.set(person.id, after);

    allocations.push({
      issueId: issue.id,
      issueKey: issue.key,
      issueTitle: issue.title,
      priority: issue.priority,
      stage: stageOf(issue),
      assigneeId: person.id,
      assigneeName: person.name,
      workloadBefore: before,
      workloadAfter: after,
      reason,
    });
  };

  for (const issue of order) {
    const stage = stageOf(issue);

    /* The issue belongs to somebody, and the caller has already checked that
       they can still take it. Queues are irrelevant here. */
    if (issue.preferred) {
      place(issue, issue.preferred, issue.preferred.because);
      continue;
    }

    /*
     * Ready for QA never falls through to the developers.
     *
     * The generic pool is a pool of people who *build*, and handing tested-out
     * work to one of them would undo the hand-off the status records. With no
     * tester to return it to, the honest answer is to leave it where it is and
     * say so.
     */
    if (stage === "READY_FOR_QA") {
      unplaced.push({
        issueId: issue.id,
        issueKey: issue.key,
        issueTitle: issue.title,
        stage,
        reason:
          "Waiting for testing, and no tester on this project can take it. " +
          "Left where it is rather than handed to a developer.",
      });
      continue;
    }

    if (candidates.length === 0) {
      unplaced.push({
        issueId: issue.id,
        issueKey: issue.key,
        issueTitle: issue.title,
        stage,
        reason: "No developer on this project is available to take it.",
      });
      continue;
    }

    const person = leastLoaded(candidates, load);
    const before = load.get(person.id) ?? 0;
    place(
      issue,
      person,
      `${PRIORITY_LABEL[issue.priority]} priority. ${person.name} had the ` +
        `lightest queue at ${before} open ${before === 1 ? "issue" : "issues"}.`,
    );
  }

  return { allocations, unplaced };
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
  /** What it deliberately left alone, and why — never a silent omission. */
  unplaced: UnplacedIssue[];
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
