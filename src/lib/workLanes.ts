import type { IssueStatus } from "@prisma/client";
import { doesDeveloperWork, doesQaWork, type WorkRole } from "@/lib/domain";

/**
 * Work Status's vocabulary: the two lanes an administrator hands work out
 * along, and the shapes the card and its dialog are given.
 *
 * Here rather than beside the queries because the card is a client component
 * and the queries import Prisma — a value crossing that line would pull the
 * database client into the browser bundle. This module knows only what a lane
 * *is*; `server/queries/workStatus` turns it into a query and
 * `server/workStatus` guards it.
 *
 * The two lanes, and why each holds what it does:
 *
 *   QA         Ready for QA. Work a developer has finished and handed over.
 *              Nothing else: In QA is already being tested, and Backlog or New
 *              have not been built yet, so neither is waiting for a tester.
 *   DEVELOPER  New, Reopen, Backlog. Work that exists and has not been picked
 *              up — freshly raised, sent back, or parked. In Progress and
 *              beyond are already somebody's.
 *
 * A lane holds work in one of those statuses that nobody who could do it is
 * holding — either unassigned, or with somebody who does the other half of the
 * job. That second condition is what makes the number a to-do list: handing an
 * issue out drops the count by one without its status having moved. It needs a
 * query, so it lives in `server/queries/workStatus` alongside the fragment that
 * expresses it; the statuses are here because both sides read them.
 *
 * The count on the card, the projects it offers, the issues inside each of them
 * and the check the assignment itself makes are all that one fragment. That is
 * what makes "Ready for QA = 5" and the five issues the dialog lists the same
 * five by construction rather than by inspection.
 */

export type WorkLane = "QA" | "DEVELOPER";

/** The statuses that make an issue assignable in each lane. */
export const WORK_LANE_STATUSES: Record<WorkLane, readonly IssueStatus[]> = {
  QA: ["IN_REVIEW"],
  DEVELOPER: ["TODO", "REOPENED", "BACKLOG"],
};

/** What each lane's control and its dialog are called, said once. */
export const WORK_LANE_LABEL: Record<WorkLane, string> = {
  QA: "Assign Work to QA",
  DEVELOPER: "Assign Work to Developer",
};

export function isWorkLane(value: unknown): value is WorkLane {
  return value === "QA" || value === "DEVELOPER";
}

/**
 * May somebody who does this kind of work be handed an issue in this lane?
 *
 * Asked as a capability rather than by role name, so a Full Stack Developer —
 * who both builds and checks — is eligible for both lanes for the same reason
 * they hold both halves everywhere else, and a pure tester is refused
 * development work without anything having to enumerate role names.
 */
export function laneAcceptsWorkRole(lane: WorkLane, role: WorkRole): boolean {
  return lane === "QA" ? doesQaWork(role) : doesDeveloperWork(role);
}

/* -------------------------------------------------- what the card is given */

export interface WorkStatusProject {
  id: string;
  key: string;
  name: string;
  /** Eligible issues in this project, by the lane's own filter. */
  count: number;
}

export interface WorkStatusLane {
  lane: WorkLane;
  /** Every eligible issue the administrator can reach, across all projects. */
  count: number;
  /** Only projects holding at least one — a project with none is not offered. */
  projects: WorkStatusProject[];
}

export interface WorkStatusData {
  qa: WorkStatusLane;
  developer: WorkStatusLane;
}

export interface WorkStatusIssue {
  id: string;
  key: string;
  title: string;
  status: IssueStatus;
  assigneeName: string | null;
}

export interface WorkStatusMember {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
  workRole: WorkRole;
}
