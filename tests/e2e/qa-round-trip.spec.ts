import { expect, test, type Browser, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { signIn } from "./support";

/**
 * The whole workflow, driven through the interface by three different people.
 *
 * Everything here is asserted somewhere else as well — the rules against the
 * server in `tests/qa-return-to-reporter.test.ts`, the statuses in
 * `tests/qa-and-administration.spec.ts`. What this adds is that the three
 * people can actually get from one end to the other: an administrator sets the
 * project up, a tester raises a defect and hands it over, a developer builds
 * it and says so, and the tester finds it waiting for them without having gone
 * looking.
 *
 * The three sign in for real, in their own browser contexts, because the point
 * is what each of them sees — and a single session switching roles would prove
 * nothing about what the interface offered the others.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const PASSWORD = "Prio@12345";

/**
 * Signs somebody in to a context of their own and hands back their page.
 *
 * `storageState: undefined` is what makes it their own: the desktop project
 * signs every context in as the administrator, and inheriting that would give
 * all three the same session and prove nothing about what each is offered.
 */
async function pageFor(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await signIn(page, email, PASSWORD);
  return page;
}

async function userId(email: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return user.id;
}

async function teamId(slug: string): Promise<string> {
  const team =
    (await prisma.team.findUnique({ where: { slug }, select: { id: true } })) ??
    (await prisma.team.create({
      data: { slug, name: slug === TESTING_TEAM_SLUG ? "Testing" : "Development" },
      select: { id: true },
    }));
  return team.id;
}

test.describe("Admin → QA → Developer → QA, end to end", () => {
  /* Rows this file creates, removed afterwards so the fixture is left as it
     was found — including the project, which cascades to the issue. */
  const addedTeamRows: string[] = [];
  let projectKey = "";
  let testerId = "";
  let developerId = "";

  test.beforeAll(async () => {
    testerId = await userId(TESTER);
    developerId = await userId(DEVELOPER);

    /* One tester and one developer, stated rather than assumed: the seed puts
       nobody on either team, and the whole workflow turns on which is which. */
    for (const [slug, user] of [
      [TESTING_TEAM_SLUG, testerId],
      [DEVELOPMENT_TEAM_SLUG, developerId],
    ] as const) {
      const team = await teamId(slug);
      const existing = await prisma.teamMember.findFirst({
        where: { teamId: team, userId: user },
        select: { id: true },
      });
      if (existing) continue;
      const row = await prisma.teamMember.create({
        data: { teamId: team, userId: user },
        select: { id: true },
      });
      addedTeamRows.push(row.id);
    }
  });

  test.afterAll(async () => {
    if (projectKey) {
      await prisma.project.deleteMany({ where: { key: projectKey } });
    }
    if (addedTeamRows.length > 0) {
      await prisma.teamMember.deleteMany({ where: { id: { in: addedTeamRows } } });
    }
  });

  test("a defect raised by QA comes back to them, and they close it", async ({
    browser,
  }) => {
    const admin = await pageFor(browser, ADMIN);
    const tester = await pageFor(browser, TESTER);
    const developer = await pageFor(browser, DEVELOPER);

    /* ---------------------------------------------- the administrator sets up */
    projectKey = `RT${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const projectName = `Round trip ${Date.now()}`;

    await admin.goto("/projects");
    await admin.getByRole("button", { name: "New project" }).click();
    const projectDialog = admin.getByRole("dialog");
    await projectDialog.getByLabel("Project name").fill(projectName);
    await projectDialog.getByLabel("Project key").fill(projectKey);
    await projectDialog.getByRole("button", { name: "Create project" }).click();
    await expect(projectDialog).toBeHidden();
    await expect(admin.getByRole("heading", { name: projectName })).toBeVisible();

    /* The tester and the developer are put on it. This is the assignment the
       administrator makes; everything after it is theirs, not the admin's. */
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: projectKey },
      select: { id: true },
    });
    for (const user of [testerId, developerId]) {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: user } },
        update: {},
        create: { projectId: project.id, userId: user },
      });
    }

    /* --------------------------------------------- QA raises it and hands it on */
    const summary = `Login button does nothing ${Date.now()}`;

    await tester.goto("/");
    await tester.locator(".prio-create__main").click();
    const create = tester.getByRole("dialog", { name: /create/i });
    await expect(create).toBeVisible();

    await create.getByLabel("Project").selectOption({ label: `${projectName} (${projectKey})` });
    await create.getByLabel("Summary").fill(summary);

    /* A tester files into the Backlog (the default) or as New — the two
       statuses raising work may use — and says who should fix it in the same
       act. */
    await expect(create.locator("#create-status option")).toHaveText(["Backlog", "New"]);
    await expect(create.locator("#create-status")).toHaveValue("BACKLOG");
    await create.getByLabel("Assignee").selectOption({ label: "Kiran Das" });

    await create
      .getByRole("button", { name: /^create (issue|task|bug|story|epic|feature)$/i })
      .click();
    await expect(create).toBeHidden();
    await expect(tester).toHaveURL(
      new RegExp(`/issues/${projectKey.toLowerCase()}-\\d+`, "i"),
    );

    const issueKey = (tester.url().match(/\/issues\/([a-z0-9]+-\d+)/i) ?? [])[1]!;
    expect(issueKey, "the issue has a key of its own").toBeTruthy();

    const raised = await prisma.issue.findFirstOrThrow({
      where: { key: issueKey.toUpperCase() },
      select: { id: true, reporterId: true, assigneeId: true },
    });
    expect(raised.reporterId, "the tester is the reporter").toBe(testerId);
    expect(raised.assigneeId, "the developer was handed the work").toBe(
      developerId,
    );

    /* ------------------------------------------------- the developer builds it */
    await developer.goto(`/issues/${issueKey.toLowerCase()}`);
    await expect(
      developer.getByRole("heading", { name: summary }),
    ).toBeVisible();

    /** Sets the status from the issue page's own menu. */
    async function setStatus(page: Page, label: string) {
      await page.locator(".prio-fieldtrigger").first().click();
      await page.getByRole("menuitemradio", { name: label, exact: true }).click();
      await expect(page.locator(".prio-fieldtrigger").first()).toContainText(
        label,
      );
    }

    /* A developer is offered the build's statuses, and none of the verdicts. */
    await developer.locator(".prio-fieldtrigger").first().click();
    const developerOptions = await developer
      .getByRole("menuitemradio")
      .allInnerTexts();
    expect(developerOptions.map((text) => text.trim())).toEqual([
      "New",
      "In Progress",
      "Ready for QA",
    ]);
    await developer.keyboard.press("Escape");

    await setStatus(developer, "In Progress");
    await setStatus(developer, "Ready for QA");

    /* ------------------------------------- and it goes back to whoever raised it */
    await expect
      .poll(async () =>
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: raised.id },
            select: { assigneeId: true },
          })
        ).assigneeId,
      )
      .toBe(testerId);

    const afterHandover = await prisma.issue.findUniqueOrThrow({
      where: { id: raised.id },
      select: { status: true, reporterId: true },
    });
    expect(afterHandover.status).toBe("IN_REVIEW");
    expect(afterHandover.reporterId, "who raised it is unchanged").toBe(testerId);

    /*
     * And it reads as Prio's decision, not the developer's.
     *
     * The row records the developer as actor — marking the work ready is
     * what caused the hand-over — but they did not choose the tester, and a
     * sentence saying they did is the misreading the Automatic type exists
     * to prevent. Both surfaces that report it are checked: the item's own
     * trail, and Backlog History's Type column.
     */
    await developer.goto(`/issues/${issueKey.toLowerCase()}`);

    /* Waited for rather than skipped when absent: the tabs have not rendered
       the instant a navigation settles, and a `count()` guard here silently
       leaves Comments showing. Both tabs render the same `<ol>`, so the tab
       reporting itself selected is the signal that the swap happened. */
    const activityTab = developer.getByRole("tab", { name: /^Activity/ });
    await activityTab.waitFor({ timeout: 15_000 });
    await activityTab.click();
    await expect(activityTab).toHaveAttribute("aria-selected", "true");

    /* Older events collapse behind a toggle, and this trail is long by now. */
    const more = developer.locator(".prio-conversation__more");
    if (await more.count()) await more.click();

    await expect(developer.locator(".prio-activity")).toContainText(
      /Prio (assigned it to|passed it from)/,
    );

    await developer.goto("/backlog/history");
    const historyRow = developer
      .locator("tbody tr")
      .filter({ hasText: issueKey.toUpperCase() })
      .first();
    await expect(historyRow).toContainText("Automatic");
    /* The recipient is in "Assigned To" and must not also be the actor. The
       name is read from the database rather than written down here, so this
       cannot pass by comparing against a person who is not in the fixture. */
    const testerName = (
      await prisma.user.findUniqueOrThrow({
        where: { id: testerId },
        select: { name: true },
      })
    ).name;
    /* Cross-project view, so: Work Item, Project, Previous Assignee,
       Assigned To, Type, Assigned By, Date & Time. */
    await expect(historyRow.locator("td").nth(3)).toContainText(testerName);
    await expect(historyRow.locator("td").nth(5)).not.toContainText(testerName);

    /* The tester is told, by name, and it is in their own work. */
    await tester.goto("/notifications");
    await expect(
      tester.getByText(issueKey.toUpperCase(), { exact: false }).first(),
    ).toBeVisible();

    await tester.goto("/my-work");
    await expect(
      tester.getByRole("link", { name: new RegExp(issueKey, "i") }).first(),
    ).toBeVisible();

    /* ------------------------------------------------ QA checks it and closes it */
    await tester.goto(`/issues/${issueKey.toLowerCase()}`);

    /** What the tester's own status menu is offering right now. */
    async function testerOptions(): Promise<string[]> {
      await tester.locator(".prio-fieldtrigger").first().click();
      const items = await tester.getByRole("menuitemradio").allInnerTexts();
      await tester.keyboard.press("Escape");
      return items.map((text) => text.trim());
    }

    /*
     * The tester's half of the job, and none of the developer's. Done is not
     * among them yet: it is what testing concluded, so it follows In QA and
     * cannot be reached from the hand-over itself.
     */
    expect(await testerOptions()).toEqual([
      "Backlog",
      "In QA",
      "Reopen",
      "Reject / Not an Issue",
      "Cancelled",
    ]);

    await setStatus(tester, "In QA");

    // And once it is being tested, the verdict is available — all six.
    expect(await testerOptions()).toEqual([
      "Backlog",
      "In QA",
      "Done",
      "Reopen",
      "Reject / Not an Issue",
      "Cancelled",
    ]);

    await setStatus(tester, "Done");

    /* Written, not merely shown: it is still Done after a reload, and the row
       carries the date that makes it completed work. */
    await tester.reload();
    await expect(tester.locator(".prio-fieldtrigger").first()).toContainText(
      "Done",
    );

    const closed = await prisma.issue.findUniqueOrThrow({
      where: { id: raised.id },
      select: { status: true, completedAt: true, reporterId: true, assigneeId: true },
    });
    expect(closed.status).toBe("DONE");
    expect(closed.completedAt).not.toBeNull();

    /* ------------------------------------------------------------ traceability */
    expect(closed.reporterId, "QA raised it").toBe(testerId);
    expect(closed.assigneeId, "QA closed it").toBe(testerId);

    const history = await prisma.activityLogEntry.findMany({
      where: { issueId: raised.id },
      select: { field: true, oldValue: true, newValue: true, actorId: true },
      orderBy: { createdAt: "asc" },
    });

    expect(
      history
        .filter((row) => row.field === "status")
        .map((row) => row.newValue),
    ).toEqual(["IN_PROGRESS", "IN_REVIEW", "IN_QA", "DONE"]);

    const handover = history.find(
      (row) => row.field === "assigneeId" && row.newValue === testerId,
    );
    expect(handover, "the return to QA is on the record").toBeTruthy();
    expect(handover!.oldValue, "it came from the developer").toBe(developerId);
    expect(handover!.actorId, "and the developer did it").toBe(developerId);

    /* The activity the person reading the issue actually sees. */
    await expect(tester.locator(".prio-activity, .prio-issue__section")).not.toHaveCount(
      0,
    );

    /* ----------------------------------------- the administrator still sees it all */
    await admin.goto(`/issues/${issueKey.toLowerCase()}`);
    await expect(admin.getByRole("heading", { name: summary })).toBeVisible();
    await admin.locator(".prio-fieldtrigger").first().click();
    const adminOptions = await admin.getByRole("menuitemradio").allInnerTexts();
    expect(
      adminOptions.length,
      "an administrator keeps every status",
    ).toBe(9);
    await admin.keyboard.press("Escape");

    await admin.close();
    await tester.close();
    await developer.close();
  });
});
