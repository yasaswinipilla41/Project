import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
