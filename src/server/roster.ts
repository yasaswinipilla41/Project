"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin, FULLSTACK_TEAM_SLUG, workRoleOf } from "@/lib/authz";
import { ISSUE_TYPE_LABEL } from "@/lib/domain";
import type { WorkRole } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  assignmentMessage,
  isTester,
  notify,
  recordFieldChanges,
  watcherIds,
} from "@/server/activity";
import { setUserRole } from "@/server/users";

/**
 * Administration's rosters: who is on a team, what they can open, and — for
 * developers — what they have been handed.
 *
 * Everything here is one administrator's act, guarded by the same `assertAdmin`
 * the rest of Administration uses. No new permission concept is introduced and
 * no second authorization framework: this composes writes that already exist.
 *
 * The three facts it touches are deliberately separate rows, and stay separate:
 *
 *   `TeamMember`     what somebody does — Testing, or Development
 *   `ProjectMember`  what they may open
 *   `Issue.assignee` what they have been given
 *
 * Adding somebody to a team still grants access to nothing on its own. The
 * dialogs write the project row *as well*, because an administrator putting a
 * tester on a project means both, and making them do it in two places was the
 * limitation being fixed — not because membership has grown a project
 * dimension. It has not, and `TeamMember` is unchanged.
 *
 * Full stack developers are a roster of their own. They used to be those same
 * two rows read together — on Development and on Testing — so adding one wrote
 * both memberships and removing one deleted both, and taking somebody off the
 * full stack list quietly took away a Testing row that had been granted
 * deliberately, separately, and for its own reasons. The three memberships are
 * independent now: adding here writes the Full Stack row and nothing else,
 * removing here deletes the Full Stack row and nothing else, and whatever else
 * a person holds is theirs. `workRoleFromTeams` still reads
 * Development-and-Testing as full stack as well, so nobody who was one before
 * this changed has stopped being one.
 */

export type RosterActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

/* --------------------------------------------------------------- schemas */

const teamAssignmentSchema = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  userIds: z.array(z.string().min(1)).min(1),
});

const developerAssignmentSchema = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  issueIds: z.array(z.string().min(1)),
  role: z.enum(["ADMIN", "MEMBER"]),
  userIds: z.array(z.string().min(1)).min(1),
});

/**
 * The same request without a team.
 *
 * The full stack roster is derived, so there is no id for a caller to name and
 * none for it to get wrong: the two teams are looked up here, by the slugs the
 * role derivation itself reads.
 */
const fullStackAssignmentSchema = developerAssignmentSchema.omit({
  teamId: true,
});

const fullStackRemovalSchema = z.object({ userId: z.string().min(1) });

/* ------------------------------------------------------ shared validation */

/**
 * The people named in a request, checked against the database.
 *
 * A payload may name anybody; only active accounts come back. Returned in the
 * order the caller listed them, because that order decides who receives which
 * issue below and a silent reshuffle would make the outcome unpredictable.
 */
async function activeUsers(userIds: string[]): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  return userIds.filter((id) => found.has(id));
}

/* ------------------------------------------------------- team assignment */

/**
 * Put several people on a team and into a project in one act.
 *
 * This is the Testing block's Add Members, and it is two upserts per person
 * rather than one new relationship: the team roster, and access to the project
 * they were chosen for. Re-adding somebody already on either is a no-op, so
 * running it twice changes nothing and reports success rather than a
 * unique-constraint error dressed up as a failure.
 */
export async function assignTeamMembers(
  raw: unknown,
): Promise<RosterActionResult<{ added: number }>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = teamAssignmentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Choose a project and at least one person.",
      };
    }
    const { teamId, projectId, userIds } = parsed.data;

    const [team, project] = await Promise.all([
      prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, key: true },
      }),
    ]);
    if (!team) return { ok: false, error: "That team no longer exists." };
    if (!project) return { ok: false, error: "That project no longer exists." };

    const people = await activeUsers(userIds);
    if (people.length === 0) {
      return { ok: false, error: "None of those people are available." };
    }

    await prisma.$transaction(async (tx) => {
      for (const userId of people) {
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId, userId } },
          update: {},
          create: { teamId, userId },
        });
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId } },
          update: {},
          create: { projectId, userId },
        });
      }
    });

    revalidatePath("/admin");
    revalidatePath(`/projects/${project.key.toLowerCase()}`);
    revalidatePath(`/projects/${project.key.toLowerCase()}/summary`);

    return { ok: true, data: { added: people.length } };
  } catch (error) {
    return failure(error);
  }
}

/* -------------------------------------------------- developer assignment */

/**
 * Onboard developers: teams, project, account role, and the work itself.
 *
 * Issues are dealt out to the chosen people in the order both were given —
 * round-robin, so four issues across two developers is two each and one
 * developer takes all of them. An issue holds a single assignee, so handing the
 * same one to several people is not a thing the model can express; dealing them
 * out is the reading that neither drops a selection nor invents a second
 * assignee column.
 *
 * `teamIds` is a list because the full stack roster is two teams and the
 * developer roster is one. Everything else about the act is identical, and
 * writing it twice is how the two would drift.
 *
 * Every id is re-checked here. In particular each issue must belong to the
 * project that was chosen — the dialog filters the list, but a filtered list is
 * not what makes the write safe.
 */
async function onboard(
  actorId: string,
  input: {
    teamIds: string[];
    projectId: string;
    issueIds: string[];
    role: "ADMIN" | "MEMBER";
    userIds: string[];
  },
): Promise<RosterActionResult<{ added: number; assigned: number }>> {
  const { teamIds, projectId, issueIds, role, userIds } = input;

  const [teams, project] = await Promise.all([
    prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, key: true },
    }),
  ]);
  if (teams.length !== teamIds.length) {
    return { ok: false, error: "That team no longer exists." };
  }
  if (!project) return { ok: false, error: "That project no longer exists." };

  const people = await activeUsers(userIds);
  if (people.length === 0) {
    return { ok: false, error: "None of those people are available." };
  }

  /* Every issue must be this project's. Checked against the database rather
     than trusted from the payload: the dropdown narrows the choice, and this
     is what makes the narrowing binding. */
  const issues =
    issueIds.length > 0
      ? await prisma.issue.findMany({
          where: { id: { in: issueIds }, projectId },
          select: {
            id: true,
            key: true,
            title: true,
            type: true,
            assigneeId: true,
          },
        })
      : [];

  if (issues.length !== issueIds.length) {
    return {
      ok: false,
      error:
        "One or more of those issues do not belong to the selected project.",
    };
  }

  /*
   * The account role goes through the existing People-screen mutation, which
   * carries the rules this must not re-implement: nobody demotes themselves,
   * and the organization is never left without an administrator.
   *
   * Done before the transaction rather than inside it, because `setUserRole`
   * owns its own client and cannot join one. First is the right side of that
   * trade: a refused role change is the likely failure, and taking it here
   * means nothing else has been written when it happens. The reverse order
   * would leave a rejected assignment having already changed somebody's role.
   */
  for (const userId of people) {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (current && current.role !== role) {
      const result = await setUserRole(userId, role);
      if (!result.ok) return { ok: false, error: result.error };
    }
  }

  let assigned = 0;

  await prisma.$transaction(async (tx) => {
    for (const userId of people) {
      for (const teamId of teamIds) {
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId, userId } },
          update: {},
          create: { teamId, userId },
        });
      }
      /* Project access first: an assignee must be a member of the project
         they are assigned in, which is the rule `createIssue` already
         enforces. Doing it in this order means the assignment below can
         never create the state that rule forbids. */
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId } },
        update: {},
        create: { projectId, userId },
      });
    }

    for (const [index, issue] of issues.entries()) {
      const userId = people[index % people.length]!;
      if (issue.assigneeId === userId) continue;

      await tx.issue.update({
        where: { id: issue.id },
        data: { assigneeId: userId },
      });

      await recordFieldChanges(tx, {
        issueId: issue.id,
        actorId,
        changes: [
          {
            field: "assigneeId",
            oldValue: issue.assigneeId,
            newValue: userId,
          },
        ],
      });

      await notify(tx, {
        issueId: issue.id,
        actorId,
        userIds: [userId, ...(await watcherIds(tx, issue.id))],
        type: "ISSUE_ASSIGNED",
        message: assignmentMessage({
          issueKey: issue.key,
          issueTitle: issue.title,
          typeLabel: ISSUE_TYPE_LABEL[issue.type].toLowerCase(),
          tester: await isTester(tx, userId),
        }),
      });

      assigned += 1;
    }
  });

  revalidatePath("/admin");
  revalidatePath(`/projects/${project.key.toLowerCase()}`);
  revalidatePath(`/projects/${project.key.toLowerCase()}/summary`);

  return { ok: true, data: { added: people.length, assigned } };
}

/** Onboard developers onto the Development team. */
export async function assignDevelopers(
  raw: unknown,
): Promise<RosterActionResult<{ added: number; assigned: number }>> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    const parsed = developerAssignmentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Choose a project, a role and at least one person.",
      };
    }
    const { teamId, ...rest } = parsed.data;
    return await onboard(actor.id, { teamIds: [teamId], ...rest });
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------- the derived full stack roster */

/**
 * The Full Stack Developers team, created the first time one is needed.
 *
 * Its own row now, rather than two other rosters read together, so there is
 * something to put people on. `upsert` by slug because an installation that
 * predates the team should grow one the first time an administrator adds
 * somebody, rather than refusing until a seed has been run — team rows are
 * created on demand everywhere else here too. The slug is the one
 * `workRoleFromTeams` reads, so what this writes is what the role rule counts.
 */
async function fullStackTeamId(): Promise<string> {
  const team = await prisma.team.upsert({
    where: { slug: FULLSTACK_TEAM_SLUG },
    update: {},
    create: {
      slug: FULLSTACK_TEAM_SLUG,
      name: "Full Stack Developers",
      description:
        "Builds and verifies. A membership of its own — holding it changes nothing about Development or Testing.",
    },
    select: { id: true },
  });
  return team.id;
}

/**
 * Onboard full stack developers.
 *
 * The same act as `assignDevelopers`, against the Full Stack roster. One
 * membership is written and one only: somebody added here is a Full Stack
 * Developer because of *this* row, and whether they are also on Development or
 * on Testing is a separate question nobody has been asked. It used to write
 * both of those, which meant onboarding a full stack developer silently
 * enrolled them in two other rosters they had never been put on.
 */
export async function assignFullStackDevelopers(
  raw: unknown,
): Promise<RosterActionResult<{ added: number; assigned: number }>> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    const parsed = fullStackAssignmentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Choose a project, a role and at least one person.",
      };
    }

    return await onboard(actor.id, {
      teamIds: [await fullStackTeamId()],
      ...parsed.data,
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Take somebody off the full stack roster.
 *
 * The Full Stack row goes, and nothing else does. This used to delete the
 * Development and Testing rows as well, reasoning that leaving one behind would
 * silently turn a full stack developer into a tester — but those rows are
 * memberships somebody was granted deliberately and separately, and deleting
 * them here destroyed a decision this action was never asked about. Somebody
 * who is on Testing in their own right and is taken off this list reads as a
 * tester afterwards because that is what they still are.
 *
 * Project access and assigned work are untouched for the same reason, as they
 * always have been: they are other facts, they are edited from the profile, and
 * a team roster is not where they are taken away.
 */
export async function removeFullStackDeveloper(
  raw: unknown,
): Promise<RosterActionResult<{ removed: number }>> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    const parsed = fullStackRemovalSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose someone to remove." };
    }

    const removed = await prisma.teamMember.deleteMany({
      where: {
        userId: parsed.data.userId,
        team: { slug: FULLSTACK_TEAM_SLUG },
      },
    });

    revalidatePath("/admin");
    return { ok: true, data: { removed: removed.count } };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------- lookups */

export interface RosterIssueOption {
  id: string;
  key: string;
  title: string;
  type: string;
  status: string;
  /**
   * Who holds it, by id.
   *
   * The name is for reading; this is for deciding. The roster editor starts
   * from the issues a person already holds, and matching that on the displayed
   * name is wrong in a way that loses data: two people called the same thing
   * pre-select each other's work, and a name that does not match at all
   * pre-selects nothing — after which saving releases everything they held,
   * because the save replaces the selection for that project.
   */
  assigneeId: string | null;
  assigneeName: string | null;
  /**
   * Which project it is in.
   *
   * The picker used to be one project's issues, so this was implicit. It can
   * now show several at once, and an issue key on its own does not always say
   * which — so the project travels with the row rather than being inferred
   * from whatever was last selected.
   */
  projectId: string;
  projectKey: string;
}

/**
 * The issues of one project, for the Developer dialog's dependent dropdown.
 *
 * Queried by project id, so nothing from another project can be returned —
 * which is the same guarantee the write above re-checks. Administrator-only,
 * like everything else here.
 */
export async function listProjectIssues(
  projectId: string,
): Promise<RosterActionResult<RosterIssueOption[]>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    if (!projectId) return { ok: true, data: [] };

    return await issueOptionsIn([projectId]);
  } catch (error) {
    return failure(error);
  }
}

/**
 * The issues of several projects at once, for the profile editor.
 *
 * One query rather than one per project, and each row says which project it
 * belongs to, so the picker can group what it offers and the save below can
 * check every id against the set of projects actually being edited.
 *
 * The cap is per request and applies to the whole selection. It is a picker,
 * not an export; the selection the editor *starts* from comes from
 * `issuesAssignedAcross`, which has no cap, so nothing a person holds can fall
 * off the end of this list and be released for never having been shown.
 */
export async function listIssuesForProjects(
  projectIds: string[],
): Promise<RosterActionResult<RosterIssueOption[]>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    return await issueOptionsIn(projectIds);
  } catch (error) {
    return failure(error);
  }
}

/**
 * The shared query behind both pickers. Caller has already checked the actor.
 *
 * One query per project rather than one across all of them, because the cap
 * has to be per project. A single capped query ordered by project hands back
 * the first project's rows until the limit runs out — Engineering alone has
 * 985 — and the second project simply never appears in the picker. Each
 * project bringing its own 500 means every project asked for is represented.
 */
async function issueOptionsIn(
  projectIds: string[],
): Promise<RosterActionResult<RosterIssueOption[]>> {
  const wanted = [...new Set(projectIds.filter((id) => id.length > 0))];
  if (wanted.length === 0) return { ok: true, data: [] };

  const perProject = await Promise.all(
    wanted.map((projectId) =>
      prisma.issue.findMany({
        where: { projectId },
        orderBy: [{ status: "asc" }, { key: "asc" }],
        select: {
          id: true,
          key: true,
          title: true,
          type: true,
          status: true,
          assigneeId: true,
          assignee: { select: { name: true } },
          project: { select: { id: true, key: true } },
        },
        take: 500,
      }),
    ),
  );

  return {
    ok: true,
    data: perProject.flat().map((issue) => ({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      type: issue.type,
      status: issue.status,
      assigneeId: issue.assigneeId,
      assigneeName: issue.assignee?.name ?? null,
      projectId: issue.project.id,
      projectKey: issue.project.key,
    })),
  };
}

/**
 * The issues this person currently holds in this project — every one of them.
 *
 * The editor needs this separately from the list it displays, and the reason is
 * the cap on that list. `listProjectIssues` returns at most 500 rows, which is
 * a sensible size for a picker and far short of a real project: the seed's own
 * Engineering project has 985. Seeding the selection from those rows therefore
 * missed everything past the cap, and because the save *replaces* this person's
 * assignments within the project, saving an untouched editor released every one
 * of them.
 *
 * Answered by its own query, unaffected by any cap, so the selection the editor
 * starts from is what the person actually holds. An issue outside the visible
 * rows stays selected and therefore stays theirs — it cannot be deselected by
 * an administrator who was never shown it, which is the right way round.
 */
export async function issuesAssignedTo(
  projectId: string,
  userId: string,
): Promise<RosterActionResult<string[]>> {
  try {
    const admin = await requireUser();
    assertAdmin(admin);

    if (!projectId || !userId) return { ok: true, data: [] };

    const rows = await prisma.issue.findMany({
      where: { projectId, assigneeId: userId },
      select: { id: true },
    });

    return { ok: true, data: rows.map((row) => row.id) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The same answer across several projects.
 *
 * What the profile editor starts from once it can show more than one project
 * at a time. Uncapped, for the reason above: the save replaces this person's
 * assignments across every project being edited, so a selection that began
 * short of what they hold would release the difference.
 */
export async function issuesAssignedAcross(
  projectIds: string[],
  userId: string,
): Promise<RosterActionResult<string[]>> {
  try {
    const admin = await requireUser();
    assertAdmin(admin);

    const wanted = projectIds.filter((id) => id.length > 0);
    if (wanted.length === 0 || !userId) return { ok: true, data: [] };

    const rows = await prisma.issue.findMany({
      where: { projectId: { in: wanted }, assigneeId: userId },
      select: { id: true },
    });

    return { ok: true, data: rows.map((row) => row.id) };
  } catch (error) {
    return failure(error);
  }
}

export interface RosterProfile {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
  workRole: WorkRole;
  projects: { id: string; key: string; name: string }[];
  issues: {
    id: string;
    key: string;
    title: string;
    type: string;
    status: string;
    projectKey: string;
  }[];
}

/**
 * One roster member's profile: who they are, what they may open, what is
 * theirs.
 *
 * The role shown is the *work* role from `workRoleOf` — the same derivation
 * every other surface uses, so a profile can never disagree with the badge on
 * that person's own dashboard. It is not read from the team whose block the
 * profile was opened from: somebody on Development who is also on Testing is a
 * QA member, and saying "Developer" here because of which card was clicked
 * would be the one place in Prio that answers this question differently.
 */
export async function loadRosterProfile(
  userId: string,
): Promise<RosterActionResult<RosterProfile>> {
  try {
    const admin = await requireUser();
    assertAdmin(admin);

    const person = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        jobTitle: true,
        role: true,
        isActive: true,
        projectMemberships: {
          orderBy: { project: { name: "asc" } },
          select: {
            project: { select: { id: true, key: true, name: true } },
          },
        },
      },
    });
    if (!person) return { ok: false, error: "That person no longer exists." };

    const issues = await prisma.issue.findMany({
      where: { assigneeId: userId },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        key: true,
        title: true,
        type: true,
        status: true,
        project: { select: { key: true } },
      },
      take: 100,
    });

    /* The whole row, so this is the same `CurrentUser` every other caller
       passes rather than a cast-shaped approximation of one. */
    const workRole = await workRoleOf({
      id: person.id,
      name: person.name,
      email: person.email,
      image: person.image,
      role: person.role,
      jobTitle: person.jobTitle,
      isActive: person.isActive,
    });

    return {
      ok: true,
      data: {
        id: person.id,
        name: person.name,
        email: person.email,
        image: person.image,
        jobTitle: person.jobTitle,
        workRole,
        projects: person.projectMemberships.map((m) => m.project),
        issues: issues.map((issue) => ({
          id: issue.id,
          key: issue.key,
          title: issue.title,
          type: issue.type,
          status: issue.status,
          projectKey: issue.project.key,
        })),
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------- editing one person's work */

const rosterEditSchema = z.object({
  userId: z.string().min(1),
  /**
   * Every project this person should be on when the save finishes.
   *
   * A set rather than one id, because somebody works on more than one project
   * and editing the second used to mean losing the first. Empty is a legal
   * answer — it means "on nothing" — and it is the only way the editor can
   * express taking away the last project somebody has.
   */
  projectIds: z.array(z.string().min(1)),
  /** The issues, across those projects, this person should end up holding. */
  issueIds: z.array(z.string().min(1)),
});

/**
 * Change what one person is on and what they are holding, from their profile.
 *
 * The Add dialogs onboard several people at once; this is the other half —
 * going back to somebody already on a roster and moving them. It writes the
 * same three facts, with the same rules, for one person:
 *
 *   `ProjectMember`  they are put on every project named
 *   `ProjectMember`  projects they were on and are no longer named are dropped
 *   `Issue.assignee` the issues named become theirs
 *   `Issue.assignee` issues in the projects being edited that were theirs and
 *                    are no longer named are put down
 *
 * The removals are what make this an edit rather than another add. The editor
 * hands over the full picture, so something disappearing from it is an
 * instruction, not an omission.
 *
 * What it will not touch is anything outside that picture. A person's work in
 * a project they are being taken off is released, because an assignee has to
 * be a member of the project they are assigned in and leaving those rows would
 * break that rule quietly — but nothing else moves, and a project that was
 * never in the request is neither joined nor left.
 *
 * Every id is re-checked: the person exists and is active, every project
 * exists, and every issue named belongs to one of the projects named. The
 * editor filters its own lists; this is what makes the filtering binding.
 * Administrator-only, like the rest of this file.
 */
export async function updateRosterAssignment(
  raw: unknown,
): Promise<
  RosterActionResult<{
    assigned: number;
    released: number;
    joined: number;
    left: number;
  }>
> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    const parsed = rosterEditSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose the projects for this person." };
    }
    const { userId, issueIds } = parsed.data;
    // Duplicates in the payload would inflate every count reported back.
    const projectIds = [...new Set(parsed.data.projectIds)];

    const person = await prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true },
    });
    if (!person) return { ok: false, error: "That person is not available." };

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, key: true },
    });
    if (projects.length !== projectIds.length) {
      return { ok: false, error: "One of those projects no longer exists." };
    }

    /* What they are on now. The difference against the request is the whole
       of what this edit does to their access. */
    const memberships = await prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true, project: { select: { key: true } } },
    });

    const wanted = new Set(projectIds);
    const held = new Set(memberships.map((row) => row.projectId));
    const joining = projectIds.filter((id) => !held.has(id));
    const leaving = memberships.filter((row) => !wanted.has(row.projectId));

    /*
     * The projects whose assignments this edit may rewrite: the ones named,
     * and the ones being left. Work in any other project is not in the
     * picture the editor showed and is therefore not its to touch.
     */
    const scope = [...projectIds, ...leaving.map((row) => row.projectId)];

    const [named, currentlyTheirs] = await Promise.all([
      issueIds.length > 0
        ? prisma.issue.findMany({
            where: { id: { in: issueIds }, projectId: { in: projectIds } },
            select: {
              id: true,
              key: true,
              title: true,
              type: true,
              assigneeId: true,
            },
          })
        : Promise.resolve([]),
      scope.length > 0
        ? prisma.issue.findMany({
            where: { projectId: { in: scope }, assigneeId: userId },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    if (named.length !== new Set(issueIds).size) {
      return {
        ok: false,
        error:
          "One or more of those issues do not belong to the selected projects.",
      };
    }

    const keep = new Set(named.map((issue) => issue.id));
    const release = currentlyTheirs.filter((issue) => !keep.has(issue.id));

    let assigned = 0;

    await prisma.$transaction(async (tx) => {
      // Access before assignment, the order `onboard` uses and for the same
      // reason: an assignee must be a member of the project.
      for (const projectId of projectIds) {
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId } },
          update: {},
          create: { projectId, userId },
        });
      }

      for (const issue of named) {
        if (issue.assigneeId === userId) continue;

        await tx.issue.update({
          where: { id: issue.id },
          data: { assigneeId: userId },
        });
        await recordFieldChanges(tx, {
          issueId: issue.id,
          actorId: actor.id,
          changes: [
            {
              field: "assigneeId",
              oldValue: issue.assigneeId,
              newValue: userId,
            },
          ],
        });
        await notify(tx, {
          issueId: issue.id,
          actorId: actor.id,
          userIds: [userId, ...(await watcherIds(tx, issue.id))],
          type: "ISSUE_ASSIGNED",
          message: assignmentMessage({
            issueKey: issue.key,
            issueTitle: issue.title,
            typeLabel: ISSUE_TYPE_LABEL[issue.type].toLowerCase(),
            tester: await isTester(tx, userId),
          }),
        });
        assigned += 1;
      }

      for (const issue of release) {
        await tx.issue.update({
          where: { id: issue.id },
          data: { assigneeId: null },
        });
        await recordFieldChanges(tx, {
          issueId: issue.id,
          actorId: actor.id,
          changes: [{ field: "assigneeId", oldValue: userId, newValue: null }],
        });
      }

      /* Membership last. Everything they held in these projects has just been
         released above, so nothing is left assigned to somebody who can no
         longer open it. */
      if (leaving.length > 0) {
        await tx.projectMember.deleteMany({
          where: {
            userId,
            projectId: { in: leaving.map((row) => row.projectId) },
          },
        });
      }
    });

    revalidatePath("/admin");
    revalidatePath("/my-work");
    for (const key of [
      ...projects.map((project) => project.key),
      ...leaving.map((row) => row.project.key),
    ]) {
      revalidatePath(`/projects/${key.toLowerCase()}`);
      revalidatePath(`/projects/${key.toLowerCase()}/summary`);
    }

    return {
      ok: true,
      data: {
        assigned,
        released: release.length,
        joined: joining.length,
        left: leaving.length,
      },
    };
  } catch (error) {
    return failure(error);
  }
}
