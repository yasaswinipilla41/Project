import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE, openBurndown, watchForProblems } from "./support";

/**
 * The three surfaces that estimates made possible: Effort on a work item, the
 * burndown drawn from it, and the record of who work was handed to.
 *
 * They are one spec because they are one chain. An Effort typed onto an issue
 * seeds the Remaining that a burndown is drawn from, and the assignment that
 * put the issue in front of somebody is the row Backlog History shows. Testing
 * them apart would mean stubbing the middle of that chain in two places and
 * proving neither end meets it.
 *
 * Everything here runs as the administrator, because the administrator is the
 * only person who can assign work to somebody else — which is the hand-over
 * Backlog History exists to record.
 */

test.use({ storageState: ADMIN_STATE });

const createdProjects: string[] = [];
const createdSprints: string[] = [];
const createdIssues: string[] = [];

test.afterAll(async () => {
  if (createdIssues.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssues } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

/**
 * A project of this spec's own, with the administrator and one member in it.
 *
 * Its own rather than ENG, for the reason the sprint lifecycle spec gives:
 * a burndown is a statement about everything in a sprint, so it can only be
 * asserted exactly against work this spec put there. A seeded project also
 * carries whatever sprint somebody using the application has running.
 */
async function makeProject() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const member = await prisma.user.findFirstOrThrow({
    where: { role: "MEMBER", isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const key = `EB${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Estimates fixture ${key}`,
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
    },
    select: { id: true },
  });
  createdProjects.push(project.id);
  return { id: project.id, key, admin, member };
}

/**
 * An issue straight into a project.
 *
 * The number comes from an atomic `increment`, the same way `createIssue`
 * reserves one: reading the sequence and writing it back is a race that two
 * seeds can both lose, and the loser collides on the unique key.
 */
async function seedIssue(
  projectKey: string,
  title: string,
  extra: { effortHours?: number; remainingHours?: number; sprintId?: string } = {},
) {
  const project = await prisma.project.update({
    where: { key: projectKey },
    data: { issueSequence: { increment: 1 } },
    select: { id: true, issueSequence: true },
  });
  const reporter = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${projectKey}-${project.issueSequence}`,
      number: project.issueSequence,
      title,
      type: "TASK",
      status: "TODO",
      reporterId: reporter.id,
      ...extra,
    },
    select: { id: true, key: true },
  });
  createdIssues.push(issue.id);
  return issue;
}

function isoDay(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(12, 0, 0, 0);
  return date;
}

/**
 * One of the two hours boxes on a work item.
 *
 * Scoped to the control rather than asked of the whole page. `getByLabel`
 * matches any accessible name containing the word, and an issue page carries
 * plenty of them — a project called "Effort fixture" is enough to make the
 * page-wide version resolve to a link. Inside `.prio-effort` there are two
 * fields and nothing else, which is exactly the question being asked.
 */
function hoursField(page: Page, label: "Effort" | "Remaining") {
  return page.locator(".prio-effort").getByLabel(label);
}

/** Types into one of them and lets it commit on blur. */
async function setHours(page: Page, label: "Effort" | "Remaining", value: string) {
  const field = hoursField(page, label);
  await field.fill(value);
  await field.blur();
}

test.describe("Effort and Remaining Hours", () => {
  test("an estimate saves, seeds Remaining, survives a reload, and clears", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const project = await makeProject();
    const issue = await seedIssue(project.key, "Estimate me");

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await expect(hoursField(page, "Effort")).toHaveValue("");
    await expect(hoursField(page, "Remaining")).toHaveValue("");

    await setHours(page, "Effort", "8");

    /*
     * Remaining starts as the whole of the estimate.
     *
     * Before anybody has worked on it there is nothing else it could honestly
     * be, and a burndown with no starting reading has nothing to draw. It is
     * seeded on the server rather than in the form, so every path that sets
     * an estimate gets it — which is what this asserts by reading it back
     * from the database rather than from the box that was typed into.
     */
    await expect
      .poll(async () => {
        const row = await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { effortHours: true, remainingHours: true },
        });
        return [row.effortHours, row.remainingHours];
      })
      .toEqual([8, 8]);

    await page.reload();
    await expect(hoursField(page, "Effort")).toHaveValue("8");
    await expect(hoursField(page, "Remaining")).toHaveValue("8");

    // Revised downward on its own, without touching the estimate.
    await setHours(page, "Remaining", "3");
    await expect
      .poll(async () =>
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: issue.id },
            select: { remainingHours: true },
          })
        ).remainingHours,
      )
      .toBe(3);
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { effortHours: true },
        })
      ).effortHours,
    ).toBe(8);

    /* Emptied means "nobody has said", not zero — the two are different
       answers and a burndown treats them differently. */
    await setHours(page, "Effort", "");
    await expect
      .poll(async () =>
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: issue.id },
            select: { effortHours: true },
          })
        ).effortHours,
      )
      .toBeNull();

    expect(consoleErrors).toEqual([]);
  });
});

test.describe("The burndown on a sprint", () => {
  test("draws from the sprint's estimates, and says so when there are none", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const project = await makeProject();

    const sprint = await prisma.sprint.create({
      data: {
        projectId: project.id,
        createdById: project.admin.id,
        name: `Burndown ${Date.now()}`,
        goal: "Draw a chart",
        status: "ACTIVE",
        startDate: isoDay(-3),
        endDate: isoDay(3),
      },
      select: { id: true },
    });
    createdSprints.push(sprint.id);

    const detail = `/projects/${project.key.toLowerCase()}/sprints/${sprint.id}`;

    /*
     * Nothing estimated yet, so there is nothing to burn down — and the page
     * says that rather than drawing a flat line at zero, which would be a
     * claim that the sprint is finished.
     */
    const unestimated = await seedIssue(project.key, "No estimate", {
      sprintId: sprint.id,
    });
    await page.goto(detail);
    await openBurndown(page);
    await expect(
      page.getByRole("heading", { name: "Burndown Chart" }),
    ).toBeVisible();
    await expect(page.locator("p", { hasText: /nothing to burn down/i })).toHaveCount(1);
    await expect(page.getByRole("img", { name: /^Burndown:/ })).toHaveCount(0);

    // Two estimated items, and the chart appears with their total.
    await seedIssue(project.key, "Estimated six", {
      sprintId: sprint.id,
      effortHours: 6,
      remainingHours: 6,
    });
    await seedIssue(project.key, "Estimated four", {
      sprintId: sprint.id,
      effortHours: 4,
      remainingHours: 1,
    });

    await page.goto(detail);
    await openBurndown(page);
    const chart = page.getByRole("img", { name: /^Burndown:/ });
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute(
      "aria-label",
      /10 hours committed, 7 remaining/,
    );

    /* Scoped to the figure throughout: the sprint's own stats carry a
       "Remaining" label too, and every claim below is about the chart. */
    const legend = page.locator(".prio-burndown__legend");

    /* The unestimated item is counted and said out loud rather than quietly
       left out: a burndown that silently ignores work is the one that gets
       trusted and should not be. */
    await expect(legend).toContainText("1 item not estimated");

    await expect(page.locator("polyline.prio-burndown__ideal")).toHaveCount(1);
    await expect(page.locator("polyline.prio-burndown__actual")).toHaveCount(1);
    await expect(legend.getByText("Remaining", { exact: true })).toBeVisible();
    await expect(legend.getByText("Ideal", { exact: true })).toBeVisible();

    /*
     * The ideal line runs from the commitment down to zero across the sprint,
     * and it is arithmetic rather than a reading — so it is there on day one,
     * when nothing has been recorded at all. Checked by its endpoints: the
     * first point sits at the top of the scale and the last at the bottom.
     */
    const ideal = (await page
      .locator("polyline.prio-burndown__ideal")
      .getAttribute("points"))!;
    const pairs = ideal.trim().split(/\s+/).map((p) => p.split(",").map(Number));
    expect(pairs.length).toBeGreaterThan(1);
    expect(pairs[0]![1]!).toBeLessThan(pairs.at(-1)![1]!);

    // Estimating the last one moves the total, from the same screen.
    await page.goto(`/issues/${unestimated.key.toLowerCase()}`);
    await setHours(page, "Effort", "2");
    /* Waited for before navigating away. The commit is a server action, and
       leaving the page the moment the field blurs is a race the chart loses
       by being read before the estimate has landed. */
    await expect
      .poll(async () =>
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: unestimated.id },
            select: { effortHours: true },
          })
        ).effortHours,
      )
      .toBe(2);
    await page.goto(detail);
    await openBurndown(page);
    await expect(page.getByRole("img", { name: /^Burndown:/ })).toHaveAttribute(
      "aria-label",
      /12 hours committed, 9 remaining/,
    );
    await expect(legend).not.toContainText("not estimated");

    expect(consoleErrors).toEqual([]);
  });
});

test.describe("Backlog History", () => {
  test("records who work went to, who decided, and narrows on its filters", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const project = await makeProject();
    const issue = await seedIssue(project.key, `Handed over ${Date.now()}`);

    const base = `/projects/${project.key.toLowerCase()}`;

    /* Assigned through the interface, so what is recorded is what the
       application actually writes rather than a row put there by the test. */
    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    /* The assignee control, told apart from the status/priority triggers
       beside it by the person it shows; its entries are `menuitemradio`,
       because one person is chosen out of a set. */
    await page
      .locator(".prio-fieldtrigger:has(.prio-fieldtrigger__person)")
      .first()
      .click();
    await page
      .getByRole("menuitemradio", { name: new RegExp(project.member.name, "i") })
      .first()
      .click();
    await expect
      .poll(
        async () =>
          (
            await prisma.issue.findUniqueOrThrow({
              where: { id: issue.id },
              select: { assigneeId: true },
            })
          ).assigneeId,
        { timeout: 15_000 },
      )
      .toBe(project.member.id);

    await page.goto(`${base}/backlog/history`);
    await expect(
      page.getByRole("heading", { name: "Backlog History" }),
    ).toBeVisible();

    const row = page.locator("tbody tr").filter({ hasText: issue.key });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Unassigned");
    await expect(row).toContainText(project.member.name);
    await expect(row).toContainText("Manual");

    /*
     * Who did it, never who received it.
     *
     * Reading the recipient out of the "Assigned By" column is the mistake
     * this view exists to avoid making: it would report every automatic
     * hand-over as the person it landed on having chosen it themselves.
     */
    const assignedBy = row.locator("td").nth(4);
    await expect(assignedBy).not.toContainText(project.member.name);

    // The project's own page is fixed to it, and cannot be widened by hand.
    await expect(page.locator("th", { hasText: "Project" })).toHaveCount(0);
    const other = await makeProject();
    const elsewhere = await seedIssue(other.key, `Elsewhere ${Date.now()}`);
    await prisma.issue.update({
      where: { id: elsewhere.id },
      data: { assigneeId: other.member.id },
    });
    await page.goto(
      `${base}/backlog/history?project=${other.id}&projectId=${other.id}`,
    );
    await expect(page.locator("tbody tr").filter({ hasText: elsewhere.key })).toHaveCount(0);
    await expect(page.locator("tbody tr").filter({ hasText: issue.key })).toHaveCount(1);

    // A filter that cannot match empties it, and clearing brings it back.
    await page.goto(`${base}/backlog/history?q=zzz-no-such-item-zzz`);
    await expect(page.getByText("No assignment matches these filters")).toBeVisible();
    await page.goto(`${base}/backlog/history?q=${encodeURIComponent(issue.key)}`);
    await expect(page.locator("tbody tr").filter({ hasText: issue.key })).toHaveCount(1);

    /* And the cross-project view names the project instead of assuming it. */
    await page.goto("/backlog/history");
    await expect(page.locator("th", { hasText: "Project" })).toHaveCount(1);
    await expect(
      page.locator("tbody tr").filter({ hasText: issue.key }),
    ).toContainText(project.key);

    expect(consoleErrors).toEqual([]);
  });

  test("is reachable from the sidebar and from a project's own tabs", async ({
    page,
  }) => {
    const project = await makeProject();

    await page.goto("/issues");
    await page.locator('.prio-sidebar a[href="/backlog/history"]').click();
    await expect(page).toHaveURL(/\/backlog\/history$/);
    await expect(
      page.getByRole("heading", { name: "Backlog History" }),
    ).toBeVisible();

    await page.goto(`/projects/${project.key.toLowerCase()}/list`);
    /* Scoped to the project's own tabs: the sidebar carries a link of the
       same name to the cross-project view, and the point here is that both
       ways in exist and lead to different scopes. */
    await page
      .locator(".prio-projectnav")
      .getByRole("link", { name: "Backlog History" })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}/backlog/history$`),
    );
    await expect(
      page.getByRole("heading", { name: "Backlog History" }),
    ).toBeVisible();
  });
});
