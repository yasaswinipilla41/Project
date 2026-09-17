import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ISSUE_LIMIT_REACHED } from "@/lib/domain";
import { ADMIN_STATE } from "./support";

/**
 * The popup a person actually sees when a project is full.
 *
 * The rule itself is asserted against the server in
 * `tests/project-issue-limit.test.ts`; this is the other half — that the
 * refusal reaches the screen, in those words, through the create dialog.
 *
 * The fixture project is made here and removed afterwards, so the projects the
 * installation already has are neither counted nor touched.
 */

test.describe("A project at its issue limit", () => {
  test.use({ storageState: ADMIN_STATE });

  let projectId = "";
  let projectKey = "";

  test.beforeAll(async () => {
    projectKey = `FUL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    });

    /* One issue, and a limit of one, so the project is full on arrival. The
       sequence is moved with it so the next key does not collide. */
    const project = await prisma.project.create({
      data: {
        name: `Full ${Date.now()}`,
        key: projectKey,
        description: "Fixture for the issue-limit popup.",
        createdById: admin.id,
        maxIssues: 1,
        issueSequence: 1,
        members: { create: { userId: admin.id } },
        issues: {
          create: {
            key: `${projectKey}-1`,
            number: 1,
            type: "TASK",
            title: "The only issue this project may hold",
            status: "TODO",
            priority: "MEDIUM",
            reporterId: admin.id,
          },
        },
      },
      select: { id: true },
    });
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (projectId) {
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
  });

  test("says so, in the exact words, and files nothing", async ({ page }) => {
    await page.goto(`/projects/${projectKey.toLowerCase()}`);

    // The project's own create control, so the project needs no choosing.
    await page.locator(".prio-create__main").first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog
      .getByLabel(/summary|title/i)
      .first()
      .fill("One more than allowed");

    await dialog
      .getByRole("button", { name: /^(Create|Create issue|Create task)/i })
      .first()
      .click();

    /* The popup, word for word. Both the toast and the dialog's own alert
       carry it, so this asserts the text is on the page rather than which of
       the two the eye lands on first. */
    await expect(page.getByText(ISSUE_LIMIT_REACHED).first()).toBeVisible();
    await expect(
      page
        .getByText("You have reached the maximum number of issues you can create")
        .first(),
    ).toBeVisible();

    // And the refusal was real: the project still holds exactly its one issue.
    expect(await prisma.issue.count({ where: { projectId } })).toBe(1);
  });
});
