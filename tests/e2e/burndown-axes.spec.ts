import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * What the burndown's two axes say.
 *
 * The lines themselves are pinned by `tests/burndown.test.ts` (the
 * arithmetic), `tests/burndown-load.test.ts` (the wiring) and the burndown
 * test in `effort-burndown-history.spec.ts` (the drawing). This is about the
 * axes being readable: the scale is remaining effort *in hours*, and the
 * bottom is a run of the sprint's own dates — which has to stay unambiguous
 * when a fortnight crosses into the next month, where bare day numbers read
 * "30, 1, 3" and say nothing about which month those are.
 */

const createdProjects: string[] = [];
const DAY = 86_400_000;

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.activityLogEntry.deleteMany({ where: { issue: { projectId: id } } });
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/**
 * A sprint of estimated work that runs across the turn of a month, so the
 * date axis has to name months, plus one finished item so both lines have
 * somewhere to go.
 */
async function seedEstimatedSprint() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `BX${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown axes fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  /* The 25th of last month, computed rather than written down: a fortnight
     from there always crosses into this month, and — unlike a sprint that
     starts in the future — it has days the sprint has actually reached, which
     is what the actual line is drawn from. */
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 25);
  const end = new Date(start.getTime() + 13 * DAY);

  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E burndown axes ${Date.now()}`,
      startDate: start,
      endDate: end,
      projectId: project.id,
      createdById: admin.id,
    },
    select: { id: true },
  });

  /* 30 hours committed: 10 of them finished on the sprint's second day. */
  const finished = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Ten hours, finished",
      type: "TASK",
      status: "DONE",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 10,
      remainingHours: 10,
    },
    select: { id: true },
  });
  await prisma.activityLogEntry.create({
    data: {
      issueId: finished.id,
      actorId: admin.id,
      action: "issue.updated",
      field: "status",
      oldValue: "IN_PROGRESS",
      newValue: "DONE",
      createdAt: new Date(start.getTime() + DAY),
    },
  });
  await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-2`,
      number: 2,
      title: "Twenty hours, still going",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 20,
      remainingHours: 20,
    },
  });

  return { key: project.key.toLowerCase(), sprintId: sprint.id, start, end };
}

test.describe("The burndown's axes", () => {
  test("measure remaining effort in hours, against the sprint's own dates", async ({
    page,
  }) => {
    const { key, sprintId, start } = await seedEstimatedSprint();

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    const chart = page.getByRole("img", { name: /^Burndown:/ });
    await chart.waitFor({ timeout: 45_000 });

    /* Both lines are drawn: the reference and the reading. */
    await expect(page.locator("polyline.prio-burndown__ideal")).toHaveCount(1);
    await expect(page.locator("polyline.prio-burndown__actual")).toHaveCount(1);

    const labels = await page
      .locator(".prio-burndown__axis")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent!.trim()));

    /* The scale: every step carries its unit, and the top of it is the whole
       commitment — 30 hours, from the fixture's own estimates. */
    const hours = labels.filter((text) => /^\d+h$/.test(text));
    expect(hours.length).toBeGreaterThan(1);
    expect(hours).toContain("30h");
    expect(hours).toContain("0h");

    /* The dates: the first one names its month, so a sprint that crosses into
       the next month cannot be misread. */
    const dates = labels.filter((text) => !/^\d+h$/.test(text));
    const month = start.toLocaleDateString("en-GB", { month: "short" });
    expect(dates[0]).toBe(`${start.getDate()} ${month}`);

    /* And the new month is named on the first date shown inside it, wherever
       that falls — the axis never runs two months together as bare day
       numbers. */
    const nextMonth = new Date(
      start.getFullYear(),
      start.getMonth() + 1,
      1,
    ).toLocaleDateString("en-GB", { month: "short" });
    expect(dates.filter((text) => text.endsWith(nextMonth))).toHaveLength(1);
    /* Exactly two of them carry a month: this sprint spans two. */
    expect(dates.filter((text) => /\s/.test(text))).toHaveLength(2);

    /* The caption still says the range and the figures in words, so nothing
       here depends on reading the picture. */
    await expect(page.locator(".prio-burndown__legend")).toContainText(
      "20h of 30h left",
    );
  });
});
