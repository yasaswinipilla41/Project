import type { IssueType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import {
  ISSUE_TYPE_LABEL,
  canCreateSprint,
  canCreateWorkItem,
} from "@/lib/domain";
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

/**
 * Throws unless the user may read an attachment.
 *
 * An attachment belongs to exactly one issue or one project — never both — so
 * reading it needs exactly what reading that issue or project needs. Shared by
 * the file route and the viewer page, so the two can never disagree about who
 * may see a file.
 *
 * Both columns are nullable, so "belongs to neither" is a shape the database
 * permits even though nothing writes it. Refusing explicitly is the safe
 * reading of an unowned file: there is no project whose membership could grant
 * it, so nobody may have it.
 */
export async function assertAttachmentAccess(
  user: CurrentUser,
  attachment: { issueId: string | null; projectId: string | null },
): Promise<void> {
  if (attachment.issueId) {
    await assertIssueAccess(user, attachment.issueId);
    return;
  }
  if (!attachment.projectId) {
    throw new AuthorizationError("This file has no owner.");
  }
  await assertProjectAccess(user, attachment.projectId);
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

/**
 * Slug of the Development team.
 *
 * Two things at once, and it is worth being exact about which:
 *
 *  - It is the roster Administration lists — who has been deliberately
 *    onboarded to build, which nothing recorded before.
 *  - Held *together with* Testing, it makes somebody a Full Stack Developer.
 *    `workRoleOf` reads it for that and only that.
 *
 * What it deliberately does not do is grant the developer role on its own. A
 * developer has always been "a member who is not on Testing", and every
 * existing account is one; requiring this row to build would have demoted
 * everybody not yet added to it. Development-only and on-neither-team are
 * therefore the same answer — DEVELOPER — and this team's presence only ever
 * adds.
 */
export const DEVELOPMENT_TEAM_SLUG = "development";

/**
 * Slug of the Full Stack Developers team.
 *
 * A roster in its own right, and that is the point of it. Full stack used to be
 * derived and *only* derived — somebody on Development and on Testing — which
 * made those two rows load-bearing in a way nobody had asked for: adding a full
 * stack developer wrote both memberships, and removing one deleted both. So a
 * person deliberately put on Testing months earlier lost that row because an
 * administrator took them off the full stack list, and their own dashboard
 * changed under them without anybody having decided it should.
 *
 * The three memberships are independent now. Adding here writes this row and
 * only this row; removing here deletes this row and only this row; whatever
 * else somebody holds is theirs and is left alone.
 *
 * The derived combination still answers FULLSTACK — see `workRoleFromTeams` —
 * because somebody who genuinely builds and genuinely checks does both jobs
 * whether or not a third list says so. What has gone is the cascade, not the
 * reading.
 */
export const FULLSTACK_TEAM_SLUG = "fullstack";

/**
 * Every team the working role is derived from.
 *
 * Named once, because the answer is only right if the question was asked in
 * full: a query that loads two of these and hands them to `workRoleFromTeams`
 * gets a confident wrong answer rather than an error, and a full stack
 * developer quietly reads as a developer. Every bulk load asks for this list.
 */
export const WORK_TEAM_SLUGS = [
  TESTING_TEAM_SLUG,
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
] as const;

/**
 * The memberships that carry each half of the job.
 *
 * `doesQaWork` and `doesDeveloperWork` answer this for a role already in hand;
 * these are the same questions expressed as the rows they are derived from, for
 * the places that have to ask a *query* rather than a value — "which of this
 * project's members test", and the like.
 */
export const QA_TEAM_SLUGS = [TESTING_TEAM_SLUG, FULLSTACK_TEAM_SLUG] as const;
export const DEVELOPER_TEAM_SLUGS = [
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
] as const;

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
 *   MEMBER on Full Stack               -> "FULLSTACK"
 *   MEMBER on Testing and Development  -> "FULLSTACK"
 *   MEMBER on Testing only             -> "QA"
 *   MEMBER on Development only         -> "DEVELOPER"
 *   MEMBER on neither                  -> "DEVELOPER"
 *
 * The last two lines are the same answer for a reason. A developer has always
 * been "a member who is not on Testing", and that is what every existing
 * account is; making Development the thing that grants the role would have
 * demoted everybody who has not been added to it yet. Development says who has
 * been deliberately onboarded, and combines with Testing to make somebody full
 * stack — it does not withdraw the default.
 *
 * Both memberships together are read as *both jobs*, never as one of them
 * winning. A Full Stack Developer builds and checks; the two capabilities are
 * asked for by name in `domain.ts` — `doesQaWork`, `doesDeveloperWork` — so
 * nothing has to enumerate which role names happen to include which job.
 *
 * An administrator is an administrator whether or not they are also on a team:
 * nothing below is ever withheld from them, so the distinction between "admin
 * who tests" and "admin who does not" would decide nothing. Full stack is not
 * a route to administration — it is two member jobs, and neither is ADMIN.
 *
 * Everything that gates on this calls `workRoleOf`; there is no second
 * definition of who a tester is anywhere in the codebase.
 */
export type { WorkRole };

export async function workRoleOf(user: CurrentUser): Promise<WorkRole> {
  if (user.role === "ADMIN") return "ADMIN";

  const rows = await prisma.teamMember.findMany({
    where: {
      userId: user.id,
      team: { slug: { in: [...WORK_TEAM_SLUGS] } },
    },
    select: { team: { select: { slug: true } } },
  });

  return workRoleFromTeams(
    user.role,
    rows.map((row) => row.team.slug),
  );
}

/**
 * The same derivation, from teams already in hand.
 *
 * `workRoleOf` asks the database about one person, which is right nearly
 * everywhere and wrong when a screen has to know this about a whole project's
 * members at once — thirty people would be thirty round trips. This is the
 * rule itself, taking the two facts it actually reads, so a caller that has
 * loaded team rows in bulk answers the question the same way rather than
 * writing a second version of it.
 *
 * `workRoleOf` is defined in terms of this, so there is one implementation and
 * not two that agree today.
 */
export function workRoleFromTeams(
  accountRole: CurrentUser["role"],
  teamSlugs: Iterable<string>,
): WorkRole {
  if (accountRole === "ADMIN") return "ADMIN";

  const slugs = new Set(teamSlugs);
  const testing = slugs.has(TESTING_TEAM_SLUG);
  const development = slugs.has(DEVELOPMENT_TEAM_SLUG);

  /* Two ways to be full stack, and neither outranks the other: somebody put on
     the Full Stack roster, and somebody who holds both halves separately. The
     second is what this used to derive the answer from exclusively, and it
     still counts — a person who genuinely builds and genuinely checks does both
     jobs whether or not a third list says so. */
  if (slugs.has(FULLSTACK_TEAM_SLUG) || (testing && development)) {
    return "FULLSTACK";
  }
  if (testing) return "QA";
  return "DEVELOPER";
}

/**
 * The working role of each of several people, in one query.
 *
 * `workRoleOf` answers for the signed-in caller, which is what nearly every
 * gate needs. An assignee picker needs the answer for a whole project's
 * membership at once, and asking one at a time would be a round trip per
 * person. This loads both facts the rule reads — the account role, and
 * membership of the two teams — and hands each pair to `workRoleFromTeams`,
 * so the derivation stays in the one place that owns it.
 *
 * Anybody asked about who does not exist is simply absent from the result;
 * callers decide what that means rather than being handed a default that
 * looks like an answer.
 */
export async function workRolesFor(
  userIds: string[],
): Promise<Map<string, WorkRole>> {
  if (userIds.length === 0) return new Map();

  const [people, memberships] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, role: true },
    }),
    prisma.teamMember.findMany({
      where: {
        userId: { in: userIds },
        team: { slug: { in: [...WORK_TEAM_SLUGS] } },
      },
      select: { userId: true, team: { select: { slug: true } } },
    }),
  ]);

  const slugsByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const slugs = slugsByUser.get(row.userId) ?? [];
    slugs.push(row.team.slug);
    slugsByUser.set(row.userId, slugs);
  }

  return new Map(
    people.map((person) => [
      person.id,
      workRoleFromTeams(person.role, slugsByUser.get(person.id) ?? []),
    ]),
  );
}

/**
 * Who may file work of a given kind.
 *
 * The decision itself is `canCreateWorkItem` in `domain.ts`, which is the
 * approved matrix written down once; this resolves the caller's working role
 * from the database and applies it. The role is never taken from the request,
 * so a payload naming a role decides nothing.
 *
 * This used to refuse anybody who did not do the QA half — raising work was a
 * tester's act, and a developer who found a defect had to ask for it to be
 * filed. Every role raises work now. What a developer still cannot do is
 * declare it tested or done, which is `allowedStatusesFor`'s business and is
 * unchanged.
 *
 * Project access is a separate question and is asserted separately by every
 * caller; this narrows what may be raised, never where.
 */
export async function assertCanCreateWork(
  user: CurrentUser,
  type: IssueType,
): Promise<void> {
  if (!canCreateWorkItem(await workRoleOf(user), type)) {
    throw new AuthorizationError(
      `${ISSUE_TYPE_LABEL[type]} is not something you can raise.`,
    );
  }
}

/**
 * Who may create a sprint: an administrator, and nobody else.
 *
 * The same `canCreateSprint` the create menu reads, so the control that offers
 * it and the action that accepts it cannot disagree. Every other sprint
 * operation keeps the authorization it already had.
 */
export async function assertCanCreateSprint(user: CurrentUser): Promise<void> {
  if (!canCreateSprint(await workRoleOf(user))) {
    throw new AuthorizationError("Only an administrator can create a sprint.");
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
