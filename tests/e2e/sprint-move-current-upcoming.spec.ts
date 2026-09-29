import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

/**
 * Move to offers every upcoming sprint of the project, named and dated — and
 * nothing else that is a sprint.
 *
 * Upcoming means planned and not yet started. The running sprint is not
 * offered, nor is a completed one, nor the sprint the card is read on; every
 * planned sprint is, however far out, soonest first, so work can be
 * re-planned straight into whichever future sprint it belongs in. A project
 * with nothing planned says so.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/** Midday, so a timezone cannot roll the date onto a different day. */
function day(offset: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(12, 0, 0, 0);
  return date;
}

/**
 * A project with five sprints — one completed, one running, one right after
 * it, and two further out — and one issue in the running sprint. The task's
 * own worked example, seeded exactly.
 */
async function seedFiveSprints() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `CU${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Current + upcoming fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const week = 7;
  const plan = [
    { label: "one", status: "COMPLETED" as const, offset: -2 * week },
    { label: "two", status: "ACTIVE" as const, offset: -1 },
    { label: "three", status: "PLANNED" as const, offset: 1 * week },
    { label: "four", status: "PLANNED" as const, offset: 2 * week },
    { label: "five", status: "PLANNED" as const, offset: 3 * week },
  ];

  const sprints: Record<
    string,
    { id: string; name: string; startDate: Date; endDate: Date }
  > = {};
  for (const { label, status, offset } of plan) {
    const startDate = day(offset);
    const endDate = day(offset + week - 1);
    const sprint = await prisma.sprint.create({
      data: {
        name: `${key} sprint ${label}`,
        startDate,
        endDate,
        status,
        projectId: project.id,
        createdById: admin.id,
        ...(status !== "PLANNED" ? { startedAt: day(offset) } : {}),
        ...(status === "COMPLETED" ? { completedAt: day(offset + week) } : {}),
      },
      select: { id: true, name: true },
    });
    sprints[label] = { ...sprint, startDate, endDate };
  }

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Work in the running sprint",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprints.two!.id,
    },
    select: { id: true, key: true },
  });

  return { key: project.key.toLowerCase(), sprints, issue };
}

test.describe("Move to, on a project several sprints deep", () => {
  test("offers every upcoming sprint, dated and soonest first, from the running sprint's page", async ({
    page,
  }) => {
    const { key, sprints, issue } = await seedFiveSprints();

    await page.goto(`/projects/${key}/sprints/${sprints.two!.id}`);
    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });
    await expect(menu).toBeVisible();

    /* All three planned sprints — not only the next — each with its name,
       its start date and its end date, soonest first. */
    const upcoming = ["three", "four", "five"] as const;
    for (const label of upcoming) {
      await expect(
        menu.getByRole("menuitem", {
          name: `${sprints[label]!.name} ${formatDate(sprints[label]!.startDate)} – ${formatDate(sprints[label]!.endDate)}`,
        }),
      ).toBeVisible();
    }
    const names = await menu
      .locator(".prio-movesprint__name")
      .allTextContents();
    expect(names).toEqual(upcoming.map((label) => sprints[label]!.name));

    /* Not the running sprint — the one the card is read on — and not the
       completed one: there is nothing to move back into a closed record. */
    for (const label of ["one", "two"] as const) {
      await expect(
        menu.getByRole("menuitem", { name: sprints[label]!.name }),
      ).toHaveCount(0);
    }

    /* The three upcoming sprints — nothing else, and never the backlog. */
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    await expect(menu.getByRole("menuitem", { name: /Backlog/ })).toHaveCount(
      0,
    );
  });

  test("never offers the running sprint, even from an upcoming sprint's page", async ({
    page,
  }) => {
    const { key, sprints } = await seedFiveSprints();

    /* An issue already in "three", an upcoming sprint, seen from its own
       page. Filed directly, so this case does not depend on the move this
       file's other tests cover. */
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: key.toUpperCase() },
      select: { id: true },
    });
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${key.toUpperCase()}-2`,
        number: 2,
        title: "Work planned for next",
        type: "TASK",
        status: "TODO",
        reporterId: admin.id,
        sprintId: sprints.three!.id,
      },
      select: { id: true, key: true },
    });

    await page.goto(`/projects/${key}/sprints/${sprints.three!.id}`);
    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });

    /* The other upcoming sprints are offered. */
    for (const label of ["four", "five"] as const) {
      await expect(
        menu.getByRole("menuitem", { name: new RegExp(sprints[label]!.name) }),
      ).toBeVisible();
    }
    /* The running one is not, and neither is the completed one or this
       page's own. */
    for (const label of ["one", "two", "three"] as const) {
      await expect(
        menu.getByRole("menuitem", { name: new RegExp(sprints[label]!.name) }),
      ).toHaveCount(0);
    }
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
  });

  test("says so when there are no upcoming sprints", async ({ page }) => {
    const { key, sprints, issue } = await seedFiveSprints();
    /* Nothing planned any more: the three upcoming sprints are gone. */
    await prisma.sprint.deleteMany({
      where: {
        id: { in: [sprints.three!.id, sprints.four!.id, sprints.five!.id] },
      },
    });

    await page.goto(`/projects/${key}/sprints/${sprints.two!.id}`);
    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });
    await expect(menu).toContainText("No upcoming sprints available");
    /* And offers nothing in the sprints' place — not the backlog. */
    await expect(menu.getByRole("menuitem")).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: /Backlog/ })).toHaveCount(
      0,
    );
  });

  test("moving into any upcoming sprint — the furthest out — works, end to end", async ({
    page,
  }) => {
    const { key, sprints, issue } = await seedFiveSprints();

    await page.goto(`/projects/${key}/sprints/${sprints.two!.id}`);
    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    await page
      .getByRole("menu", { name: `Move ${issue.key}` })
      .getByRole("menuitem", { name: sprints.five!.name })
      .click();

    await expect(page.getByText(`moved to ${sprints.five!.name}`)).toBeVisible({
      timeout: 15_000,
    });

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true, status: true },
      }),
    ).toMatchObject({ sprintId: sprints.five!.id, status: "IN_PROGRESS" });

    await page.goto(`/projects/${key}/sprints/${sprints.five!.id}`);
    await expect(
      page.locator(".prio-board__card").filter({ hasText: issue.key }),
    ).toBeVisible();
  });
});
