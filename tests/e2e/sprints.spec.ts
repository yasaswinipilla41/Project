import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_STATE } from "./support";

/**
 * The sprint workflow, driven the way somebody actually uses it:
 *
 *   create → add issues → plan → start → active → complete
 *
 * with the two properties that have to hold at every step asserted along the
 * way: only this project's issues can enter a sprint, and a completed sprint
 * keeps its record after its unfinished work has moved on.
 */

const created: string[] = [];
const createdIssues: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: created } } });
  }
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
});

/** A unique name, so a re-run never collides with the last one's rows. */
function sprintName(label: string) {
  return `E2E ${label} ${Date.now()}`;
}

function dateValue(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Files an issue straight into a project, so a test never eats the seeded
 * backlog.
 *
 * The number comes from an atomic `increment` and the key is built from what
 * that returns. Reading `issueSequence` first and writing the value back — as
 * this did — is a read-then-write race: two seeds that read before either
 * wrote both claimed the same number, and the second hit the unique constraint
 * on `key`. The app's own `createIssue` reserves its numbers the same way.
 */
async function seedIssue(projectKey: string, title: string) {
  const project = await prisma.project.update({
    where: { key: projectKey },
    data: { issueSequence: { increment: 1 } },
    select: { id: true, issueSequence: true },
  });
  const number = project.issueSequence;

  const reporter = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${projectKey}-${number}`,
      number,
      title,
      type: "TASK",
      status: "TODO",
      reporterId: reporter.id,
    },
    select: { id: true, key: true },
  });

  createdIssues.push(issue.id);
  return issue;
}

/** The sprint card carrying this name. */
function sprintCard(page: Page, name: string) {
  return page.locator(".prio-sprint").filter({ hasText: name });
}

async function createSprintThroughUi(page: Page, projectKey: string, name: string) {
  await page.goto(`/projects/${projectKey.toLowerCase()}/sprints`);
  await page.getByRole("button", { name: "New sprint" }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Sprint name").fill(name);
  await dialog.getByLabel("Sprint goal").fill("Complete notification module");
  await dialog.getByLabel("Start date").fill(dateValue(0));
  await dialog.getByLabel("End date").fill(dateValue(13));
  await dialog.getByRole("button", { name: "Create sprint" }).click();

  await expect(dialog).toBeHidden();
  const card = sprintCard(page, name);
  await expect(card).toBeVisible();

  const row = await prisma.sprint.findFirstOrThrow({
    where: { name },
    select: { id: true },
  });
  created.push(row.id);
  return row.id;
}

test.describe("The sprint workflow", () => {
  test("runs from creating a sprint to completing it", async ({ page }) => {
    const name = sprintName("lifecycle");
    const finished = await seedIssue("ENG", `Sprint work finished ${Date.now()}`);
    const carried = await seedIssue("ENG", `Sprint work carried ${Date.now()}`);

    await createSprintThroughUi(page, "ENG", name);
    const card = sprintCard(page, name);

    // Planned, with the goal and dates it was given.
    await expect(card.locator(".prio-sprint__status")).toHaveText(/planned/i);
    await expect(card.locator(".prio-sprint__goal")).toHaveText(
      "Complete notification module",
    );

    /* An empty sprint cannot be started — a sprint is a commitment to a set of
       work, so there has to be some. */
    await card.getByRole("button", { name: "Start sprint" }).click();
    /* Filtered rather than "the toast": the shell raises its own — a new
       teammate notice, the "created" confirmation — and any of them can still
       be on screen here. */
    await expect(
      page.locator(".prio-toast", { hasText: /at least one issue/i }),
    ).toBeVisible();
    await expect(card.locator(".prio-sprint__status")).toHaveText(/planned/i);

    // -------------------------------------------------------- add issues
    await card.getByRole("button", { name: "Add issues" }).click();
    const picker = page.getByRole("dialog");
    await expect(picker).toBeVisible();

    for (const issue of [finished, carried]) {
      await picker.getByLabel("Search the backlog").fill(issue.key);
      await picker
        .locator(".prio-sprintpicker__row", { hasText: issue.key })
        .getByRole("checkbox")
        .check();
    }
    await picker.getByRole("button", { name: /Add \d+ to sprint/ }).click();
    await expect(picker).toBeHidden();

    await expect(card.getByText(finished.key)).toBeVisible();
    await expect(card.getByText(carried.key)).toBeVisible();

    // The summary counts real issues, and nothing is finished yet.
    await expect(card.locator(".prio-sprint__stat").first()).toContainText("2");
    await expect(card).toContainText("0%");

    // ------------------------------------------------------------ start
    await card.getByRole("button", { name: "Start sprint" }).click();
    await expect(card.locator(".prio-sprint__status")).toHaveText(/active/i, {
      timeout: 15_000,
    });

    // Active: the work is grouped into columns by its current status.
    await expect(card.locator(".prio-sprint__board")).toBeVisible();
    await expect(card.locator(".prio-sprint__column").first()).toBeVisible();

    // -------------------------------------- finish one, through the issue
    /* Moved with the ordinary status workflow, so this proves the sprint
       follows `Issue.status` rather than keeping a copy of it. */
    await prisma.issue.update({
      where: { id: finished.id },
      data: { status: "DONE", completedAt: new Date() },
    });

    await page.reload();
    const reloaded = sprintCard(page, name);
    await expect(reloaded).toContainText("50%");

    // --------------------------------------------------------- complete
    await reloaded.getByRole("button", { name: "Complete sprint" }).click();
    const closing = page.getByRole("dialog");
    await expect(closing).toBeVisible();

    // Both halves are listed, on the right side of the dialog.
    const completedList = closing
      .locator("section", { hasText: /^Completed/ })
      .locator(".prio-sprintclose__item");
    const incompleteList = closing
      .locator("section", { hasText: /^Incomplete/ })
      .locator(".prio-sprintclose__item");
    await expect(completedList).toContainText([finished.key]);
    await expect(incompleteList).toContainText([carried.key]);

    // The destination is an explicit choice.
    await closing.getByRole("radio", { name: /Backlog/ }).check();
    await closing.getByRole("button", { name: "Complete sprint" }).click();
    await expect(closing).toBeHidden();

    // ---------------------------------------------------------- history
    const done = sprintCard(page, name);
    await expect(done.locator(".prio-sprint__status")).toHaveText(/completed/i);

    /* The record survives the move: the carried issue is out of the sprint,
       and the sprint still names it on the incomplete side. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: carried.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });

    await expect(done.locator(".prio-sprint__record")).toContainText(finished.key);
    await expect(done.locator(".prio-sprint__record")).toContainText(carried.key);
    await expect(done).toContainText("50%");
  });

  test("offers only this project's backlog in the issue picker", async ({
    page,
  }) => {
    /* The scoping rule, seen where somebody would see it. An issue from another
       project is not merely rejected on submit — it is not offered, and cannot
       be searched for. */
    const name = sprintName("scoping");
    const ours = await seedIssue("ENG", `Engineering work ${Date.now()}`);
    const theirs = await seedIssue("WEB", `Website work ${Date.now()}`);

    await createSprintThroughUi(page, "ENG", name);

    await sprintCard(page, name).getByRole("button", { name: "Add issues" }).click();
    const picker = page.getByRole("dialog");
    await expect(picker).toBeVisible();

    await expect(picker.getByText(ours.key)).toBeVisible();
    await expect(picker.getByText(theirs.key)).toHaveCount(0);

    // Searching for it by key finds nothing either.
    await picker.getByLabel("Search the backlog").fill(theirs.key);
    await expect(picker.locator(".prio-sprintpicker__row")).toHaveCount(0);
  });

  test("is reachable from the project's tab strip and the Create menu", async ({
    page,
  }) => {
    await page.goto("/projects/eng");
    await page
      .locator(".prio-projectnav")
      .getByRole("link", { name: "Sprints" })
      .click();
    await expect(page).toHaveURL(/\/projects\/eng\/sprints$/);

    // "Sprint" sits in the top bar's Create menu, beside the issue types.
    await page.getByRole("button", { name: "Choose what to create" }).click();
    await page.getByRole("menuitem", { name: "Sprint", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "New sprint" })).toBeVisible();
    /* Opened from inside a project, so the sprint is that project's and there
       is nothing to choose. */
    await expect(dialog.getByLabel("Project")).toHaveCount(0);
  });
});

test.describe("Sprints as a member of the project", () => {
  test.use({ storageState: MEMBER_STATE });

  test("can add work to a sprint but not start it", async ({ page }) => {
    /* The existing permission split, applied unchanged: working in a project
       you belong to is a member's, the project's own lifecycle is not. */
    const name = sprintName("member");
    const sprint = await prisma.sprint.create({
      data: {
        name,
        goal: "Member visibility",
        startDate: new Date(),
        endDate: new Date(Date.now() + 12 * 86_400_000),
        projectId: (
          await prisma.project.findUniqueOrThrow({
            where: { key: "ENG" },
            select: { id: true },
          })
        ).id,
        createdById: (
          await prisma.user.findFirstOrThrow({
            where: { role: "ADMIN" },
            select: { id: true },
          })
        ).id,
      },
      select: { id: true },
    });
    created.push(sprint.id);

    await page.goto("/projects/eng/sprints");
    const card = sprintCard(page, name);
    await expect(card).toBeVisible();

    // Theirs: filling the sprint.
    await expect(card.getByRole("button", { name: "Add issues" })).toBeVisible();
    // Not theirs: starting it, or editing it.
    await expect(card.getByRole("button", { name: "Start sprint" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New sprint" })).toHaveCount(0);
  });
});
