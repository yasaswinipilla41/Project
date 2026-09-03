import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { watchForProblems } from "./support";

/**
 * Cloning, parenthood and related links, through the interface.
 *
 * The database-level copy matrix is covered by `tests/clone.test.ts`, which can
 * read storage keys and link rows directly. What is pinned here is what a
 * person actually does and sees: the two checkboxes, the draft that has no
 * ticket ID, the key that appears only after Save, and the fact that cancelling
 * at either step leaves nothing behind.
 */

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const madeIssues: string[] = [];
const madeProjects: string[] = [];

test.afterAll(async () => {
  if (madeProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: madeProjects } } });
  }
  if (madeIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: madeIssues } } });
  }
});

/** A fresh ENG issue, created directly so the test never edits a seeded one. */
async function fixture(
  title: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; key: string; title: string }> {
  const reporter = await prisma.user.findFirstOrThrow({
    where: { email: "admin@symbiosystech.com" },
    select: { id: true },
  });

  const issue = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { key: "ENG" },
      data: { issueSequence: { increment: 1 } },
      select: { id: true, key: true, issueSequence: true },
    });
    return tx.issue.create({
      data: {
        key: `${project.key}-${project.issueSequence}`,
        number: project.issueSequence,
        projectId: project.id,
        type: "TASK",
        title,
        reporterId: reporter.id,
        ...overrides,
      },
      select: { id: true, key: true, title: true },
    });
  });

  madeIssues.push(issue.id);
  return issue;
}

async function engCount(): Promise<number> {
  return prisma.issue.count({ where: { project: { key: "ENG" } } });
}

async function openClone(page: Page, issueKey: string) {
  await page.goto(`/issues/${issueKey.toLowerCase()}`);
  await page.getByRole("button", { name: "Clone", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Cloning an issue", () => {
  test("offers exactly the two copy choices, both off", async ({ page }) => {
    const source = await fixture(`Clone options ${stamp()}`);
    const dialog = await openClone(page, source.key);

    const links = dialog.getByLabel("Do you want to copy the links?");
    const files = dialog.getByLabel("Do you want to copy the attachments?");

    await expect(links).toBeVisible();
    await expect(files).toBeVisible();
    await expect(links).not.toBeChecked();
    await expect(files).not.toBeChecked();

    // Two questions and no more — the dialog does not grow extra options.
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Clone" })).toBeVisible();

    // Cancelling at this step writes nothing either.
    const before = await engCount();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(await engCount()).toBe(before);
  });

  test("the draft has no ticket ID, and cancelling it writes nothing", async ({
    page,
  }) => {
    const source = await fixture(`Clone draft ${stamp()}`);
    const before = await engCount();

    const dialog = await openClone(page, source.key);
    await dialog.getByRole("button", { name: "Clone" }).click();

    /*
     * §8, as the person sees it. The draft is open and editable, and where a
     * ticket ID would be it says so plainly rather than showing a number that
     * somebody might quote before it exists.
     */
    await expect(dialog.locator(".prio-clonedraft__label")).toHaveText(
      "Ticket ID",
    );
    await expect(dialog.getByText("Not assigned yet")).toBeVisible();
    await expect(dialog.getByLabel("Summary")).toHaveValue(/^Clone of /);
    await expect(dialog.locator(".prio-clonedraft")).not.toContainText(/ENG-\d+$/);

    // Editable before it is real.
    await dialog.getByLabel("Summary").fill(`Edited draft ${stamp()}`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // Nothing was created, and no key was consumed.
    expect(await engCount()).toBe(before);
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: "ENG" },
      select: { issueSequence: true },
    });
    const highest = await prisma.issue.findFirstOrThrow({
      where: { project: { key: "ENG" } },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    expect(project.issueSequence).toBe(highest.number);
  });

  test("Save creates a new issue with its own key, leaving the original alone", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const originalTitle = `Clone source ${stamp()}`;
    const source = await fixture(originalTitle, {
      description: "The original text.",
      priority: "HIGH",
    });
    const cloneTitle = `Saved clone ${stamp()}`;

    const dialog = await openClone(page, source.key);
    await dialog.getByRole("button", { name: "Clone" }).click();
    await dialog.getByLabel("Summary").fill(cloneTitle);
    await dialog.getByRole("button", { name: "Save" }).click();

    /* The clone opens on its own page. Waited for by *leaving* the source's
       URL rather than by matching `/issues/eng-N`, which the page already
       satisfies -- that pattern would pass before the save had even run. */
    await expect(page).not.toHaveURL(
      new RegExp(`/issues/${source.key.toLowerCase()}$`),
      { timeout: 30_000 },
    );
    await expect(page).toHaveURL(/\/issues\/eng-\d+$/);
    const cloneKey = new URL(page.url()).pathname.split("/").pop()!.toUpperCase();
    expect(cloneKey).not.toBe(source.key);

    const clone = await prisma.issue.findUniqueOrThrow({
      where: { key: cloneKey },
      select: { id: true, title: true, description: true, priority: true },
    });
    madeIssues.push(clone.id);
    expect(clone.title).toBe(cloneTitle);
    expect(clone.description).toBe("The original text.");
    expect(clone.priority).toBe("HIGH");

    // The original still says exactly what it said.
    await page.goto(`/issues/${source.key.toLowerCase()}`);
    await expect(page.locator("h1.prio-issue__title")).toHaveText(originalTitle);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("is offered from the issues table too", async ({ page }) => {
    await page.goto("/issues");
    const row = page.locator(".prio-table tbody tr").first();
    await row.locator("button[aria-label^='Actions for']").click();
    await expect(page.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("The issue page is one shape for every type", () => {
  test("a bug and a task show the same sections", async ({ page }) => {
    const task = await fixture(`Shape task ${stamp()}`, { type: "TASK" });
    const bug = await fixture(`Shape bug ${stamp()}`, {
      type: "BUG",
      severity: "MAJOR",
    });

    const sectionsOf = async (key: string) => {
      await page.goto(`/issues/${key.toLowerCase()}`);
      await expect(page.locator("h1.prio-issue__title")).toBeVisible();
      return page
        .locator(".prio-issue__section-title")
        .evaluateAll((els) =>
          els.map((el) => (el.textContent ?? "").split("Comments can be")[0]!.trim()),
        );
    };

    expect(await sectionsOf(bug.key)).toEqual(await sectionsOf(task.key));

    // Description is one of them, and severity is editable on both: status,
    // priority, severity and assignee are four live controls either way.
    for (const key of [task.key, bug.key]) {
      await page.goto(`/issues/${key.toLowerCase()}`);
      await expect(
        page.getByRole("heading", { name: "Description" }),
      ).toBeVisible();
      await expect(
        page.locator(".prio-issue__headmeta .prio-fieldtrigger"),
      ).toHaveCount(4);
    }
    await expect(page.locator(".prio-issue__headmeta")).toContainText("Major");

    // No bug-only environment block survives on the bug.
    await page.goto(`/issues/${bug.key.toLowerCase()}`);
    await expect(
      page.getByRole("heading", { name: "Environment" }),
    ).toHaveCount(0);
  });
});

test.describe("Parent and related links", () => {
  test("the parent is an issue, is saved, and survives a refresh", async ({
    page,
  }) => {
    const parent = await fixture(`Parent story ${stamp()}`, { type: "STORY" });
    const child = await fixture(`Child task ${stamp()}`);

    await page.goto(`/issues/${child.key.toLowerCase()}`);
    await page.getByRole("button", { name: "Edit parent issue" }).click();

    const search = page.getByLabel("Parent issue");
    const option = `${parent.key} — ${parent.title}`;

    // The candidate list is fetched from the server as the search narrows.
    await search.fill(parent.key);
    await expect
      .poll(
        async () =>
          page
            .locator("#issue-parent-options option")
            .evaluateAll((els) => els.map((el) => el.getAttribute("value") ?? "")),
        { timeout: 15_000 },
      )
      .toContain(option);

    /* Selecting from a datalist puts the option's own value in the box, which
       is what the control treats as a choice. */
    await search.fill(option);
    await page.getByRole("button", { name: "Save" }).click();

    // Persisted, and it is the issue — not the project.
    await expect
      .poll(
        async () =>
          (
            await prisma.issue.findUniqueOrThrow({
              where: { id: child.id },
              select: { parentId: true },
            })
          ).parentId,
        { timeout: 15_000 },
      )
      .toBe(parent.id);

    // Survives a reload, and reads as a link to the parent issue's key.
    await page.reload();
    const details = page.locator(".prio-issue__aside");
    await expect(details).toContainText(parent.key);
    await expect(details).toContainText("Engineering");
    await expect(
      details.getByRole("link", { name: new RegExp(parent.key) }),
    ).toHaveAttribute("href", `/issues/${parent.key.toLowerCase()}`);

    // And the parent lists the child.
    await page.goto(`/issues/${parent.key.toLowerCase()}`);
    await expect(page.getByRole("heading", { name: "Sub-issues" })).toBeVisible();
    await expect(page.locator(".prio-relatedrow")).toContainText(child.key);
  });

  test("holds several related issues, and refuses a duplicate or a self-link", async ({
    page,
  }) => {
    const hub = await fixture(`Link hub ${stamp()}`);
    const targets = [];
    for (let n = 0; n < 4; n += 1) {
      targets.push(await fixture(`Link target ${n} ${stamp()}`));
    }

    for (const target of targets) {
      await page.goto(`/issues/${hub.key.toLowerCase()}`);
      await page.getByRole("button", { name: "Link issue" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Which issue?").fill(target.key);
      const option = dialog.locator(".prio-linkresults__item").filter({ hasText: target.key });
      await option.first().click();
      await dialog.getByRole("button", { name: "Link issue" }).click();
      await expect(dialog).toBeHidden();
    }

    // Four links, no cap and no truncation.
    await page.goto(`/issues/${hub.key.toLowerCase()}`);
    for (const target of targets) {
      await expect(page.locator(".prio-related")).toContainText(target.key);
    }
    expect(
      await prisma.issueLink.count({ where: { sourceId: hub.id } }),
    ).toBe(4);

    // The same link a second time is refused, not silently duplicated.
    await page.getByRole("button", { name: "Link issue" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Which issue?").fill(targets[0]!.key);
    await dialog
      .locator(".prio-linkresults__item").filter({ hasText: targets[0]!.key })
      .first()
      .click();
    await dialog.getByRole("button", { name: "Link issue" }).click();
    await expect(dialog.getByRole("alert")).toContainText("already");
    expect(
      await prisma.issueLink.count({ where: { sourceId: hub.id } }),
    ).toBe(4);

    // An issue cannot be offered itself as a link target.
    await dialog.getByLabel("Which issue?").fill(hub.key);
    await expect
      .poll(
        async () =>
          dialog.locator(".prio-linkresults__item").filter({ hasText: hub.key }).count(),
        { timeout: 10_000 },
      )
      .toBe(0);
  });
});

test.describe("Cloning a project", () => {
  test("asks the same two questions and copies what was ticked", async ({
    page,
  }) => {
    /* Website is the smallest seeded project, so this exercises the whole copy
       without duplicating a few hundred issues to prove a point. */
    const source = await prisma.project.findUniqueOrThrow({
      where: { key: "WEB" },
      select: {
        id: true,
        name: true,
        _count: { select: { issues: true } },
      },
    });

    await page.goto("/projects/web/board");
    await page.getByRole("button", { name: "More board actions" }).click();
    await page.getByRole("menuitem", { name: "Clone project" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    /* Still exactly two questions — but for a *project* they start ticked.
       Duplicating a project is expected to produce a complete copy, so links
       and files travel unless somebody says otherwise; the issue clone above
       keeps its own unticked defaults, because duplicating one issue is
       usually the start of a new one rather than a faithful copy. */
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(
      dialog.getByLabel("Do you want to copy the links?"),
    ).toBeChecked();
    await expect(
      dialog.getByLabel("Do you want to copy the attachments?"),
    ).toBeChecked();

    await dialog.getByRole("button", { name: "Clone" }).click();

    /* Lands on the clone's own board. Waited for by leaving Website's board,
       since the generic board pattern already matches where we are. */
    await expect(page).not.toHaveURL(/\/projects\/web\/board$/, {
      timeout: 90_000,
    });
    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+\/board$/);
    const cloneKey = page.url().split("/projects/")[1]!.split("/")[0]!.toUpperCase();
    expect(cloneKey).not.toBe("WEB");

    const clone = await prisma.project.findUniqueOrThrow({
      where: { key: cloneKey },
      select: { id: true, name: true, _count: { select: { issues: true } } },
    });
    madeProjects.push(clone.id);

    expect(clone.name).toBe(`${source.name} (Copy)`);
    expect(clone._count.issues).toBe(source._count.issues);

    // The original is exactly as it was.
    const after = await prisma.project.findUniqueOrThrow({
      where: { key: "WEB" },
      select: { name: true, _count: { select: { issues: true } } },
    });
    expect(after.name).toBe(source.name);
    expect(after._count.issues).toBe(source._count.issues);
  });
});
