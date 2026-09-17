import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Moving work on the Flow Board, now that nothing has to be ticked first.
 *
 * Cards used to carry a checkbox so several could be selected and moved
 * together. It is gone: a card is moved by dragging it or by picking a status
 * from its own menu, and the issue's own status is what decides the column it
 * is drawn in — there is no board-side status to disagree with it.
 *
 * Every issue here is created by the spec and deleted afterwards.
 */

const created: string[] = [];

function stamp(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function seedIssue(status: "TODO" | "IN_PROGRESS", title: string) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key: "ENG" },
    select: { id: true, key: true, issueSequence: true },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const number = project.issueSequence + 1;
  const issue = await prisma.issue.create({
    data: {
      key: `${project.key}-${number}`,
      number,
      projectId: project.id,
      type: "TASK",
      title,
      status,
      priority: "MEDIUM",
      reporterId: admin.id,
    },
    select: { id: true, key: true },
  });
  await prisma.project.update({
    where: { id: project.id },
    data: { issueSequence: number },
  });

  created.push(issue.id);
  return issue;
}

function card(page: Page, issueKey: string): Locator {
  return page.locator(".prio-board__card").filter({ hasText: issueKey });
}

async function columnOf(page: Page, issueKey: string): Promise<string> {
  return (
    await page
      .locator(".prio-board__column")
      .filter({ has: page.locator(".prio-board__card", { hasText: issueKey }) })
      .locator(".prio-board__column-title")
      .first()
      .innerText()
  )
    .split("\n")[0]!
    .trim();
}

async function setStatus(page: Page, issueKey: string, label: string) {
  await card(page, issueKey).locator(".prio-board__card-statustrigger").click();
  await page
    .getByRole("menu", { name: `Change status of ${issueKey}` })
    .getByRole("menuitemradio", { name: label, exact: true })
    .click();
}

test.describe("The Flow Board", () => {
  test.use({ storageState: ADMIN_STATE });

  test.afterAll(async () => {
    if (created.length > 0) {
      await prisma.notification.deleteMany({
        where: { issueId: { in: created } },
      });
      await prisma.issue.deleteMany({ where: { id: { in: created } } });
    }
  });

  test("offers no checkbox on a card — moving work needs nothing ticked", async ({
    page,
  }) => {
    const issue = await seedIssue("TODO", `No checkbox ${stamp()}`);

    await page.goto("/projects/eng/board");
    await expect(card(page, issue.key)).toBeVisible();

    // The card itself carries none…
    await expect(card(page, issue.key).locator('input[type="checkbox"]')).toHaveCount(
      0,
    );
    // …and neither does any other card on the board.
    await expect(
      page.locator('.prio-board__card input[type="checkbox"]'),
    ).toHaveCount(0);

    // The banner the ticking used to raise is gone with it.
    await expect(page.locator(".prio-board__selection")).toHaveCount(0);

    // What replaced it is still there: the card's own status control.
    await expect(
      card(page, issue.key).locator(".prio-board__card-statustrigger"),
    ).toBeVisible();
  });

  test("moves a card to the column its new status names, and keeps it there", async ({
    page,
  }) => {
    const issue = await seedIssue("TODO", `Moves column ${stamp()}`);

    await page.goto("/projects/eng/board");
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("NEW");

    await setStatus(page, issue.key, "In Progress");

    // The board redraws it under the new column…
    await expect
      .poll(async () => columnOf(page, issue.key))
      .toBe("IN PROGRESS");

    // …because the issue itself really moved, which is the authority.
    await expect
      .poll(
        async () =>
          (
            await prisma.issue.findUniqueOrThrow({
              where: { id: issue.id },
              select: { status: true },
            })
          ).status,
      )
      .toBe("IN_PROGRESS");

    // And it is still there after a reload, rather than springing back.
    await page.reload();
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("IN PROGRESS");
  });

  test("reflects a status change made elsewhere in Prio", async ({ page }) => {
    /* The column follows `Issue.status` rather than anything the board keeps
       of its own, so a change made away from the board still lands correctly. */
    const issue = await seedIssue("TODO", `Changed elsewhere ${stamp()}`);

    await page.goto("/projects/eng/board");
    expect(await columnOf(page, issue.key)).toBe("NEW");

    await prisma.issue.update({
      where: { id: issue.id },
      data: { status: "IN_PROGRESS" },
    });

    await page.reload();
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("IN PROGRESS");
  });
});
