import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { MEMBER_STATE } from "./support";

/**
 * Being assigned an issue as a tester, in the browser.
 *
 * The rules are covered against the database in
 * `tests/tester-assignment-notification.test.ts`; what this walks is the part
 * a person actually does — an administrator hands an issue to somebody on the
 * Testing team, and that person finds it waiting in their notifications and
 * clicks through to the issue itself.
 */

const MEMBER_EMAIL = "priya.nair@symbiosystech.com";

let teamMemberId: string | null = null;

test.beforeAll(async () => {
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
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

  const already = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: member.id },
    select: { id: true },
  });
  if (!already) {
    const created = await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id },
      select: { id: true },
    });
    teamMemberId = created.id;
  }
});

test.afterAll(async () => {
  if (teamMemberId) {
    await prisma.teamMember.deleteMany({ where: { id: teamMemberId } });
  }
});

test("a tester is told they are the tester, and the notification opens the issue", async ({
  browser,
}) => {
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true, name: true },
  });

  /* An ENG issue they do not already hold, so assigning it is a real change
     and the notification is this test's own.

     `assigneeId: { not: member.id }` alone is not that set: a comparison
     against a value never matches NULL, so it quietly excludes every
     unassigned issue — which is most of them, and exactly the ones this wants.
     Spelling it as an OR includes them, and stops the test depending on some
     other person happening to hold something. */
  const issue = await prisma.issue.findFirstOrThrow({
    where: {
      project: { key: "ENG" },
      OR: [{ assigneeId: null }, { assigneeId: { not: member.id } }],
      status: { in: ["BACKLOG", "TODO", "IN_PROGRESS"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, key: true, title: true, assigneeId: true },
  });

  await prisma.notification.deleteMany({
    where: { userId: member.id, issueId: issue.id, type: "ISSUE_ASSIGNED" },
  });

  // The administrator hands it over, through the issue page.
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`/issues/${issue.key.toLowerCase()}`);

  /* The assignee control, told apart from the status/priority/severity
     triggers beside it by the person it shows. */
  await adminPage
    .locator(".prio-fieldtrigger:has(.prio-fieldtrigger__person)")
    .first()
    .click();
  /* The assignee menu is a radio group — one person out of a set — so its
     entries are `menuitemradio`, not `menuitem`. */
  await adminPage
    .getByRole("menuitemradio", { name: new RegExp(member.name, "i") })
    .first()
    .click();

  await expect
    .poll(
      async () =>
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: issue.id },
            select: { assigneeId: true },
          })
        ).assigneeId,
      { timeout: 15_000 },
    )
    .toBe(member.id);
  await adminContext.close();

  // The tester finds it waiting, worded as a tester assignment.
  const memberContext = await browser.newContext({ storageState: MEMBER_STATE });
  const memberPage = await memberContext.newPage();
  await memberPage.goto("/notifications");

  const row = memberPage
    .locator("button.prio-notification__link")
    .filter({ hasText: /as tester/i })
    .first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(issue.key);

  // …and clicking through lands on that issue.
  await row.click();
  const open = memberPage.getByRole("link", { name: "Open issue" });
  await expect(open).toBeVisible();
  await open.click();
  await expect(memberPage).toHaveURL(
    new RegExp(`/issues/${issue.key.toLowerCase()}$`),
  );

  await memberContext.close();

  /* Hand the issue back to whoever had it. The test has to move an assignee to
     have anything to assert, and leaving it moved is how this spec previously
     ate its own fixture: every run took one more issue out of the pool it
     picks from, until nothing was left that the tester did not already hold. */
  await prisma.issue.update({
    where: { id: issue.id },
    data: { assigneeId: issue.assigneeId },
  });
});
