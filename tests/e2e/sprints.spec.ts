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
const createdProjects: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: created } } });
  }
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

/**
 * A project of this spec's own, with the administrator in it.
 *
 * "One sprint runs at a time in a project" is a real rule, so a test that has
 * to *start* a sprint cannot share ENG with whatever sprint somebody using
 * the application already has running there — it would be asserting the rule
 * against state it inherited rather than state it set up.
 */
async function makeIsolatedProject(): Promise<string> {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `LC${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Lifecycle fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  createdProjects.push(project.id);
  return key;
}

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
    const key = await makeIsolatedProject();
    const finished = await seedIssue(key, `Sprint work finished ${Date.now()}`);
    const carried = await seedIssue(key, `Sprint work carried ${Date.now()}`);

    await createSprintThroughUi(page, key, name);
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

    /* Both are in the sprint, but the block is a summary: its issues are
       listed on the sprint's own page, not drawn inside the block. */
    expect(
      await prisma.issue.count({
        where: { id: { in: [finished.id, carried.id] }, sprintId: { not: null } },
      }),
    ).toBe(2);
    await expect(card.getByText(finished.key)).toHaveCount(0);

    // The summary counts real issues, and nothing is finished yet.
    await expect(card.locator(".prio-sprint__stat").first()).toContainText("2");
    await expect(card).toContainText("0%");

    // ------------------------------------------------------------ start
    await card.getByRole("button", { name: "Start sprint" }).click();
    /* The running sprint reads "Current Sprint" rather than "Active": a list
       of sprints is read to find out which one is *now*, and the old word
       answered that only for somebody who already knew the vocabulary. The
       stored status is untouched — this is what the badge calls it. */
    await expect(card.locator(".prio-sprint__status")).toHaveText(
      /current sprint/i,
      { timeout: 15_000 },
    );

    // Active, and still a summary: no issue board inside the block.
    await expect(card.locator(".prio-sprint__board")).toHaveCount(0);

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

    await expect(done).toContainText("50%");

    // The record is read on the sprint's own page, which still names both.
    await done.locator(".prio-sprint__identitylink").click();
    await expect(page.getByText("Issues in this sprint")).toBeVisible();
    await expect(page.getByText(finished.key)).toBeVisible();
    await expect(page.getByText(carried.key)).toBeVisible();
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

  test("clicking a sprint opens its own details page, and Back returns to the list", async ({
    page,
  }) => {
    /*
     * The sprint's name/goal/dates are the click target on its card — not
     * the actions beside them — and each sprint has its own URL under the
     * project, so two different sprints never land on the same page.
     */
    const first = sprintName("nav-first");
    const second = sprintName("nav-second");
    await createSprintThroughUi(page, "ENG", first);
    await createSprintThroughUi(page, "ENG", second);

    await page.goto("/projects/eng/sprints");

    const firstCard = sprintCard(page, first);
    await firstCard.locator(".prio-sprint__identitylink").click();
    await expect(page).toHaveURL(/\/projects\/eng\/sprints\/[a-z0-9]+$/i);
    const firstUrl = page.url();
    await expect(page.getByRole("heading", { name: first })).toBeVisible();
    // Still inside the project shell, with Sprints marked as the active tab.
    await expect(
      page.locator(".prio-projectnav__tab", { hasText: "Sprints" }),
    ).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: /Back to sprints/i }).click();
    await expect(page).toHaveURL(/\/projects\/eng\/sprints$/);

    // A different sprint's card leads to a different URL, showing that one.
    const secondCard = sprintCard(page, second);
    await secondCard.locator(".prio-sprint__identitylink").click();
    await expect(page).toHaveURL(/\/projects\/eng\/sprints\/[a-z0-9]+$/i);
    await expect(page.getByRole("heading", { name: second })).toBeVisible();
    expect(page.url()).not.toBe(firstUrl);

    // The actions beside the name are unaffected by the new click target.
    await page.goto("/projects/eng/sprints");
    await expect(
      firstCard.getByRole("button", { name: "Add issues" }),
    ).toBeVisible();
  });
});

test.describe("Sprints as a member of the project", () => {
  test.use({ storageState: MEMBER_STATE });

  test("can fill and correct a sprint, but not start, create or delete one", async ({
    page,
  }) => {
    /*
     * The permission split: filling a sprint — adding issues, moving them
     * elsewhere — and correcting its name, goal or dates both belong to
     * whoever may open the project. Whether the sprint *exists* at all,
     * whether it has *begun*, and whether it has *ended* stay with an
     * administrator (a Full Stack Developer may also start one, but this
     * member is neither).
     */
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

    const issue = await seedIssue("ENG", `Member's own work ${Date.now()}`);

    await page.goto("/projects/eng/sprints");
    const card = sprintCard(page, name);
    await expect(card).toBeVisible();

    // Theirs: filling the sprint, and correcting its details.
    await expect(card.getByRole("button", { name: "Add issues" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
    // Not theirs: starting it, creating another, or deleting this one.
    await expect(card.getByRole("button", { name: "Start sprint" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Delete sprint" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New sprint" })).toHaveCount(0);

    /*
     * Editing is fully functional here, not just visible — driven through
     * the real "Edit sprint" dialog, the same one Admin uses, so the fix is
     * proven at the boundary a hidden-button assertion would miss.
     */
    const editedName = `${name} (edited)`;
    await card.getByRole("button", { name: "Edit" }).click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByRole("heading", { name: "Edit sprint" })).toBeVisible();
    await editDialog.getByLabel("Sprint name").fill(editedName);
    await editDialog.getByRole("button", { name: "Save" }).click();
    await expect(editDialog).toBeHidden();

    await expect(sprintCard(page, editedName)).toBeVisible();
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: sprint.id },
        select: { name: true },
      }),
    ).toMatchObject({ name: editedName });

    /*
     * The actual bug this fixed: a member clicking "Add issues" used to be
     * told "This action requires an administrator." — the button was shown
     * but the server refused it. Driven through the real dialog so the fix
     * is proven at the boundary the bug was in, not just that a button is
     * visible.
     */
    await card.getByRole("button", { name: "Add issues" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog
      .locator("li")
      .filter({ hasText: issue.key })
      .locator("input[type=checkbox]")
      .check();
    await dialog.getByRole("button", { name: /Add \d+ to sprint/ }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(/administrator/i)).toHaveCount(0);

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: sprint.id });
  });
});

test.describe("A sprint's own page", () => {
  /**
   * A sprint in a project of its own, holding issues in known statuses, so
   * the blocks and the percentage have exact expectations.
   */
  async function seedSprintWith(statuses: ("TODO" | "IN_PROGRESS" | "DONE")[]) {
    const key = await makeIsolatedProject();
    const project = await prisma.project.findUniqueOrThrow({
      where: { key },
      select: { id: true },
    });
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    const sprint = await prisma.sprint.create({
      data: {
        name: sprintName("blocks"),
        startDate: new Date(),
        endDate: new Date(Date.now() + 12 * 86_400_000),
        projectId: project.id,
        createdById: admin.id,
      },
      select: { id: true, name: true },
    });
    created.push(sprint.id);

    const issues = [];
    for (const [index, status] of statuses.entries()) {
      const issue = await seedIssue(key, `Block issue ${index} ${Date.now()}`);
      await prisma.issue.update({
        where: { id: issue.id },
        data: { status, sprintId: sprint.id },
      });
      issues.push({ ...issue, status });
    }
    return { key: key.toLowerCase(), sprint, issues };
  }

  test("groups its issues by status, showing only statuses that hold one", async ({
    page,
  }) => {
    const { key, sprint, issues } = await seedSprintWith([
      "TODO",
      "TODO",
      "IN_PROGRESS",
    ]);
    const [newA, newB, inProgress] = issues;

    await page.goto(`/projects/${key}/sprints`);
    await sprintCard(page, sprint.name)
      .locator(".prio-sprint__identitylink")
      .click();
    await expect(page.getByText("Issues in this sprint")).toBeVisible();

    const newBlock = page.getByRole("region", { name: /^New,/ });
    const progressBlock = page.getByRole("region", { name: /^In Progress,/ });

    await expect(newBlock.getByText(newA!.key)).toBeVisible();
    await expect(newBlock.getByText(newB!.key)).toBeVisible();
    await expect(progressBlock.getByText(inProgress!.key)).toBeVisible();
    // Empty statuses draw no block.
    await expect(page.getByRole("region", { name: /^Done,/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Backlog,/ })).toHaveCount(0);

    // ------------------------------- a status change moves the card
    const card = newBlock.locator(".prio-board__card", { hasText: newA!.key });
    await card.locator(".prio-board__card-statustrigger").click();
    await page
      .getByRole("menu", { name: `Change status of ${newA!.key}` })
      .getByRole("menuitemradio", { name: "In Progress", exact: true })
      .click();

    await expect(progressBlock.getByText(newA!.key)).toBeVisible();
    await expect(newBlock.getByText(newA!.key)).toHaveCount(0);

    /*
     * The two assertions above are satisfied by the optimistic move alone, so
     * at this point the write may still be in flight. Reloading here renders
     * the issue where it still is — and a reloaded page never re-renders, so
     * the retries below would wait out their timeout against a snapshot taken
     * before the change landed. It looks exactly like a lost write and is not
     * one.
     *
     * The board says when it is settled, so wait for that rather than for a
     * duration. It clears only once `updateIssue` has answered and the
     * refresh it triggers has re-rendered.
     */
    await expect(page.locator(".prio-sprint__board")).not.toHaveAttribute(
      "data-pending",
      "true",
    );

    // And it is the server's answer, not only the screen's.
    await page.reload();
    await expect(
      page.getByRole("region", { name: /^In Progress,/ }).getByText(newA!.key),
    ).toBeVisible();
  });

  test("shows the completion percentage beside the progress bar", async ({
    page,
  }) => {
    // 4 issues, 1 Done: 25%, beside the bar on the list and on the page.
    const { key, sprint } = await seedSprintWith([
      "DONE",
      "TODO",
      "TODO",
      "IN_PROGRESS",
    ]);

    await page.goto(`/projects/${key}/sprints`);
    const card = sprintCard(page, sprint.name);
    await expect(card.locator(".prio-sprint__progresslabel")).toHaveText("25%");

    await card.locator(".prio-sprint__identitylink").click();
    await expect(page.locator(".prio-sprint__progresslabel")).toHaveText("25%");
  });

  test("opens Iterations / Sprints inside the project, and comes back to it", async ({
    page,
  }) => {
    const { key, sprint } = await seedSprintWith(["TODO"]);

    await page.goto(`/projects/${key}/sprints`);
    await page.getByRole("link", { name: "Iterations / Sprints" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}/sprints/iterations$`));
    // Still inside the project, with Sprints the active tab.
    await expect(
      page.locator(".prio-projectnav__tab", { hasText: "Sprints" }),
    ).toHaveAttribute("aria-current", "page");

    // A row opens the sprint's page in this project, and Back returns here.
    await page.getByRole("link", { name: "View" }).first().click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/projects/${key}/sprints/${sprint.id}` &&
        url.searchParams.get("from") === "iterations",
    );
    const back = page.locator(".prio-backlink--sprint");
    await expect(back).toHaveText(/Back to iterations/);
    // #5b04a7 in the light theme …
    await expect(back).toHaveCSS("color", "rgb(91, 4, 167)");
    // … and #cfa5f3 in the dark one, text and chevron alike.
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(back).toHaveCSS("color", "rgb(207, 165, 243)");
    await expect(back.locator("svg")).toHaveCSS("color", "rgb(207, 165, 243)");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await expect(back).toHaveCSS("color", "rgb(91, 4, 167)");
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}/sprints/iterations$`));
  });
});

test.describe("The All Projects page", () => {
  test("carries no Iterations / Sprints section", async ({ page }) => {
    /* Iterations / Sprints lives inside each project's Sprints section now;
       the directory lists projects and nothing else. */
    await page.goto("/projects");
    await expect(
      page.getByRole("heading", { name: "Projects", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Iterations / Sprints")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Choose a project" })).toHaveCount(0);
  });
});
