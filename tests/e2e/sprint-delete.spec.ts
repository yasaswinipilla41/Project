import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE, MEMBER_STATE } from "./support";

/**
 * Deleting a sprint, through the interface.
 *
 * The rule — administrators only, and the issues survive — is asserted against
 * the server in `tests/sprint-delete.test.ts`. What this walks is the part a
 * person does: the action is there, it asks before it acts, Cancel really does
 * nothing, and after confirming the sprint is gone from the page and stays
 * gone when the page is loaded again.
 */

const SPRINT_PREFIX = "E2E delete me";

/** A planned sprint in ENG, made directly so the test starts where it means to. */
async function aSprint(name: string): Promise<{ id: string; name: string }> {
  const [project, admin] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { key: "ENG" },
      select: { id: true },
    }),
    prisma.user.findFirstOrThrow({
      where: { role: "ADMIN", isActive: true },
      select: { id: true },
    }),
  ]);

  const start = new Date();
  const end = new Date(start.getTime() + 7 * 86_400_000);

  const sprint = await prisma.sprint.create({
    data: {
      projectId: project.id,
      name: `${SPRINT_PREFIX} ${name} ${Date.now()}`,
      goal: "fixture",
      startDate: start,
      endDate: end,
      createdById: admin.id,
    },
    select: { id: true, name: true },
  });
  return sprint;
}

test.afterAll(async () => {
  await prisma.sprint.deleteMany({
    where: { name: { startsWith: SPRINT_PREFIX } },
  });
});

test.describe("An administrator", () => {
  test.use({ storageState: ADMIN_STATE });

  test("is offered Delete sprint, and Cancel leaves it alone", async ({
    page,
  }) => {
    const sprint = await aSprint("cancel");
    await page.goto("/projects/eng/sprints");

    const card = page
      .locator(".prio-issue__section, section")
      .filter({ hasText: sprint.name })
      .first();
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Delete sprint" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Delete sprint?");
    // It says what it will and will not touch.
    await expect(dialog).toContainText(sprint.name);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    expect(
      await prisma.sprint.count({ where: { id: sprint.id } }),
      "Cancel changes nothing",
    ).toBe(1);
    await expect(page.getByText(sprint.name)).toBeVisible();
  });

  test("deletes it, and it is gone after a reload", async ({ page }) => {
    const sprint = await aSprint("confirm");
    await page.goto("/projects/eng/sprints");

    const card = page
      .locator(".prio-issue__section, section")
      .filter({ hasText: sprint.name })
      .first();
    await card.getByRole("button", { name: "Delete sprint" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete sprint" }).click();

    // Gone from the page…
    await expect(page.getByText(sprint.name)).toHaveCount(0, { timeout: 15_000 });

    // …and from the database, which is what makes the reload below meaningful.
    await expect
      .poll(async () => prisma.sprint.count({ where: { id: sprint.id } }), {
        timeout: 10_000,
      })
      .toBe(0);

    await page.reload();
    await expect(page.getByText(sprint.name)).toHaveCount(0);
  });

  test("leaves the work that was in it alone", async ({ page }) => {
    const sprint = await aSprint("with work");

    const issue = await prisma.issue.findFirstOrThrow({
      where: { project: { key: "ENG" }, sprintId: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, key: true, status: true, assigneeId: true },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { sprintId: sprint.id },
    });

    await page.goto("/projects/eng/sprints");
    const card = page
      .locator(".prio-issue__section, section")
      .filter({ hasText: sprint.name })
      .first();
    await card.getByRole("button", { name: "Delete sprint" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete sprint" })
      .click();

    await expect
      .poll(async () => prisma.sprint.count({ where: { id: sprint.id } }), {
        timeout: 15_000,
      })
      .toBe(0);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { status: true, assigneeId: true, sprintId: true },
    });
    expect(after.status).toBe(issue.status);
    expect(after.assigneeId).toBe(issue.assigneeId);
    expect(after.sprintId, "out of the sprint, not deleted with it").toBeNull();

    // The issue itself still opens.
    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await expect(page.locator("h1.prio-issue__title")).toBeVisible();
  });
});

test.describe("A member", () => {
  test.use({ storageState: MEMBER_STATE });

  test("is not offered Delete sprint, and the sprint outlives the visit", async ({
    page,
  }) => {
    const sprint = await aSprint("not theirs");

    /* Sprints are a developer's to read. A tester is sent away from the route
       entirely, which is its own rule and covered elsewhere; this member is on
       no team, so they see the page and simply have no destructive action on
       it. */
    await page.goto("/projects/eng/sprints");
    await expect(page.getByRole("button", { name: "Delete sprint" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Add sprint" })).toHaveCount(0);

    expect(await prisma.sprint.count({ where: { id: sprint.id } })).toBe(1);
  });
});
