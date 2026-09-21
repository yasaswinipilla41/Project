import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Restore, on a sprint issue's own Move to menu.
 *
 * An issue moved from one sprint into another can be sent back where it came
 * from, and the option says which sprint that is. It appears only once there
 * is somewhere to go back to: a freshly planned issue is offered no Restore,
 * because nothing has moved it.
 *
 * Driven through the real menu, and checked on the real rows and the real
 * figures — the sprint's totals and its Issues by status chart are counted
 * from membership, so a restore has to move both sprints' numbers.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/** A project with two open sprints and one assigned, in-progress issue in A. */
async function seedTwoSprints() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `RS${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Restore fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const day = 86_400_000;
  const [a, b] = await Promise.all([
    prisma.sprint.create({
      data: {
        name: `E2E restore A ${Date.now()}`,
        startDate: new Date(),
        endDate: new Date(Date.now() + 13 * day),
        projectId: project.id,
        createdById: admin.id,
      },
      select: { id: true, name: true },
    }),
    prisma.sprint.create({
      data: {
        name: `E2E restore B ${Date.now()}`,
        startDate: new Date(Date.now() + 14 * day),
        endDate: new Date(Date.now() + 27 * day),
        projectId: project.id,
        createdById: admin.id,
      },
      select: { id: true, name: true },
    }),
  ]);

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Work that comes back",
      type: "TASK",
      status: "IN_PROGRESS",
      priority: "HIGH",
      reporterId: admin.id,
      assigneeId: admin.id,
      sprintId: a.id,
    },
    select: { id: true, key: true },
  });

  return { key: project.key.toLowerCase(), a, b, issue };
}

/**
 * The sprint's issue total, waited for rather than asserted on the instant a
 * page is asked for: the first render of a route in development compiles it,
 * which can outlast the default expectation timeout.
 */
async function expectTotalIssues(page: Page, count: number) {
  const total = page.locator(".prio-sprint__total");
  await total.waitFor({ timeout: 45_000 });
  await expect(total).toHaveText(`Total Issues: ${count}`);
}

test.describe("Move to · Restore", () => {
  test("sends an issue back to the sprint it came from, and only its sprint changes", async ({
    page,
  }) => {
    const { key, a, b, issue } = await seedTwoSprints();

    // ------------------------------------- nothing to restore to, at first
    await page.goto(`/projects/${key}/sprints/${a.id}`);
    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    const moveButton = card.getByRole("button", {
      name: new RegExp(`Move ${issue.key} to another`),
    });
    await moveButton.click();
    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });
    await expect(menu).toBeVisible();
    /* It has never been moved, so there is nowhere to put it back. */
    await expect(menu.getByRole("menuitem", { name: /^Restore/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // ------------------------------------------------ move it into sprint B
    await card.hover();
    await moveButton.click();
    await menu.getByRole("menuitem", { name: b.name }).click();
    await expect(page.getByText(`moved to ${b.name}`)).toBeVisible({
      timeout: 15_000,
    });

    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { status: true, priority: true, assigneeId: true, title: true },
    });

    // ----------------------------------------------- restore it, from B's page
    await page.goto(`/projects/${key}/sprints/${b.id}`);
    await expectTotalIssues(page, 1);
    const moved = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await moved.hover();
    await moved
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    /* The option names the sprint it would go back to. */
    const restore = page
      .getByRole("menu", { name: `Move ${issue.key}` })
      .getByRole("menuitem", { name: `Restore to ${a.name}` });
    await expect(restore).toBeVisible();
    await restore.click();

    await expect(page.getByText(`moved to ${a.name}`)).toBeVisible({
      timeout: 15_000,
    });

    /* Back in A, and nothing else about the issue moved with it. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: {
          sprintId: true,
          status: true,
          priority: true,
          assigneeId: true,
          title: true,
        },
      }),
    ).toMatchObject({ sprintId: a.id, ...before });

    /* Both sprints' figures followed it. */
    await expectTotalIssues(page, 0);
    await page.goto(`/projects/${key}/sprints/${a.id}`);
    await expectTotalIssues(page, 1);
    await expect(
      page.locator(".prio-board__card").filter({ hasText: issue.key }),
    ).toBeVisible();
  });
});
