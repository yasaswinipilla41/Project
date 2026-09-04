import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { BOARD_STATUSES } from "@/lib/board";

/**
 * Reopen and Reject / Not an Issue on the Flow Board.
 *
 * They are statuses, not columns: Reopen is drawn in **New** and Reject in
 * **Done**, and the board must still have exactly the seven columns it always
 * had. Everything below is asserted on the rendered board — which column the
 * card is in, what its status control says, and whether it is still saying it
 * after a reload — because the complaint this answers was about what the board
 * showed, not about what the database held.
 */

const stamp = () => Math.random().toString(36).slice(2, 7).toUpperCase();

/** Issues this run created, removed however it ends. */
const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
});

/** Files an issue in ENG directly, so the test starts from a known status. */
async function seedIssue(status: string, title: string) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key: "ENG" },
    select: { id: true, key: true, issueSequence: true },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const number = project.issueSequence + 1;
  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      number,
      key: `${project.key}-${number}`,
      type: "TASK",
      title,
      status: status as never,
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

/** The card for this issue key, wherever it is on the board. */
function card(page: Page, issueKey: string): Locator {
  return page.locator(".prio-board__card").filter({ hasText: issueKey });
}

/** The board column a card is currently drawn in, by its header title. */
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

/** Picks a status from a card's own status control. */
async function setStatus(page: Page, issueKey: string, label: string) {
  await card(page, issueKey)
    .locator(".prio-board__card-statustrigger")
    .click();
  await page
    .getByRole("menu", { name: `Change status of ${issueKey}` })
    .getByRole("menuitemradio", { name: label, exact: true })
    .click();
}

test.describe("The board's columns are unchanged", () => {
  test("still has exactly the seven columns, in order, with no Reopen or Reject column", async ({
    page,
  }) => {
    await page.goto("/projects/eng/board");
    const titles = (
      await page.locator(".prio-board__column-title").allInnerTexts()
    ).map((t) => t.split("\n")[0]!.trim());

    expect(titles).toEqual([
      "BACKLOG",
      "NEW",
      "IN PROGRESS",
      "READY FOR QA",
      "IN QA",
      "DONE",
      "CANCELLED",
    ]);
    expect(titles).toHaveLength(BOARD_STATUSES.length);

    for (const title of titles) {
      expect(title).not.toContain("REOPEN");
      expect(title).not.toContain("REJECT");
    }
  });
});

test.describe("The card's status dropdown", () => {
  test("offers Reopen and Reject / Not an Issue alongside every existing status", async ({
    page,
  }) => {
    const issue = await seedIssue("TODO", `Status menu ${stamp()}`);

    await page.goto("/projects/eng/board");
    await expect(card(page, issue.key)).toBeVisible();

    await card(page, issue.key)
      .locator(".prio-board__card-statustrigger")
      .click();

    const menu = page.getByRole("menu", { name: `Change status of ${issue.key}` });
    await menu.waitFor();
    const options = (await menu.getByRole("menuitemradio").allInnerTexts()).map(
      (t) => t.replace(/\s+/g, " ").trim(),
    );

    // The two this change is about...
    expect(options).toContain("Reopen");
    expect(options).toContain("Reject / Not an Issue");

    // ...and every status that was already there.
    for (const existing of [
      "Backlog",
      "New",
      "In Progress",
      "Ready for QA",
      "In QA",
      "Done",
      "Cancelled",
    ]) {
      expect(options, `${existing} must remain available`).toContain(existing);
    }
    expect(options).toHaveLength(9);
  });
});

test.describe("Reopen", () => {
  test("lands in New, displays as Reopen, and survives a reload", async ({
    page,
  }) => {
    const issue = await seedIssue("DONE", `Reopen target ${stamp()}`);

    await page.goto("/projects/eng/board");
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("DONE");

    await setStatus(page, issue.key, "Reopen");

    // Drawn in the existing New column, and saying what it actually is.
    await expect
      .poll(async () => columnOf(page, issue.key), { timeout: 20_000 })
      .toBe("NEW");
    await expect(
      card(page, issue.key).locator('.prio-status[data-status="REOPENED"]'),
    ).toHaveText("Reopen");

    // Persisted, not client state.
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { status: true },
        })
      ).status,
    ).toBe("REOPENED");

    await page.reload();
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("NEW");
    await expect(
      card(page, issue.key).locator('.prio-status[data-status="REOPENED"]'),
    ).toHaveText("Reopen");
  });
});

test.describe("Reject / Not an Issue", () => {
  test("lands in Done, displays as Reject / Not an Issue, and survives a reload", async ({
    page,
  }) => {
    const issue = await seedIssue("TODO", `Reject target ${stamp()}`);

    await page.goto("/projects/eng/board");
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("NEW");

    await setStatus(page, issue.key, "Reject / Not an Issue");

    await expect
      .poll(async () => columnOf(page, issue.key), { timeout: 20_000 })
      .toBe("DONE");
    await expect(
      card(page, issue.key).locator('.prio-status[data-status="REJECTED"]'),
    ).toHaveText("Reject / Not an Issue");

    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { status: true },
        })
      ).status,
    ).toBe("REJECTED");

    await page.reload();
    await expect(card(page, issue.key)).toBeVisible();
    expect(await columnOf(page, issue.key)).toBe("DONE");
    await expect(
      card(page, issue.key).locator('.prio-status[data-status="REJECTED"]'),
    ).toHaveText("Reject / Not an Issue");
  });
});

test.describe("The statuses a shared column already held still work", () => {
  test("an ordinary New issue is still New, and an ordinary Done issue still Done", async ({
    page,
  }) => {
    const todo = await seedIssue("TODO", `Plain new ${stamp()}`);
    const done = await seedIssue("DONE", `Plain done ${stamp()}`);

    await page.goto("/projects/eng/board");

    expect(await columnOf(page, todo.key)).toBe("NEW");
    await expect(
      card(page, todo.key).locator('.prio-status[data-status="TODO"]'),
    ).toHaveText("New");

    expect(await columnOf(page, done.key)).toBe("DONE");
    await expect(
      card(page, done.key).locator('.prio-status[data-status="DONE"]'),
    ).toHaveText("Done");
  });

  test("moving through the ordinary path still means what it did", async ({
    page,
  }) => {
    const issue = await seedIssue("IN_REVIEW", `Ordinary path ${stamp()}`);

    await page.goto("/projects/eng/board");
    expect(await columnOf(page, issue.key)).toBe("READY FOR QA");

    // Ready for QA -> Done is the reviewed path, and still means Done.
    await setStatus(page, issue.key, "Done");
    await expect
      .poll(async () => columnOf(page, issue.key), { timeout: 20_000 })
      .toBe("DONE");
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { status: true },
        })
      ).status,
    ).toBe("DONE");
  });
});

test.describe("The status filter", () => {
  test("can select Reopen on its own, and its column still selects both", async ({
    page,
  }) => {
    const reopened = await seedIssue("REOPENED", `Filter reopened ${stamp()}`);
    const plain = await seedIssue("TODO", `Filter plain new ${stamp()}`);

    await page.goto("/projects/eng/board");

    // Asking for Reopen alone leaves the ordinary New issue out.
    await page
      .locator(".prio-board__filters")
      .getByRole("button", { name: "Status" })
      .click();
    const menu = page.getByRole("menu", { name: "Status" });
    await menu.getByRole("menuitemradio", { name: "Reopen", exact: true }).click();
    await page.keyboard.press("Escape");

    await expect(card(page, reopened.key)).toBeVisible();
    await expect(card(page, plain.key)).toHaveCount(0);
    // And it is still drawn in New, not in a column of its own.
    expect(await columnOf(page, reopened.key)).toBe("NEW");

    // Swapping to the column's own name brings both back — the behaviour the
    // filter always had for a column.
    await page
      .locator(".prio-board__filters")
      .getByRole("button", { name: "Status" })
      .click();
    await menu.getByRole("menuitemradio", { name: "Reopen", exact: true }).click();
    await menu.getByRole("menuitemradio", { name: "New", exact: true }).click();
    await page.keyboard.press("Escape");

    await expect(card(page, reopened.key)).toBeVisible();
    await expect(card(page, plain.key)).toBeVisible();
  });
});
