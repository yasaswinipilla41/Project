import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { formatDateCompact } from "@/lib/format";

/**
 * A sprint bar on the project timeline says when the sprint runs.
 *
 * The bar's position already carried that, but position is only readable
 * against the axis: two sprints a week apart look alike. The dates are now
 * written on the bar itself — the start at its start, the end at its end —
 * and this drives the real page to check they are the sprint's own dates
 * rather than anything fixed.
 */

const createdProjects: string[] = [];
const createdIssues: string[] = [];
const createdSprints: string[] = [];

test.afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

/**
 * A project of this spec's own holding one dated issue and one sprint.
 *
 * The timeline only draws at all when something has a due date, and a project
 * of its own keeps the window — and so the bar's width — predictable.
 */
async function seedProjectWithSprint() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `TL${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Timeline fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${key}-1`,
      number: 1,
      title: "Dated work, so the timeline draws",
      type: "TASK",
      status: "TODO",
      reporterId: admin.id,
      dueDate: new Date(Date.now() + 20 * 86_400_000),
    },
    select: { id: true },
  });
  createdIssues.push(issue.id);

  /* Deliberately not "today to today + 14": dates the test did not choose
     could not tell a real reading of the sprint from a coincidence. */
  const startDate = new Date(Date.now() + 3 * 86_400_000);
  const endDate = new Date(Date.now() + 17 * 86_400_000);
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E timeline sprint ${Date.now()}`,
      startDate,
      endDate,
      projectId: project.id,
      createdById: admin.id,
    },
    select: { id: true, name: true },
  });
  createdSprints.push(sprint.id);

  return { key: project.key.toLowerCase(), sprint, startDate, endDate };
}

test.describe("Sprint bars on the project timeline", () => {
  test("write the sprint's own start and end dates on the bar", async ({
    page,
  }) => {
    const { key, sprint, startDate, endDate } = await seedProjectWithSprint();

    await page.goto(`/projects/${key}/timeline`);

    const row = page
      .locator(".prio-timeline__row")
      .filter({ hasText: sprint.name });
    const bar = row.locator(".prio-timeline__bar--sprint");
    await expect(bar).toBeVisible();

    /* The dates the page shows are the sprint's, formatted the way every
       other sprint date in Prio is — so the expectation is computed from the
       rows this test wrote, never typed out. */
    await expect(bar.locator(".prio-timeline__barlabel--start")).toHaveText(
      formatDateCompact(startDate),
    );
    await expect(bar.locator(".prio-timeline__barlabel--end")).toHaveText(
      formatDateCompact(endDate),
    );

    /* Start at the start, end at the end. */
    const startBox = await bar
      .locator(".prio-timeline__barlabel--start")
      .boundingBox();
    const endBox = await bar
      .locator(".prio-timeline__barlabel--end")
      .boundingBox();
    expect(startBox!.x).toBeLessThan(endBox!.x);

    /* Both stay inside the bar rather than running over the lane. */
    const barBox = await bar.boundingBox();
    expect(startBox!.x).toBeGreaterThanOrEqual(barBox!.x - 1);
    expect(endBox!.x + endBox!.width).toBeLessThanOrEqual(
      barBox!.x + barBox!.width + 1,
    );

    /* Whatever the bar's width, the dates are also said in words — the row
       an assistive reader or a hover gets. */
    await expect(bar).toHaveAttribute("title", /\d/);
  });

  test("leave the issue rows' own labels alone", async ({ page }) => {
    /* The sprint block is the only thing this change touched: an issue row
       still carries exactly one date label, its due date. */
    const { key } = await seedProjectWithSprint();

    await page.goto(`/projects/${key}/timeline`);

    const issueRow = page
      .locator(".prio-timeline__group")
      .filter({ hasText: "Not in an epic" })
      .locator(".prio-timeline__row")
      .first();
    await expect(issueRow.locator(".prio-timeline__barlabel")).toHaveCount(1);
    await expect(
      issueRow.locator(".prio-timeline__barlabel--start"),
    ).toHaveCount(0);
  });
});
