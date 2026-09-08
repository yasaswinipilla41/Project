import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { WorkRole } from "@/lib/domain";

/**
 * Project-level authorization.
 *
 * Rules (§18):
 *   - ADMIN sees and edits every project.
 *   - MEMBER sees only projects they belong to, and may create/edit issues
 *     inside those projects.
 *
 * Every read and write path calls one of these helpers with a *server-derived*
 * user. Nothing here trusts a client-supplied role or project id.
 */

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN";
  constructor(message = "You do not have access to this resource.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message = "The requested item no longer exists.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Prisma `where` fragment restricting Project rows to what the user may see. */
export function projectScope(user: CurrentUser) {
  if (user.role === "ADMIN") return {};
  return { members: { some: { userId: user.id } } };
}

/** Prisma `where` fragment restricting Issue rows to what the user may see. */
export function issueScope(user: CurrentUser) {
  if (user.role === "ADMIN") return {};
  return { project: { members: { some: { userId: user.id } } } };
}

export async function canAccessProject(
  user: CurrentUser,
  projectId: string,
): Promise<boolean> {
  if (user.role === "ADMIN") {
    const count = await prisma.project.count({ where: { id: projectId } });
    return count > 0;
  }
  const count = await prisma.projectMember.count({
    where: { projectId, userId: user.id },
  });
  return count > 0;
}

/** Throws unless the user may read the project. */
export async function assertProjectAccess(
  user: CurrentUser,
  projectId: string,
): Promise<void> {
  if (!(await canAccessProject(user, projectId))) {
    throw new AuthorizationError("You do not have access to this project.");
  }
}

/** Throws unless the user may read the issue; returns its project id. */
export async function assertIssueAccess(
  user: CurrentUser,
  issueId: string,
): Promise<string> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { projectId: true },
  });
  if (!issue) throw new NotFoundError("This issue no longer exists.");
  await assertProjectAccess(user, issue.projectId);
  return issue.projectId;
}

/** Organization-level administration (users, invitations) is admin-only. */
export function assertAdmin(user: CurrentUser): void {
  if (user.role !== "ADMIN") {
    throw new AuthorizationError("This action requires an administrator.");
  }
}

/* ------------------------------------------------------ project ownership */

/**
 * Who may edit or delete a project.
 *
 * Exactly two answers, and no third:
 *
 *   - an ADMIN, for any project;
 *   - the person who created the project, for that project only.
 *
 * Belonging to a project is *not* enough. A member of a project someone else
 * created can read it and work in it, but cannot rename or destroy it. This is
 * deliberately narrower than `canAccessProject`, and the two must never be
 * confused: one governs reading, this one governs the project's existence.
 *
 * No new role is involved. Ownership is a fact about a row — `createdById` —
 * not a rank a person holds.
 */
export function canManageProject(
  user: CurrentUser,
  project: { createdById: string },
): boolean {
  return user.role === "ADMIN" || project.createdById === user.id;
}

/**
 * Throws unless the user may edit or delete the project; returns the row.
 *
 * Reads `createdById` from the database on every call. A caller may not pass in
 * an owner id — that would let the client nominate itself as the creator.
 *
 * A user who cannot even see the project gets "no longer exists" rather than
 * "forbidden", so that probing for project ids reveals nothing about which ones
 * are real.
 */
export async function assertProjectManage(
  user: CurrentUser,
  projectId: string,
): Promise<{ id: string; key: string; name: string; createdById: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, key: true, name: true, createdById: true },
  });

  if (!project) throw new NotFoundError("This project no longer exists.");

  if (!canManageProject(user, project)) {
    if (!(await canAccessProject(user, projectId))) {
      throw new NotFoundError("This project no longer exists.");
    }
    throw new AuthorizationError(
      "Only an administrator or the person who created this project can change it.",
    );
  }

  return project;
}

/** Ids of every project the user may see — used by global views and filters. */
export async function accessibleProjectIds(
  user: CurrentUser,
): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { ...projectScope(user), isArchived: false },
    select: { id: true },
  });
  return projects.map((p) => p.id);
}

/* ------------------------------------------------------------------ teams */

/**
 * Team membership.
 *
 * A team says what somebody does; `Role` says whether they may administer
 * Prio; `ProjectMember` says which work they may see. The three are
 * deliberately independent, so none of them is a back door into another:
 *
 *  - being an ADMIN does **not** make you a member of any team. An
 *    administrator who has not been put in Testing is not on Testing, because
 *    "can manage Prio" and "does the testing" are different claims and the
 *    second is the one a testing view is about.
 *  - being on a project does not put you in a team, and being in a team does
 *    not grant access to any project. A team view still passes through the
 *    ordinary project scope.
 *  - nothing is implicit: a new account belongs to no team until somebody adds
 *    it to one.
 *
 * Teams are rows, so adding "Development" or "Design" later is an insert
 * rather than another branch here.
 */

/** Slug of the team that owns the testing surfaces. */
export const TESTING_TEAM_SLUG = "testing";

/* --------------------------------------------------------- working roles */

/**
 * What somebody does here, as opposed to what they may administer.
 *
 * Prio has two `Role` values and always has: ADMIN and MEMBER. That answers
 * "may this person administer Prio", which is a different question from "is
 * this person a tester or a developer" — and the second is the one the
 * workflow turns on. Rather than a third `Role` value and the migration that
 * would need, the answer is read from the team the person is on, which is
 * where Prio already keeps it: `/my-work` has always decided whether to show
 * the testing surfaces this way.
 *
 *   ADMIN                              -> "ADMIN"
 *   MEMBER on the Testing team         -> "QA"
 *   MEMBER not on the Testing team     -> "DEVELOPER"
 *
 * An administrator is an administrator whether or not they are also on the
 * team: nothing below is ever withheld from them, so the distinction between
 * "admin who tests" and "admin who does not" would decide nothing.
 *
 * Everything that gates on this calls `workRoleOf`; there is no second
 * definition of who a tester is anywhere in the codebase.
 */
export type { WorkRole };

export async function workRoleOf(user: CurrentUser): Promise<WorkRole> {
  if (user.role === "ADMIN") return "ADMIN";
  return (await isTeamMember(user, TESTING_TEAM_SLUG)) ? "QA" : "DEVELOPER";
}

/**
 * Who may file work: an administrator, or a tester.
 *
 * Raising work is QA's job in this model — a defect found, a task that needs
 * doing — and a developer's job is to build what has been raised. A developer
 * who needs something filed asks for it; the alternative is a backlog nobody
 * has agreed to.
 */
export async function assertCanCreateWork(user: CurrentUser): Promise<void> {
  if ((await workRoleOf(user)) === "DEVELOPER") {
    throw new AuthorizationError(
      "Only an administrator or a tester can create work items.",
    );
  }
}

export async function isTeamMember(
  user: CurrentUser,
  slug: string,
): Promise<boolean> {
  const count = await prisma.teamMember.count({
    where: { userId: user.id, team: { slug } },
  });
  return count > 0;
}

/** Throws unless the user is explicitly a member of the named team. */
export async function assertTeamMember(
  user: CurrentUser,
  slug: string,
): Promise<void> {
  if (!(await isTeamMember(user, slug))) {
    throw new AuthorizationError("This area is limited to the team that owns it.");
  }
}
