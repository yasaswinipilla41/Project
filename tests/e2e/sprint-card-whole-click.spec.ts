import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * The whole issue card opens the issue — on a sprint's own page, where the
 * card is never dragged.
 *
 * The card used to open only from its key, because the Flow Board drags these
 * same cards and a drag that ends near where it started still produces a
 * click — turning a card's own move into an accidental navigation. A sprint's
 * page never drags a card (`draggable={false}` throughout its board), so that
 * risk does not exist here and the whole surface can go back to being the
 * target its cursor and hover already promise.
 *
 * What is worth an end-to-end test rather than a unit test is exactly the
 * part a component test cannot see: that pressing a genuinely interactive
 * control — the row menu, the status pill, the Move to button — still does
 * what it always did and never also navigates, and that the Flow Board, which
 * this change was deliberately left out of, still behaves as it did before.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/** A sprint with one card in Backlog and one in Done — the task's own pair. */
async function seedSprintWithBothGroups() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `WC${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Whole-card click fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E whole-card ${Date.now()}`,
      startDate: new Date(),
      endDate: new Date(Date.now() + 13 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  const [backlog, done] = await Promise.all([
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-1`,
        number: 1,
        title: "Card in Backlog",
        type: "TASK",
        status: "BACKLOG",
        reporterId: admin.id,
        assigneeId: admin.id,
        sprintId: sprint.id,
      },
      select: { id: true, key: true },
    }),
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-2`,
        number: 2,
        title: "Card in Done",
        type: "TASK",
        status: "DONE",
        reporterId: admin.id,
        assigneeId: admin.id,
        sprintId: sprint.id,
      },
      select: { id: true, key: true },
    }),
  ]);

  return { key: project.key.toLowerCase(), sprintId: sprint.id, backlog, done };
}

function cardFor(page: Page, issueKey: string): Locator {
  return page.locator(".prio-board__card").filter({ hasText: issueKey });
}

/**
 * Focuses a card and waits for it to actually hold focus, refocusing if it
 * does not.
 *
 * The board re-reads itself when the browser window regains focus — so a
 * reader's status change made in another tab is never stale here — and
 * Playwright's own window can hand focus back to the page right after a
 * navigation, in the same instant a test tries to focus the card by hand.
 * When that race is lost the card this call focused is not the one still on
 * screen a moment later, and a single `.focus()` never gets a second try.
 * Retrying here is a test concern only: nothing about the page is at fault,
 * and the outcome under test — Enter and Space opening the issue — is the
 * same regardless of which attempt actually landed.
 */
async function focusCard(page: Page, issueKey: string): Promise<Locator> {
  await expect(async () => {
    const card = cardFor(page, issueKey);
    await card.focus();
    await expect(card).toBeFocused({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  return cardFor(page, issueKey);
}

test.describe("A sprint card's whole surface opens the issue", () => {
  for (const group of ["backlog", "done"] as const) {
    test(`opens from empty space on a card in ${group}`, async ({ page }) => {
      const { key, sprintId, backlog, done } = await seedSprintWithBothGroups();
      const issue = group === "backlog" ? backlog : done;

      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      const card = cardFor(page, issue.key);
      await expect(card).toBeVisible();

      /* The title itself: text content, no control of its own. */
      await card.locator(".prio-board__card-title").click();
      await expect(page).toHaveURL(new RegExp(`/issues/${issue.key.toLowerCase()}$`));
    });
  }

  test("still opens from the key, exactly as it always did", async ({ page }) => {
    const { key, sprintId, done } = await seedSprintWithBothGroups();

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    const card = cardFor(page, done.key);
    await card.locator(".prio-board__card-key").click();
    await expect(page).toHaveURL(new RegExp(`/issues/${done.key.toLowerCase()}$`));
  });

  test("opens on Enter and on Space, with no pointer involved", async ({
    page,
  }) => {
    const { key, sprintId, backlog } = await seedSprintWithBothGroups();

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await focusCard(page, backlog.key);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/issues/${backlog.key.toLowerCase()}$`));

    await page.goBack();
    await focusCard(page, backlog.key);
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(new RegExp(`/issues/${backlog.key.toLowerCase()}$`));
  });

  test("a subtle hover and a pointer cursor mark the whole card, not only the key", async ({
    page,
  }) => {
    const { key, sprintId, backlog } = await seedSprintWithBothGroups();

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    const card = cardFor(page, backlog.key);
    await expect(card).toHaveCSS("cursor", "pointer");

    const before = await card.evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    await card.hover();
    await expect
      .poll(() => card.evaluate((el) => getComputedStyle(el).borderColor))
      .not.toBe(before);
  });

  test.describe("interactive controls stay independent", () => {
    test("the status pill changes status and does not navigate", async ({
      page,
    }) => {
      const { key, sprintId, backlog } = await seedSprintWithBothGroups();

      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      const card = cardFor(page, backlog.key);
      await card.locator(".prio-board__card-statustrigger").click();

      const menu = page.getByRole("menu", {
        name: `Change status of ${backlog.key}`,
      });
      await expect(menu).toBeVisible();
      /* A choice within a menu is `menuitemradio`, not `menuitem` — the same
         status menu the Flow Board itself uses. */
      await menu.getByRole("menuitemradio", { name: "New", exact: true }).click();

      /* The menu closes and the status actually changed — and the click that
         did it never left this page. */
      await expect(page).toHaveURL(new RegExp(`/sprints/${sprintId}$`));
      await expect
        .poll(
          async () =>
            (
              await prisma.issue.findUniqueOrThrow({
                where: { id: backlog.id },
                select: { status: true },
              })
            ).status,
        )
        .toBe("TODO");
    });

    test("the row-actions menu opens without navigating", async ({ page }) => {
      const { key, sprintId, backlog } = await seedSprintWithBothGroups();

      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      const card = cardFor(page, backlog.key);
      await card.hover();
      await card
        .getByRole("button", { name: `Actions for ${backlog.key}` })
        .click();

      await expect(
        page.getByRole("menu", { name: `Actions for ${backlog.key}` }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/sprints/${sprintId}$`));
    });

    test("Move to opens without navigating, and its own choice still works", async ({
      page,
    }) => {
      const { key, sprintId, backlog } = await seedSprintWithBothGroups();

      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      const card = cardFor(page, backlog.key);
      await card.hover();
      await card
        .getByRole("button", { name: new RegExp(`Move ${backlog.key} to another`) })
        .click();

      const menu = page.getByRole("menu", { name: `Move ${backlog.key}` });
      await expect(menu).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/sprints/${sprintId}$`));

      await menu.getByRole("menuitem", { name: "Backlog" }).click();
      await expect(page.getByText(`${backlog.key} moved to Backlog`)).toBeVisible({
        timeout: 15_000,
      });
      /* The click that chose Backlog did not also open the issue. */
      await expect(page).toHaveURL(new RegExp(`/sprints/${sprintId}$`));
    });
  });

  test("does not reach the Flow Board, which still drags these cards", async ({
    page,
  }) => {
    /*
     * The one place this behaviour is deliberately absent. The Flow Board's
     * cards are draggable, and a drag ending near its start is still a click —
     * exactly the failure this change must not reintroduce there. Empty space
     * on a Flow Board card must therefore still do nothing.
     */
    const { key, backlog } = await seedSprintWithBothGroups();

    await page.goto(`/projects/${key}/board`);
    const card = page.locator(".prio-board__card").filter({ hasText: backlog.key });
    await expect(card).toBeVisible();

    const before = page.url();
    await card.locator(".prio-board__card-title").click();
    await expect(page).toHaveURL(before);

    /* The key still works — that path was never touched. */
    await card.locator(".prio-board__card-key").click();
    await expect(page).toHaveURL(new RegExp(`/issues/${backlog.key.toLowerCase()}$`));
  });
});
