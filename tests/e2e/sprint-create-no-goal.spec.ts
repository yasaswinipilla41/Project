import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Sprint goal is asked for when editing a sprint, not while creating one.
 *
 * A goal is something a team settles on once a sprint exists, not a question
 * that should hold up starting one — so the create form leaves it out, and
 * everything downstream of `goal` is otherwise untouched: the field, the
 * schema and the server action all still exist, a sprint that already has a
 * goal keeps it, and setting one is one Edit sprint away.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

function dateValue(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** A project of this spec's own — never the shared "eng" fixture other
 *  specs rely on, since this file's cleanup deletes whatever project it
 *  creates a sprint in. */
async function makeIsolatedProject(): Promise<{ key: string; adminId: string }> {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `NG${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `No-goal fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);
  return { key: project.key.toLowerCase(), adminId: admin.id };
}

test.describe("Create sprint", () => {
  test("does not ask for a goal, and creates the sprint without one", async ({
    page,
  }) => {
    const { key } = await makeIsolatedProject();
    await page.goto(`/projects/${key}/sprints`);
    await page.getByRole("button", { name: "New sprint" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "New sprint" })).toBeVisible();

    /* The field itself, and its label, are both absent — not merely empty or
       disabled. */
    await expect(dialog.getByLabel("Sprint goal")).toHaveCount(0);
    await expect(dialog.getByText("Sprint goal")).toHaveCount(0);

    /* Every other field the create form has always asked for is still
       there and still works. */
    const name = `E2E no-goal create ${Date.now()}`;
    await dialog.getByLabel("Sprint name").fill(name);
    await dialog.getByLabel("Start date").fill(dateValue(0));
    await dialog.getByLabel("End date").fill(dateValue(13));
    await dialog.getByRole("button", { name: "Create sprint" }).click();
    await expect(dialog).toBeHidden();

    const row = await prisma.sprint.findFirstOrThrow({
      where: { name },
      select: { id: true, goal: true, projectId: true },
    });

    /* The field being hidden left the sprint with no goal at all — not an
       empty string standing in for one. */
    expect(row.goal).toBeNull();

    /* And the card for it shows no goal line, the same as any other sprint
       that has none. */
    const card = page.locator(".prio-sprint").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card.locator(".prio-sprint__goal")).toHaveCount(0);
  });
});

test.describe("Edit sprint", () => {
  test("still asks for a goal, and setting one shows it on the card", async ({
    page,
  }) => {
    const { key, adminId } = await makeIsolatedProject();
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: key.toUpperCase() },
      select: { id: true },
    });

    const sprint = await prisma.sprint.create({
      data: {
        name: `E2E edit-goal ${Date.now()}`,
        startDate: new Date(),
        endDate: new Date(Date.now() + 13 * 86_400_000),
        projectId: project.id,
        createdById: adminId,
      },
      select: { id: true, name: true },
    });

    await page.goto(`/projects/${key}/sprints`);
    const card = page.locator(".prio-sprint").filter({ hasText: sprint.name });
    await expect(card).toBeVisible();
    /* Created with no goal, so none shows yet. */
    await expect(card.locator(".prio-sprint__goal")).toHaveCount(0);

    await card.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit sprint" })).toBeVisible();

    /* Offered here, unlike on the create form. */
    const goal = dialog.getByLabel("Sprint goal");
    await expect(goal).toBeVisible();
    await goal.fill("Ship the export button");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    await expect(card.locator(".prio-sprint__goal")).toHaveText(
      "Ship the export button",
    );

    /* And it is what the database actually holds, not only what the page
       says right after saving it. */
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: sprint.id },
        select: { goal: true },
      }),
    ).toMatchObject({ goal: "Ship the export button" });
  });
});
