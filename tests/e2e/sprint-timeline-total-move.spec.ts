import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Three things a sprint has to say, and one thing it has to do:
 *
 *   the Timeline says when each sprint starts and ends,
 *   Sprint Details says how many issues are in the sprint,
 *   the issue menu moves an issue to the next sprint,
 *
 * and the move is what ties them together — both totals follow it, and the
 * issue's status does not.
 *
 * Two sprints in a project of this spec's own, because "the next sprint" is a
 * statement about a project's whole sprint list and cannot be asserted
 * against a project whose sprints somebody else is using.
 */

test.use({ storageState: ADMIN_STATE });

const KEY = `SPMOVE${Date.now().toString(36).slice(-3)}`.toUpperCase().slice(0, 12);

let projectId = "";
let firstSprintId = "";
let secondSprintId = "";
let issueId = "";
const issueKey = `${KEY}-1`;

/** Midday, so a timezone cannot roll the date over. */
function day(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(12, 0, 0, 0);
  return date;
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const project = await prisma.project.create({
    data: {
      key: KEY,
      name: `Sprint move fixture ${KEY}`,
      createdById: admin.id,
      issueSequence: 1,
      members: { create: [{ userId: admin.id }] },
    },
    select: { id: true },
  });
  projectId = project.id;

  const first = await prisma.sprint.create({
    data: {
      projectId: project.id,
      createdById: admin.id,
      name: `${KEY} sprint one`,
      status: "ACTIVE",
      startDate: day(-3),
      endDate: day(4),
    },
    select: { id: true },
  });
  firstSprintId = first.id;

  /* Starts after the first, which is what makes it "next". */
  const second = await prisma.sprint.create({
    data: {
      projectId: project.id,
      createdById: admin.id,
      name: `${KEY} sprint two`,
      status: "PLANNED",
      startDate: day(5),
      endDate: day(12),
    },
    select: { id: true },
  });
  secondSprintId = second.id;

  /*
   * Ready for QA specifically: the requirement names it, and it is a status
   * nothing about moving between sprints should be able to touch.
   *
   * It carries a due date because the timeline draws work that is scheduled
   * and shows an empty state when nothing is — existing behaviour, and the
   * sprint bars live on that same timeline.
   */
  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      sprintId: first.id,
      key: issueKey,
      number: 1,
      title: "Work that is already waiting for a tester",
      type: "TASK",
      status: "IN_REVIEW",
      reporterId: admin.id,
      dueDate: day(3),
    },
    select: { id: true },
  });
  issueId = issue.id;
});

test.afterAll(async () => {
  if (projectId) {
    await prisma.issue.deleteMany({ where: { projectId } });
    await prisma.sprint.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
  }
});

test.describe("the Timeline's sprint bars", () => {
  test("carry their own start and end dates, read from the sprint", async ({
    page,
  }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/timeline`);

    const bars = page.locator(".prio-timeline__bar--sprint");
    await expect(bars).toHaveCount(2);

    /*
     * The dates are the sprint's own, formatted here from the same stored
     * values the page reads — not typed into the test as literals, which
     * would pass just as well against a hard-coded date in the page.
     */
    const sprints = await prisma.sprint.findMany({
      where: { projectId },
      orderBy: { startDate: "asc" },
      select: { startDate: true, endDate: true },
    });

    const shown = await page
      .locator(".prio-timeline__sprintdate")
      .allInnerTexts();
    expect(shown).toHaveLength(4);

    const expected = (value: Date) =>
      `${String(value.getDate()).padStart(2, "0")} ${
        [
          "Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ][value.getMonth()]
      } ${value.getFullYear()}`;

    for (const sprint of sprints) {
      expect(shown).toContain(expected(sprint.startDate));
      expect(shown).toContain(expected(sprint.endDate));
    }

    /* One at each end of its own bar: the start sits left of the bar's left
       edge, the end right of its right edge. Measured, because "at the ends
       of the bar" is a claim about position and nothing else proves it. */
    for (let index = 0; index < 2; index += 1) {
      const bar = (await bars.nth(index).boundingBox())!;
      const start = (await page
        .locator('.prio-timeline__sprintdate[data-edge="start"]')
        .nth(index)
        .boundingBox())!;
      const end = (await page
        .locator('.prio-timeline__sprintdate[data-edge="end"]')
        .nth(index)
        .boundingBox())!;

      expect(start.x + start.width, `sprint ${index} start date`).toBeLessThanOrEqual(
        bar.x + 1,
      );
      expect(end.x, `sprint ${index} end date`).toBeGreaterThanOrEqual(
        bar.x + bar.width - 1,
      );
    }
  });

  test("keeps the rest of the timeline as it was", async ({ page }) => {
    await page.goto("/projects/eng/timeline");

    /* The seeded project's timeline still draws its issue rows, its own bars
       and the "Not in an epic" grouping — none of which this change touches,
       and all of which share the lane the sprint dates were added to. */
    await expect(page.locator(".prio-timeline__bar").first()).toBeVisible();
    await expect(page.getByText("Not in an epic").first()).toBeVisible();
    /* The issue bar's own due date, which now reads beside the bar rather
       than inside it — its own class, so this cannot accidentally match a
       sprint's dates in the block above. */
    await expect(page.locator(".prio-timeline__duedate").first()).toBeVisible();
  });
});

test.describe("Sprint Details", () => {
  test("counts every issue in the sprint, whatever its status", async ({
    page,
  }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/sprints/${firstSprintId}`);

    const total = page.locator(".prio-sprint__total");
    await expect(total).toBeVisible();
    await expect(total).toHaveText("Total Issues: 1");

    /* Sits with the chart it describes, not with the summary strip above. */
    const chart = page.locator(".prio-sprint__charthead");
    await expect(chart.getByText("Issues by status")).toBeVisible();
    await expect(chart.locator(".prio-sprint__total")).toHaveCount(1);

    /* And the chart itself is untouched: every status still draws a column,
       and the one issue is counted under its own. */
    await expect(page.locator(".prio-isochart__col")).not.toHaveCount(0);
    await expect(
      page.locator('.prio-isochart__col[data-status="IN_REVIEW"]'),
    ).toHaveAttribute("aria-label", /Ready for QA: 1 issue/);
  });
});

test.describe("Move, from the issue's own menu", () => {
  test("hands the issue to the next sprint and leaves its status alone", async ({
    page,
  }) => {
    const source = `/projects/${KEY.toLowerCase()}/sprints/${firstSprintId}`;
    const destination = `/projects/${KEY.toLowerCase()}/sprints/${secondSprintId}`;

    await page.goto(destination);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 0",
    );

    await page.goto(source);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 1",
    );

    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issueKey })
      .first();
    await expect(card).toBeVisible();
    await expect(
      card.locator(".prio-board__card-status .prio-status"),
    ).toHaveAttribute("data-status", "IN_REVIEW");

    /*
     * Driven through the card's own Move to control.
     *
     * This used to go through the ⋮ menu, which carried a single "Move to
     * next sprint". That entry has since been replaced by a dedicated
     * control offering the whole set — restore, the project's current or
     * upcoming sprint by name and dates, and the backlog — so the move is
     * driven where it now lives. What is asserted below is unchanged: where
     * the issue ends up, what its status is, and that both sprints' figures
     * follow it.
     *
     * The ⋮ menu is still checked for the actions it has always had, because
     * gaining a control beside it must not cost it any of them.
     */
    await card.getByRole("button", { name: `Actions for ${issueKey}` }).click();
    const actions = page.getByRole("menu", { name: `Actions for ${issueKey}` });
    await expect(actions.getByRole("menuitem", { name: "Open / edit" })).toBeVisible();
    await expect(actions.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await expect(actions.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.keyboard.press("Escape");

    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issueKey} to another`) })
      .click();

    /* Named and dated — the second sprint is this project's only other open
       one, so it is exactly what "current or upcoming" resolves to here. */
    const menu = page.getByRole("menu", { name: new RegExp(`Move ${issueKey}`) });
    await menu.getByRole("menuitem", { name: `${KEY} sprint two` }).click();

    /* The control's own wording: "<key> moved to <sprint>". */
    await expect(page.locator(".prio-toast")).toContainText(
      `${issueKey} moved to`,
    );

    /* The database is the arbiter: the sprint changed, the status did not. */
    await expect
      .poll(async () => {
        const row = await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { sprintId: true, status: true },
        });
        return `${row.sprintId}/${row.status}`;
      })
      .toBe(`${secondSprintId}/IN_REVIEW`);

    // The source sprint has lost it, and says so.
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 0",
    );
    await expect(
      page.locator(".prio-board__card").filter({ hasText: issueKey }),
    ).toHaveCount(0);

    // The destination has gained it, still Ready for QA.
    await page.goto(destination);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 1",
    );
    const moved = page
      .locator(".prio-board__card")
      .filter({ hasText: issueKey })
      .first();
    await expect(moved).toBeVisible();
    await expect(
      moved.locator(".prio-board__card-status .prio-status"),
    ).toHaveAttribute("data-status", "IN_REVIEW");
    await expect(
      page.locator('.prio-isochart__col[data-status="IN_REVIEW"]'),
    ).toHaveAttribute("aria-label", /Ready for QA: 1 issue/);
  });

  test("is not offered where an issue has no sprint to move on from", async ({
    page,
  }) => {
    /*
     * The Flow Board draws the same card, and an issue there may be in no
     * sprint at all — so the menu there keeps exactly the actions it had.
     */
    await page.goto("/projects/eng/board");
    const card = page.locator(".prio-board__card").first();
    await expect(card).toBeVisible();
    const key = (await card.locator(".prio-key").innerText()).trim();

    await card.getByRole("button", { name: `Actions for ${key}` }).click();
    const menu = page.getByRole("menu", { name: `Actions for ${key}` });
    await expect(menu.getByRole("menuitem", { name: "Open / edit" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    /* Moving between sprints is a sprint's own control and belongs to the
       sprint board; a board card, whose issue may be in no sprint at all, is
       given neither a sprint entry in its ⋮ menu nor the Move control. */
    await expect(menu.getByRole("menuitem", { name: /sprint/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      card.getByRole("button", { name: new RegExp(`Move ${key} to another`) }),
    ).toHaveCount(0);
  });
});
