import { expect, test, type Page } from "@playwright/test";
import type { IssueStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { completedAssignedFilter } from "@/server/queries/completedWork";
import {
  ADMIN_EMAIL,
  MEMBER_EMAIL,
  MEMBER_STATE,
  watchForProblems,
} from "./support";

/**
 * My Work, after Bugs became Completed and Waiting for testing went.
 *
 * Completed is the work assigned to the reader that is done, and it opens
 * exactly that list: the same rule as Open, Overdue and Due this week beside
 * it, with Done as the category. Waiting for testing is gone because it was
 * the same state as Ready for QA — and Ready for QA stays, with the same
 * issue in it.
 *
 * Home's personal Completed tile has always asked this same question, and the
 * two now read one fragment, so the last test here checks the two pages show
 * one number rather than two.
 */

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
});

/**
 * The My Work stat tile with exactly this label. Matched on the label rather
 * than the tile's text, because the Due this week tile's hint also says
 * "completed".
 */
function statTile(page: Page, label: string) {
  return page
    .locator("a.prio-stat")
    .filter({
      has: page.locator(".prio-stat__label", {
        hasText: new RegExp(`^${label}$`),
      }),
    });
}

async function makeIssue(data: {
  title: string;
  status: IssueStatus;
  assigneeId: string | null;
  reporterId: string;
  /**
   * Who moved it to Done, written as the activity entry `updateIssue` would
   * have written.
   *
   * Completed work belongs to whoever finished it, read from the trail —
   * holding the issue is a different claim about a different question, and an
   * issue can be closed by one person and held by another. A fixture that set
   * only an assignee would therefore be describing work nobody did.
   */
  completedById?: string;
}) {
  const issue = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { key: "ENG" },
      data: { issueSequence: { increment: 1 } },
      select: { id: true, key: true, issueSequence: true },
    });
    const row = await tx.issue.create({
      data: {
        key: `${project.key}-${project.issueSequence}`,
        number: project.issueSequence,
        projectId: project.id,
        title: data.title,
        status: data.status,
        assigneeId: data.assigneeId,
        reporterId: data.reporterId,
        completedAt: data.status === "DONE" ? new Date() : null,
      },
      select: { id: true, key: true },
    });

    if (data.completedById) {
      await tx.activityLogEntry.create({
        data: {
          issueId: row.id,
          actorId: data.completedById,
          action: "issue.updated",
          field: "status",
          oldValue: "IN_QA",
          newValue: "DONE",
        },
      });
    }
    return row;
  });
  created.push(issue.id);
  return issue;
}

test("Completed replaces Bugs, Waiting for testing is gone, and Ready for QA stays", async ({
  page,
}) => {
  const { consoleErrors } = watchForProblems(page);
  const stamp = Date.now();
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
    select: { id: true },
  });
  const other = await prisma.user.findFirstOrThrow({
    where: {
      email: { not: ADMIN_EMAIL },
      projectMemberships: { some: { project: { key: "ENG" } } },
    },
    select: { id: true },
  });

  /* Handed over and not yet tested — exactly what used to appear twice, under
     Waiting for testing and under Ready for QA. */
  const ready = await makeIssue({
    title: `My Work ready ${stamp}`,
    status: "IN_REVIEW",
    assigneeId: admin.id,
    reporterId: admin.id,
  });
  /* Assigned to the admin and done, which is what makes it theirs. Raised by
     and irrelevant to somebody else. */
  const mine = await makeIssue({
    title: `My Work done mine ${stamp}`,
    status: "DONE",
    assigneeId: admin.id,
    reporterId: other.id,
    completedById: admin.id,
  });
  /*
   * Theirs to show, finished by somebody else.
   *
   * The case that tells the two rules apart: the admin holds it and it is
   * done, but a colleague moved it. It used to be missing from this figure —
   * which is what a developer saw when a colleague or an administrator closed
   * work assigned to them — and it belongs in it, because the question is
   * what of my work is finished and not who finished it.
   */
  const heldNotFinished = await makeIssue({
    title: `My Work done by another ${stamp}`,
    status: "DONE",
    assigneeId: admin.id,
    reporterId: admin.id,
    completedById: other.id,
  });
  /* Done, raised by the admin, finished by and assigned to somebody else:
     not the admin's completed work. Raising it is not finishing it. */
  const theirs = await makeIssue({
    title: `My Work done theirs ${stamp}`,
    status: "DONE",
    assigneeId: other.id,
    reporterId: admin.id,
    completedById: other.id,
  });

  await page.goto("/my-work");

  const labels = await page.locator(".prio-stat__label").allTextContents();
  expect(labels.map((label) => label.trim())).toEqual([
    "Open",
    "Completed",
    "Overdue",
    "Due this week",
  ]);

  await expect(
    page.getByRole("heading", { name: /waiting for testing/i }),
  ).toHaveCount(0);

  // Ready for QA is still there, with the handed-over issue in it.
  const readyCard = page
    .locator(".prio-card")
    .filter({
      has: page.locator(".prio-issue__section-title", {
        hasText: "Ready for QA",
      }),
    });
  await expect(readyCard).toHaveCount(1);
  await expect(readyCard).toContainText(ready.key);

  /* Completed counts the work assigned to this person that is done, from the
     shared fragment the page itself reads. */
  const expected = await prisma.issue.count({
    where: completedAssignedFilter([admin.id]),
  });
  const tile = statTile(page, "Completed");
  await expect(tile.locator(".prio-stat__value")).toHaveText(String(expected));

  /*
   * And opens exactly that list, for the signed-in user — on this page now
   * rather than on the global issue list. The rows are the figure's own set:
   * the finished work this person holds, whoever moved it, and nobody
   * else's.
   */
  await tile.click();
  await expect(page).toHaveURL(/\/my-work\?show=completed$/);
  const list = page.locator(".prio-card").filter({
    has: page.locator(".prio-issue__section-title", {
      hasText: "Completed",
    }),
  });
  await expect(list).toContainText(mine.key);
  await expect(list, "theirs to show, a colleague finished it").toContainText(
    heldNotFinished.key,
  );
  await expect(list, "assigned to somebody else").not.toContainText(theirs.key);
  await expect(list, "not finished").not.toContainText(ready.key);

  // The underlying state is untouched: Ready for QA is still a status.
  expect(
    (
      await prisma.issue.findUniqueOrThrow({
        where: { id: ready.id },
        select: { status: true },
      })
    ).status,
  ).toBe("IN_REVIEW");

  expect(consoleErrors).toEqual([]);
});

test("Home's Completed figures keep their own links and their own definition", async ({
  page,
  browser,
}) => {
  /* An administrator's Home answers "how is the organisation doing": its card
     is every Done issue in scope, and opens that list. */
  await page.goto("/");
  const card = page
    .locator("a")
    .filter({ hasText: "Completed issues" })
    .first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", "/issues?status=DONE");

  /* A member's Home has the personal work grid, whose Completed tile is Done
     work assigned to them — unchanged, and the question My Work's Completed
     now asks too. Both are checked below, against one another. */
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true },
  });
  const context = await browser.newContext({ storageState: MEMBER_STATE });
  const memberPage = await context.newPage();
  await memberPage.goto("/");

  const homeTile = memberPage
    .locator("a.prio-worktile")
    .filter({
      has: memberPage.locator(".prio-worktile__label", {
        hasText: /^Completed$/,
      }),
    });
  await expect(homeTile).toHaveCount(1);
  await expect(homeTile).toHaveAttribute(
    "href",
    `/issues?assignee=${member.id}&status=DONE`,
  );

  const homeFigure = await prisma.issue.count({
    where: {
      project: { members: { some: { userId: member.id } } },
      assigneeId: member.id,
      status: "DONE",
    },
  });
  await expect(homeTile.locator(".prio-worktile__value")).toHaveText(
    String(homeFigure),
  );

  /*
   * And My Work says the same number.
   *
   * The two pages used to answer "Completed" differently for the same person
   * — Home counting the work they hold that is done, My Work counting what
   * they had moved to Done — so a member reading both saw two figures for one
   * word. They read one fragment now, and this is the check that they cannot
   * drift apart again.
   */
  await memberPage.goto("/my-work");
  await expect(
    statTile(memberPage, "Completed").locator(".prio-stat__value"),
  ).toHaveText(String(homeFigure));
  await context.close();
});

test("a member's My Work has Completed instead of Bugs, and no Waiting for testing", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: MEMBER_STATE });
  const page = await context.newPage();
  await page.goto("/my-work");

  const labels = (
    await page.locator(".prio-stat__label").allTextContents()
  ).map((l) => l.trim());
  expect(labels).toContain("Completed");
  expect(labels).not.toContain("Bugs");
  await expect(
    page.getByRole("heading", { name: /waiting for testing/i }),
  ).toHaveCount(0);

  /*
   * The tile used to link to the global issue list, which meant leaving My
   * Work to read one of My Work's own figures — and telling that list who
   * "me" was in its query string. It chooses the list on this page now, and
   * the identity stays where it always belonged: the session.
   */
  await expect(statTile(page, "Completed")).toHaveAttribute(
    "href",
    "/my-work?show=completed",
  );
  await context.close();
});
