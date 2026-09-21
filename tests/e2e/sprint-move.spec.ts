import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Moving an issue out of a sprint, from the card it is read on.
 *
 * "Next sprint" used to insist on a strictly later start date, so a project
 * whose sprints share dates — two boards over the same fortnight — was told
 * "No future Sprint is available." while its own Sprints page listed the
 * sprint it should have offered. This drives the real menu and then checks
 * three things the move has to leave true: the issue is in the other sprint,
 * its status is untouched, and both sprints' figures have followed it.
 *
 * The second describe covers the other half of the same question: a project
 * with nowhere to move to should not offer the move. Restore was already
 * gated that way; Next sprint was not, so on a project running its only
 * sprint the entry sat on every card and failed every time.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/**
 * A project with two open sprints **on the same dates** and one in-progress
 * issue in the first of them.
 *
 * The shared dates are the point: a fixture whose sprints ran one after the
 * other passed while the bug was there.
 */
async function seedSameDaySprints() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `MV${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Sprint move fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const dates = {
    startDate: new Date(),
    endDate: new Date(Date.now() + 13 * 86_400_000),
  };
  const [from, to] = await Promise.all([
    prisma.sprint.create({
      data: {
        name: `E2E move source ${Date.now()}`,
        ...dates,
        projectId: project.id,
        createdById: admin.id,
      },
      select: { id: true, name: true },
    }),
    prisma.sprint.create({
      data: {
        name: `E2E move destination ${Date.now()}`,
        ...dates,
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
      title: "Work that outlives its sprint",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: from.id,
    },
    select: { id: true, key: true },
  });

  return { key: project.key.toLowerCase(), from, to, issue };
}

/** A project with one sprint and one issue in it: nowhere to move on to. */
async function seedLonelySprint() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `LN${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Lonely sprint fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E only sprint ${Date.now()}`,
      startDate: new Date(),
      endDate: new Date(Date.now() + 13 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
    },
    select: { id: true, name: true },
  });

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Work with nowhere to go",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprint.id,
    },
    select: { id: true, key: true },
  });

  return { key: project.key.toLowerCase(), sprint, issue };
}

test.describe("Move to · when there is no next sprint", () => {
  test("does not offer it, and still offers the backlog", async ({ page }) => {
    const { key, sprint, issue } = await seedLonelySprint();

    await page.goto(`/projects/${key}/sprints/${sprint.id}`);

    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });

    /* The entry that could only ever fail here is gone. */
    await expect(
      menu.getByRole("menuitem", { name: "Next sprint" }),
    ).toHaveCount(0);

    /* The menu is still worth opening: the backlog is a real destination and
       is still offered. */
    await expect(menu.getByRole("menuitem", { name: "Backlog" })).toBeVisible();

    /* And the move it does offer still works, so gating one entry has not
       taken the control with it. */
    await menu.getByRole("menuitem", { name: "Backlog" }).click();
    await expect
      .poll(
        async () =>
          (
            await prisma.issue.findUniqueOrThrow({
              where: { id: issue.id },
              select: { sprintId: true },
            })
          ).sprintId,
        { timeout: 15_000 },
      )
      .toBeNull();
  });
});

test.describe("Move to · next sprint", () => {
  test("moves the issue to the next sprint even when both sprints run the same dates", async ({
    page,
  }) => {
    const { key, from, to, issue } = await seedSameDaySprints();

    await page.goto(`/projects/${key}/sprints/${from.id}`);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 1",
    );

    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();
    await page
      .getByRole("menu", { name: `Move ${issue.key}` })
      .getByRole("menuitem", { name: "Next sprint" })
      .click();

    /* Where it went, said in the words the person gets — and never "No
       future Sprint is available." */
    await expect(page.getByText(`moved to ${to.name}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("No future Sprint is available.")).toHaveCount(
      0,
    );

    /* Out of this sprint, into that one, with the status it had. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true, status: true },
      }),
    ).toMatchObject({ sprintId: to.id, status: "IN_PROGRESS" });

    /* And both sprints' own figures have followed it, because nothing
       stores them. */
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 0",
    );
    await page.goto(`/projects/${key}/sprints/${to.id}`);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 1",
    );
    await expect(
      page.locator(".prio-board__card").filter({ hasText: issue.key }),
    ).toBeVisible();
  });
});
