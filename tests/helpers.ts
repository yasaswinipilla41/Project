import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
  TESTING_TEAM_SLUG,
} from "@/lib/authz";
import { testHeaders } from "./setup";

/**
 * Signs in as a seeded user and installs the resulting session cookie so that
 * subsequent server-action calls run as that person. Uses the real sign-in
 * endpoint — no session is fabricated.
 */
export async function actAs(email: string, password = "Prio@12345") {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Sign-in failed for ${email}: no session cookie returned`);
  }

  // "prio.session_token=abc; Path=/; ..." -> "prio.session_token=abc"
  const cookiePairs = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((part) => part.split(";")[0]!.trim())
    .join("; ");

  testHeaders.current = new Headers({ cookie: cookiePairs });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, name: true, email: true, role: true },
  });

  return user;
}

/** Clears the acting session so an action runs unauthenticated. */
export function actAsAnonymous(): void {
  testHeaders.current = new Headers();
}

export async function projectByKey(key: string) {
  return prisma.project.findUniqueOrThrow({
    where: { key },
    select: { id: true, key: true, issueSequence: true },
  });
}

/** Removes issues created by a test run, along with their dependent rows. */
export async function deleteIssues(issueIds: string[]): Promise<void> {
  if (issueIds.length === 0) return;
  await prisma.issue.deleteMany({ where: { id: { in: issueIds } } });
}

/* ------------------------------------------------------------ work roles */

/**
 * Makes somebody a tester for the duration of a test, and hands back the undo.
 *
 * Prio decides developer-or-tester by membership of the Testing team — see
 * `workRoleOf`. The seed puts nobody on it, so every member is a developer;
 * a test that needs a tester makes one, and puts the fixture back exactly as
 * it found it. The team row itself is created if this installation has none
 * and left alone if it already did, because other people may be on it.
 */
export async function actAsTester(email: string, password?: string) {
  const user = await joinTestingTeam(email);
  const session = await actAs(email, password);
  return { ...session, leaveTestingTeam: user.leave };
}

/** The rosters a working role is derived from, and what they are called. */
const WORK_TEAM_NAMES: Record<string, string> = {
  [TESTING_TEAM_SLUG]: "Testing",
  [DEVELOPMENT_TEAM_SLUG]: "Development",
  [FULLSTACK_TEAM_SLUG]: "Full Stack Developers",
};

/** Exactly the rows that produce each working role, and no others. */
const TEAMS_FOR: Record<"QA" | "DEVELOPER" | "FULLSTACK", readonly string[]> = {
  QA: [TESTING_TEAM_SLUG],
  DEVELOPER: [DEVELOPMENT_TEAM_SLUG],
  FULLSTACK: [FULLSTACK_TEAM_SLUG],
};

/**
 * Makes somebody hold a working role for the duration, and hands back the undo.
 *
 * Team rows are shared state, and a suite that merely *assumes* somebody is a
 * developer is really asserting whatever the file before it left behind. That
 * is not a hypothetical: a stray Testing row turns a developer into a QA
 * member, and every `claimIssue` in the suite is then refused for a reason the
 * failure message never mentions.
 *
 * So this sets the rosters rather than adding to them — every work team row is
 * cleared and only the ones the role needs are written — and `leave` puts back
 * exactly what was found, whatever that was.
 *
 * An administrator is refused outright. `workRoleOf` answers ADMIN for them
 * whatever teams they hold, so a fixture naming one as a "developer" is a
 * mistake that would otherwise pass quietly: the claim would succeed, because
 * administrators may do anything, and the suite would prove nothing about
 * developers.
 */
export async function holdWorkRole(
  email: string,
  role: "QA" | "DEVELOPER" | "FULLSTACK",
): Promise<{ userId: string; leave: () => Promise<void> }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, role: true },
  });

  if (user.role === "ADMIN") {
    throw new Error(
      `${email} is an administrator, so workRoleOf answers ADMIN whatever ` +
        `teams they hold. Choose a MEMBER account to hold ${role}.`,
    );
  }

  const teams = await prisma.team.findMany({
    where: { slug: { in: Object.keys(WORK_TEAM_NAMES) } },
    select: { id: true, slug: true },
  });
  const idBySlug = new Map(teams.map((team) => [team.slug, team.id]));

  /* A roster with no row cannot be joined. Full Stack is created on demand in
     the application too, so making it here is the same act, not a fixture. */
  for (const slug of TEAMS_FOR[role]) {
    if (idBySlug.has(slug)) continue;
    const made = await prisma.team.create({
      data: { slug, name: WORK_TEAM_NAMES[slug]! },
      select: { id: true, slug: true },
    });
    idBySlug.set(made.slug, made.id);
  }

  const workTeamIds = [...idBySlug.values()];
  const before = await prisma.teamMember.findMany({
    where: { userId: user.id, teamId: { in: workTeamIds } },
    select: { teamId: true },
  });

  await prisma.teamMember.deleteMany({
    where: { userId: user.id, teamId: { in: workTeamIds } },
  });
  for (const slug of TEAMS_FOR[role]) {
    await prisma.teamMember.create({
      data: { teamId: idBySlug.get(slug)!, userId: user.id },
    });
  }

  return {
    userId: user.id,
    leave: async () => {
      await prisma.teamMember.deleteMany({
        where: { userId: user.id, teamId: { in: workTeamIds } },
      });
      for (const row of before) {
        await prisma.teamMember.create({
          data: { teamId: row.teamId, userId: user.id },
        });
      }
    },
  };
}

/**
 * Puts somebody on a project for the duration, and hands back the undo.
 *
 * Project access is the other half of what an issue action checks, and it is
 * shared state too — suites add and remove memberships, so "they are on ENG" is
 * only reliable if the file saying so has made it true. `leave` removes the row
 * only when this call created it, so a membership that was already there is
 * left exactly as it was found.
 */
export async function joinProject(
  projectKey: string,
  email: string,
): Promise<{ userId: string; leave: () => Promise<void> }> {
  const [project, user] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { key: projectKey },
      select: { id: true },
    }),
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
  ]);

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
    select: { id: true },
  });
  if (existing) return { userId: user.id, leave: async () => {} };

  await prisma.projectMember.create({
    data: { projectId: project.id, userId: user.id },
  });

  return {
    userId: user.id,
    leave: async () => {
      await prisma.projectMember.deleteMany({
        where: { projectId: project.id, userId: user.id },
      });
    },
  };
}

/** Adds `email` to the Testing team, returning an undo that only undoes this. */
export async function joinTestingTeam(
  email: string,
): Promise<{ userId: string; leave: () => Promise<void> }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });

  const team =
    (await prisma.team.findUnique({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    })) ??
    (await prisma.team.create({
      data: { slug: TESTING_TEAM_SLUG, name: "Testing" },
      select: { id: true },
    }));

  /*
   * A *pure* tester, which means the Development team matters too.
   *
   * Holding both teams is a Full Stack Developer, who builds as well as
   * checks — so a Development row left behind by another suite, or by an
   * interrupted end-to-end run, silently turns every "a tester may not…" case
   * into "a full stack developer may", and those all pass for the wrong
   * reason. The row is taken away for the duration and put back by `leave`,
   * so a caller that inherits one still leaves the fixture as it found it.
   */
  const development = await prisma.team.findUnique({
    where: { slug: DEVELOPMENT_TEAM_SLUG },
    select: { id: true },
  });
  const buildsToo = development
    ? await prisma.teamMember.findFirst({
        where: { teamId: development.id, userId: user.id },
        select: { id: true },
      })
    : null;
  if (buildsToo) {
    await prisma.teamMember.delete({ where: { id: buildsToo.id } });
  }

  const restoreDevelopment = async () => {
    if (!buildsToo || !development) return;
    await prisma.teamMember.upsert({
      where: {
        teamId_userId: { teamId: development.id, userId: user.id },
      },
      update: {},
      create: { teamId: development.id, userId: user.id },
    });
  };

  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });

  // Already on Testing: leave that row alone, and undo only what was changed.
  if (existing) return { userId: user.id, leave: restoreDevelopment };

  await prisma.teamMember.create({
    data: { teamId: team.id, userId: user.id },
  });

  return {
    userId: user.id,
    /*
     * Removed by who it is, not by which row it was.
     *
     * This deleted `added.id`, which quietly stopped working the moment
     * anything in between deleted and recreated the membership — `holdWorkRole`
     * does exactly that, so a suite using both left the Testing row behind and
     * handed the *next* suite the drift this helper exists to prevent. The
     * membership is identified by team and person instead, which is what the
     * caller actually asked to undo and is true however the row got there.
     */
    leave: async () => {
      await prisma.teamMember.deleteMany({
        where: { teamId: team.id, userId: user.id },
      });
      await restoreDevelopment();
    },
  };
}
