import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { formatDateRange } from "@/lib/format";

/**
 * Move to offers the project's current sprint and its upcoming one, named and
 * dated — and nothing further out, however many sprints the project holds.
 *
 * A project running its fourth or fifth sprint still has every earlier one on
 * record, and used to list all of them — Sprint 3, 4, 5 — as places an issue
 * in Sprint 2 could go. A team planning that far ahead does not plan to move
 * work into it yet, so the menu now stops at the one sprint after whichever
 * is running: reachable once it becomes current in its turn, not before.
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

  const sprints: Record<string, { id: string; name: string; startDate: Date; endDate: Date }> =
    {};
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
  test("offers only the current and the upcoming sprint, dated, from the current sprint's own page", async ({
    page,
  }) => {
    const { key, sprints, issue } = await seedFiveSprints();

    await page.goto(`/projects/${key}/sprints/${sprints.two!.id}`);
    const card = page.locator(".prio-board__card").filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });
    await expect(menu).toBeVisible();

    /* Named and dated, exactly like the task's own worked example. */
    await expect(
      menu.getByRole("menuitem", {
        name: `${sprints.three!.name} (${formatDateRange(sprints.three!.startDate, sprints.three!.endDate)})`,
      }),
    ).toBeVisible();

    /* Nothing further out, however plainly it is named. */
    for (const label of ["four", "five"] as const) {
      await expect(
        menu.getByRole("menuitem", { name: sprints[label]!.name }),
      ).toHaveCount(0);
    }
    /* And not the completed sprint either — there is nothing to move back
       into a closed record. */
    await expect(
      menu.getByRole("menuitem", { name: sprints.one!.name }),
    ).toHaveCount(0);
    /* Nor the sprint the card is already read on. */
    await expect(
      menu.getByRole("menuitem", { name: sprints.two!.name }),
    ).toHaveCount(0);

    /* Exactly one dated sprint entry, plus Backlog — nothing else. */
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
  });

  test("offers the current sprint back, from the upcoming sprint's own page — and stops there too", async ({
    page,
  }) => {
    const { key, sprints } = await seedFiveSprints();

    /* An issue already in "three", the upcoming sprint, seen from its own
       page. Filed directly, so this case does not depend on the move this
       file's other test already covers. */
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
    const card = page.locator(".prio-board__card").filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });

    /* Current is reachable going backward, exactly as it is going forward. */
    await expect(
      menu.getByRole("menuitem", {
        name: `${sprints.two!.name} (${formatDateRange(sprints.two!.startDate, sprints.two!.endDate)})`,
      }),
    ).toBeVisible();

    /* "Sprint four" is one step past upcoming from here, and still out of
       reach — the menu never looks two sprints ahead of current. */
    for (const label of ["four", "five"] as const) {
      await expect(
        menu.getByRole("menuitem", { name: sprints[label]!.name }),
      ).toHaveCount(0);
    }
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
  });

  test("moving into the upcoming sprint actually works, end to end", async ({
    page,
  }) => {
    const { key, sprints, issue } = await seedFiveSprints();

    await page.goto(`/projects/${key}/sprints/${sprints.two!.id}`);
    const card = page.locator(".prio-board__card").filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    await page
      .getByRole("menu", { name: `Move ${issue.key}` })
      .getByRole("menuitem", { name: sprints.three!.name })
      .click();

    await expect(page.getByText(`moved to ${sprints.three!.name}`)).toBeVisible({
      timeout: 15_000,
    });

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true, status: true },
      }),
    ).toMatchObject({ sprintId: sprints.three!.id, status: "IN_PROGRESS" });

    await page.goto(`/projects/${key}/sprints/${sprints.three!.id}`);
    await expect(
      page.locator(".prio-board__card").filter({ hasText: issue.key }),
    ).toBeVisible();
  });
});
