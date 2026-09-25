import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { formatDate, formatDayMonthYear } from "@/lib/format";

/**
 * A sprint bar on the project timeline says when the sprint runs.
 *
 * The bar's position already carried that, but position is only readable
 * against the axis: two sprints a week apart look alike. So each end of the
 * bar is dated — the start at its start, the end at its end — and this drives
 * the real page to check they are the sprint's own dates rather than anything
 * fixed.
 *
 * The dates are drawn *beside* the bar, not inside it. A bar is a filled
 * shape roughly one date wide at these sizes, so a date written inside it was
 * white-on-colour and clipped; outside, it reads against the page whatever
 * the bar's width. That is the property asserted here, by measuring where
 * each date landed against the bar's own box.
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
    select: { id: true, key: true, title: true },
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

  return { key: project.key.toLowerCase(), sprint, startDate, endDate, issue };
}

test.describe("Sprint bars on the project timeline", () => {
  test("date each end of the bar, beside it rather than on it", async ({
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
    const start = row.locator('.prio-timeline__date[data-edge="start"]');
    const end = row.locator('.prio-timeline__date[data-edge="end"]');
    await expect(start).toHaveText(formatDayMonthYear(startDate));
    await expect(end).toHaveText(formatDayMonthYear(endDate));

    /* Nothing is drawn inside the bar any more: the fill carries the sprint's
       colour and nothing else. What is left in it is the text no one sees —
       the whole range, for a screen reader — so the check is that the bar has
       no visible content rather than no content at all. */
    await expect(bar.locator(".prio-timeline__date")).toHaveCount(0);
    await expect(
      bar.locator(":scope > *:not(.prio-visually-hidden)"),
    ).toHaveCount(0);

    /* Start before the bar, end after it — outside its box on the side it
       belongs to, which is the whole point of moving them out. */
    const barBox = (await bar.boundingBox())!;
    const startBox = (await start.boundingBox())!;
    const endBox = (await end.boundingBox())!;
    expect(
      startBox.x + startBox.width,
      "the start date is not clear of the bar",
    ).toBeLessThanOrEqual(barBox.x + 1);
    expect(
      endBox.x,
      "the end date is not clear of the bar",
    ).toBeGreaterThanOrEqual(barBox.x + barBox.width - 1);
    expect(startBox.x).toBeLessThan(endBox.x);

    /* And they stay in the lane, so neither runs into the name column or the
       status column either side of it. */
    const trackBox = (await row
      .locator(".prio-timeline__track")
      .boundingBox())!;
    expect(startBox.x).toBeGreaterThanOrEqual(trackBox.x - 1);
    expect(endBox.x + endBox.width).toBeLessThanOrEqual(
      trackBox.x + trackBox.width + 1,
    );

    /* Whatever the bar's width, the dates are also said in words — the row
       an assistive reader or a hover gets. */
    await expect(bar).toHaveAttribute("title", /\d/);
  });

  test("date an issue row beside its bar too", async ({ page }) => {
    /*
     * The same treatment for the work under "Not in an epic".
     *
     * Its due date used to be written inside the coloured bar, where a status
     * colour and a small bar between them made it unreadable. The date itself
     * is unchanged — same value, same format, from the same `dueDate` — and
     * only its position has moved.
     */
    const { key } = await seedProjectWithSprint();

    await page.goto(`/projects/${key}/timeline`);

    const issueRow = page
      .locator(".prio-timeline__group")
      .filter({ hasText: "Not in an epic" })
      .locator(".prio-timeline__row")
      .first();

    const bar = issueRow.locator(".prio-timeline__bar");
    const date = issueRow.locator(".prio-timeline__duedate");
    await expect(date).toHaveCount(1);
    /* The issue this spec seeded is due in twenty days, and that is the date
       the row shows — computed here from the same clock, not typed out. */
    await expect(date).toHaveText(
      formatDate(new Date(Date.now() + 20 * 86_400_000)),
    );

    /* Nothing inside the bar, and the date clear of it on the track. */
    await expect(bar).toHaveText("");
    const barBox = (await bar.boundingBox())!;
    const dateBox = (await date.boundingBox())!;
    const clear =
      dateBox.x >= barBox.x + barBox.width - 1 ||
      dateBox.x + dateBox.width <= barBox.x + 1;
    expect(clear, "the due date is not clear of the bar").toBe(true);

    /* Inside the lane, so it cannot reach the status pill beside it. */
    const trackBox = (await issueRow
      .locator(".prio-timeline__track")
      .boundingBox())!;
    expect(dateBox.x).toBeGreaterThanOrEqual(trackBox.x - 1);
    expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(
      trackBox.x + trackBox.width + 1,
    );
  });

  test("opens the issue from its due date as well as from its bar", async ({
    page,
  }) => {
    /*
     * Under "Not in an epic" the date is a way in.
     *
     * A reader who has just read when something is due is pointing at the
     * thing they want to open, and the date sits beside a bar that has always
     * been a link — so it leads to the same issue, by the same key. Both are
     * driven here, because "the bar still works" is half of what was asked
     * for.
     */
    const { key, issue } = await seedProjectWithSprint();
    const href = `/issues/${issue.key.toLowerCase()}`;

    await page.goto(`/projects/${key}/timeline`);

    const issueRow = page
      .locator(".prio-timeline__group")
      .filter({ hasText: "Not in an epic" })
      .locator(".prio-timeline__row")
      .first();
    const date = issueRow.locator(".prio-timeline__duedate");
    const bar = issueRow.locator(".prio-timeline__bar");

    /* Both point at the same issue, and the date says which issue it opens
       for a reader who cannot see the row it is in. */
    await expect(date).toHaveAttribute("href", href);
    await expect(bar).toHaveAttribute("href", href);
    await expect(date).toHaveAttribute("aria-label", new RegExp(issue.key));

    /* And it answers a pointer: the rule that keeps a plain date out of the
       bar's way is off for this one, and hovering it says it is a link. */
    const hover = await date.evaluate((el) => {
      const before = getComputedStyle(el);
      return {
        pointerEvents: before.pointerEvents,
        cursor: before.cursor,
      };
    });
    expect(hover.pointerEvents).toBe("auto");
    await date.hover();
    await expect(date).toHaveCSS("text-decoration-line", "underline");

    /* Clicking the date lands on that issue. */
    await date.click();
    await expect(page).toHaveURL(new RegExp(`${issue.key.toLowerCase()}$`));
    await expect(
      page.getByRole("heading", { name: issue.title }),
    ).toBeVisible();

    /* And the bar still does what it always did — the same issue, from the
       same row. */
    await page.goto(`/projects/${key}/timeline`);
    await bar.click();
    await expect(page).toHaveURL(new RegExp(`${issue.key.toLowerCase()}$`));
    await expect(
      page.getByRole("heading", { name: issue.title }),
    ).toBeVisible();
  });

  test("leaves the sprint dates as plain text", async ({ page }) => {
    /* Only the issue rows' dates lead anywhere: a sprint bar is not a link,
       so neither are the dates beside it. */
    const { key } = await seedProjectWithSprint();

    await page.goto(`/projects/${key}/timeline`);

    await expect(page.locator(".prio-timeline__sprintdate")).not.toHaveCount(0);
    await expect(page.locator("a.prio-timeline__sprintdate")).toHaveCount(0);
    await expect(
      page.locator(".prio-timeline__sprintdate.prio-timeline__date--link"),
    ).toHaveCount(0);
  });
});
