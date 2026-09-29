import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Move Sprint, from a Flow Board card's ⋯ menu.
 *
 * The card's menu offers "Move Sprint", which opens the issue's own sprint
 * picker in place — the one the issue page has, reading every eligible sprint
 * in the issue's project, not only the next. Choosing one moves the issue
 * there through `moveIssueToSprint` and nothing else about the issue changes.
 * Work that is Done stays where it was finished, so its card does not offer
 * the move; and the sprint page's own cards, which carry a Move to control of
 * their own, do not grow a second one in their menu.
 */

const createdProjects: string[] = [];
const DAY = 86_400_000;

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.activityLogEntry.deleteMany({
      where: { issue: { projectId: id } },
    });
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

async function seed() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { email: "admin@symbiosystech.com" },
    select: { id: true },
  });
  const key = `MS${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Move Sprint fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprint = (name: string, from: number, status: "ACTIVE" | "PLANNED") =>
    prisma.sprint.create({
      data: {
        name: `${name} ${Date.now()}`,
        startDate: new Date(Date.now() + from * DAY),
        endDate: new Date(Date.now() + (from + 13) * DAY),
        projectId: project.id,
        createdById: admin.id,
        status,
        startedAt: status === "ACTIVE" ? new Date() : null,
      },
      select: { id: true, name: true },
    });
  const current = await sprint("Current", -2, "ACTIVE");
  const next = await sprint("Next", 12, "PLANNED");
  const later = await sprint("Later", 26, "PLANNED");

  const issue = (number: number, status: "IN_PROGRESS" | "DONE") =>
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-${number}`,
        number,
        title: status === "DONE" ? "Finished work" : "Work to re-plan",
        type: "TASK",
        status,
        priority: "P1",
        reporterId: admin.id,
        assigneeId: admin.id,
        sprintId: current.id,
        effortHours: 5,
        remainingHours: 3,
      },
      select: { id: true, key: true },
    });

  return {
    key: project.key.toLowerCase(),
    admin,
    sprints: { current, next, later },
    open: await issue(1, "IN_PROGRESS"),
    done: await issue(2, "DONE"),
  };
}

test.describe("Move Sprint on a Flow Board card", () => {
  test("moves the issue to any open sprint, and changes nothing else", async ({
    page,
  }) => {
    const { key, admin, sprints, open } = await seed();
    await page.goto(`/projects/${key}/board`);

    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: open.key });
    await card.hover();
    await card.getByRole("button", { name: `Actions for ${open.key}` }).click();
    const menu = page.getByRole("menu", { name: `Actions for ${open.key}` });

    /* The menu's own actions are all still there, with Move Sprint among
       them. */
    await expect(
      menu.getByRole("menuitem", { name: "Open / edit" }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Move Sprint" }).click();

    /* The picker, in the same menu: every open sprint in the project — the
       current one marked as where it is now, the next, and the one after. */
    await expect(menu).toContainText("Move to sprint");
    const choices = menu.getByRole("menuitemradio");
    await expect(choices).toHaveCount(3);
    await expect(
      menu.getByRole("menuitemradio", {
        name: new RegExp(sprints.current.name),
      }),
    ).toHaveAttribute("aria-checked", "true");

    /* Back returns to the actions, and Move Sprint opens the picker again. */
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
    await expect(menu.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Move Sprint" }).click();

    /* Not only the next sprint: the one after it. */
    await menu
      .getByRole("menuitemradio", { name: new RegExp(sprints.later.name) })
      .click();
    await expect(
      page.getByText(`${open.key} moved to ${sprints.later.name}`),
    ).toBeVisible({
      timeout: 15_000,
    });

    /* Out of the current sprint and into that one — status, assignee,
       priority and effort exactly as they were. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: open.id },
        select: {
          sprintId: true,
          status: true,
          assigneeId: true,
          priority: true,
          effortHours: true,
          remainingHours: true,
        },
      }),
    ).toEqual({
      sprintId: sprints.later.id,
      status: "IN_PROGRESS",
      assigneeId: admin.id,
      priority: "P1",
      effortHours: 5,
      remainingHours: 3,
    });

    /* The card is where it was on the board, and its picker now reads the
       new sprint as the one it is in. */
    await card.hover();
    await card.getByRole("button", { name: `Actions for ${open.key}` }).click();
    await menu.getByRole("menuitem", { name: "Move Sprint" }).click();
    await expect(
      menu.getByRole("menuitemradio", { name: new RegExp(sprints.later.name) }),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("is not offered for Done work, or on the sprint page's own cards", async ({
    page,
  }) => {
    const { key, sprints, open, done } = await seed();

    /* On the board, a Done card's menu keeps its actions and has no Move
       Sprint. */
    await page.goto(`/projects/${key}/board`);
    const doneCard = page
      .locator(".prio-board__card")
      .filter({ hasText: done.key });
    await doneCard.hover();
    await doneCard
      .getByRole("button", { name: `Actions for ${done.key}` })
      .click();
    const doneMenu = page.getByRole("menu", {
      name: `Actions for ${done.key}`,
    });
    await expect(
      doneMenu.getByRole("menuitem", { name: "Clone" }),
    ).toBeVisible();
    await expect(
      doneMenu.getByRole("menuitem", { name: "Move Sprint" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    /* On the sprint page, the same card component keeps its own Move to
       control and does not repeat it in the menu. */
    await page.goto(`/projects/${key}/sprints/${sprints.current.id}`);
    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: open.key });
    await card.hover();
    await card.getByRole("button", { name: `Actions for ${open.key}` }).click();
    const menu = page.getByRole("menu", { name: `Actions for ${open.key}` });
    await expect(menu.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Move Sprint" }),
    ).toHaveCount(0);
  });
});
