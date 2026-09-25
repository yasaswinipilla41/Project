import type { IssueStatus } from "@prisma/client";

/**
 * How a project's work splits across four readable groups.
 *
 * This answers a different question from `lib/projectProgress`, which asks how
 * far through a project is and gets back one percentage. This asks what the
 * work is *doing* — finished, moving, untouched, or none of those — and gets
 * back four counts that always add up to the work that exists.
 *
 * Statuses are classified by their canonical identity (the `IssueStatus` values
 * in `lib/domain`), never by their display label: renaming "Ready for QA"
 * must not silently move work between groups.
 *
 * ## Closed is not completed
 *
 * `lib/domain` has one canonical marker in this area, `CLOSED_STATUSES`, and
 * it is documented as "statuses that take an issue out of active work" — Done,
 * Reject / Not an Issue, and Cancelled. Everywhere the application reads it,
 * it reads it as exactly that: `notIn: CLOSED_STATUSES` is how the admin page,
 * My Work and the reports panel ask for work that is still live. It marks a
 * status *closed*. It does not claim any of them was finished.
 *
 * The one place the word "completed" appears is `projectProgress`'s
 * `countsAsCompleted`, whose own doc-comment scopes it: "what 'completed'
 * means **for a project's progress**". For "how much is left to do", a
 * cancelled issue is correctly nothing left to do. That is a progress-local
 * alias, not a statement about the status itself.
 *
 * So no canonical metadata marks Reject / Not an Issue or Cancelled as
 * completed, and under this module's rule they are Other: this breakdown
 * reports what happened to the work, and work that was rejected or cancelled
 * was never delivered. Only DONE is Completed.
 *
 * Should `lib/domain` ever gain a real per-status "completed" marker, this is
 * the module that should read it, and the sets below are what it would
 * replace.
 *
 * ## The two figures differ on purpose
 *
 * A project therefore reports a higher progress percentage than its Completed
 * share whenever it holds rejected or cancelled work. That is two different
 * questions answered correctly, not a disagreement — `ProjectDistributionBar`
 * names each measurement in the interface so neither is read as the other.
 * Nothing here changes `projectProgress`, `countsAsCompleted` or
 * `CLOSED_STATUSES`, and `project-progress.test.ts` holds them to that.
 */

export const DISTRIBUTION_CATEGORIES = [
  "completed",
  "inProgress",
  "notStarted",
  "other",
] as const;

export type DistributionCategory = (typeof DISTRIBUTION_CATEGORIES)[number];

export const DISTRIBUTION_LABEL: Record<DistributionCategory, string> = {
  completed: "Completed",
  inProgress: "In Progress",
  notStarted: "Not Started",
  other: "Other",
};

/*
 * The three recognised groups, by canonical status identity.
 *
 * Written as sets rather than a switch so that classification is a membership
 * question asked in a fixed order, and so a status that is somehow in two of
 * them resolves by that order rather than by whichever branch was written
 * first.
 *
 * IN_REVIEW ("Ready for QA") is deliberately not In Progress: it is work
 * waiting for somebody, not work being done. REOPENED is deliberately not Not
 * Started: it has been worked on before, and calling it untouched would be a
 * lie about its history.
 */
const COMPLETED_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "DONE",
]);

const IN_PROGRESS_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "IN_PROGRESS",
  "IN_QA",
]);

const NOT_STARTED_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "BACKLOG",
  "TODO",
]);

/**
 * Which group one work item belongs to — exactly one, always.
 *
 * The order of the tests *is* the precedence rule: Completed, then In
 * Progress, then Not Started, then Other. Anything unrecognised — a status
 * added to the schema after this was written, or a value that arrived from
 * somewhere untyped — lands in Other rather than being dropped, because a work
 * item missing from the breakdown is worse than one in the vaguest group.
 */
export function distributionCategoryFor(
  status: IssueStatus | null | undefined,
): DistributionCategory {
  if (!status) return "other";
  if (COMPLETED_STATUSES.has(status)) return "completed";
  if (IN_PROGRESS_STATUSES.has(status)) return "inProgress";
  if (NOT_STARTED_STATUSES.has(status)) return "notStarted";
  return "other";
}

export type StatusDistribution = Record<DistributionCategory, number>;

export function emptyDistribution(): StatusDistribution {
  return { completed: 0, inProgress: 0, notStarted: 0, other: 0 };
}

export function distributionTotal(counts: StatusDistribution): number {
  return DISTRIBUTION_CATEGORIES.reduce(
    (sum, category) => sum + counts[category],
    0,
  );
}

/**
 * Rolls grouped status counts into the four groups.
 *
 * Takes counts rather than rows so the caller can hand over whatever its own
 * authoritative query already returned — a `groupBy` result, a tally, a single
 * project or a whole hierarchy of them. Each input entry is classified once
 * and added once, so a work item counted once by the caller is counted once
 * here.
 */
export function distributionOf(
  entries: Iterable<{ status: IssueStatus | null | undefined; count: number }>,
): StatusDistribution {
  const counts = emptyDistribution();
  for (const entry of entries) {
    if (!Number.isFinite(entry.count) || entry.count <= 0) continue;
    counts[distributionCategoryFor(entry.status)] += entry.count;
  }
  return counts;
}

/** Adds one distribution into another, for rolling a hierarchy upwards. */
export function addDistribution(
  base: StatusDistribution,
  extra: StatusDistribution,
): StatusDistribution {
  return {
    completed: base.completed + extra.completed,
    inProgress: base.inProgress + extra.inProgress,
    notStarted: base.notStarted + extra.notStarted,
    other: base.other + extra.other,
  };
}

export interface DistributionSegment {
  category: DistributionCategory;
  label: string;
  count: number;
  /** Whole-number percentage for the legend; the four always total 100. */
  percentage: number;
  /** Exact share for the bar, unrounded — `12.5` means one eighth. */
  width: number;
}

/**
 * The four segments, in their fixed order, ready to draw.
 *
 * Two different numbers come out of this on purpose:
 *
 *   - `width` is the exact ratio, so a third of the work occupies exactly a
 *     third of the bar. Rounding it first is how a bar comes to disagree with
 *     itself — three equal thirds drawn as 33/33/33 leave a gap.
 *   - `percentage` is the rounded figure the legend prints, corrected by the
 *     largest-remainder method so the four always read as exactly 100%.
 *
 * With no work at all every figure is zero: an empty project has not finished
 * 100% of nothing, and saying so would be the one reading that is certainly
 * wrong.
 */
export function distributionSegments(
  counts: StatusDistribution,
): DistributionSegment[] {
  const total = distributionTotal(counts);
  const percentages = largestRemainderPercentages(
    DISTRIBUTION_CATEGORIES.map((category) => counts[category]),
    total,
  );

  return DISTRIBUTION_CATEGORIES.map((category, index) => ({
    category,
    label: DISTRIBUTION_LABEL[category],
    count: counts[category],
    percentage: percentages[index] ?? 0,
    width: total > 0 ? (counts[category] / total) * 100 : 0,
  }));
}

/**
 * Whole percentages that still add up to 100.
 *
 * Rounding each share on its own is what produces a legend reading 99% or
 * 101%: three shares of a third round to 33 each, and nine of eleven rounds up
 * while the other two round up as well. So every share is floored first, and
 * the points that floors gave away are handed back to the shares that lost the
 * most to flooring.
 *
 * Ties go to the earlier group — Completed, then In Progress, then Not
 * Started, then Other — so the same counts always produce the same legend
 * rather than depending on the sort's own tie-breaking.
 *
 * A group with nothing in it takes no remainder point: `0` items are `0%`, and
 * a bar segment of zero width labelled 1% is not a rounding artefact anybody
 * can read past.
 */
function largestRemainderPercentages(
  counts: readonly number[],
  total: number,
): number[] {
  if (total <= 0) return counts.map(() => 0);

  const exact = counts.map((count) => (count / total) * 100);
  const result = exact.map(Math.floor);
  let remaining = 100 - result.reduce((sum, value) => sum + value, 0);

  const byRemainder = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .filter((entry) => counts[entry.index]! > 0)
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remaining -= 1;
  }

  return result;
}
