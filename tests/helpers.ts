import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
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

  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });

  // Already on it: leave it that way, and undo nothing.
  if (existing) return { userId: user.id, leave: async () => {} };

  const added = await prisma.teamMember.create({
    data: { teamId: team.id, userId: user.id },
    select: { id: true },
  });

  return {
    userId: user.id,
    leave: async () => {
      await prisma.teamMember.deleteMany({ where: { id: added.id } });
    },
  };
}
