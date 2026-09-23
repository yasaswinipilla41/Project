import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { SPRINT_STATUS_LABEL } from "@/lib/domain";
import { ADMIN_STATE, MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * What a sprint's own page lets you do to the sprint.
 *
 * The four actions in its header are the same four the sprint's block on the
 * Sprints page offers, and they are the same implementations — so what is
 * worth testing here is that each one works *from this page* and that the
 * header offers exactly what the reader's role allows: Add issues and Edit
 * for every working role, Start sprint and Delete for an administrator.
 *
 * Deleting is the one that behaves differently here, and has to: it destroys
 * the page it was started from, so it has to leave for the list.
 *
 * A project of its own, because starting a sprint is only possible where no
 * other sprint is already running.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/** A project with one planned sprint, one issue in it, and one in the backlog. */
async function seedSprintWithBacklog() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true },
  });
  const key = `HA${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Header actions fixture ${key}`,
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E header actions ${Date.now()}`,
      goal: "Something to edit",
      startDate: new Date(),
      endDate: new Date(Date.now() + 13 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
    },
    select: { id: true, name: true },
  });

  const [inSprint, inBacklog] = await Promise.all([
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-1`,
        number: 1,
        title: "Already in the sprint",
        type: "TASK",
        status: "TODO",
        reporterId: admin.id,
        sprintId: sprint.id,
      },
      select: { id: true, key: true },
    }),
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-2`,
        number: 2,
        title: "Waiting in the backlog",
        type: "TASK",
        status: "TODO",
        reporterId: admin.id,
      },
      select: { id: true, key: true },
    }),
  ]);

  return { key: project.key.toLowerCase(), sprint, inSprint, inBacklog };
}

/** The action row in the sprint's own header. */
function header(page: Page) {
  return page.locator(".prio-sprint__head .prio-sprint__actions");
}

test.describe("A sprint's header actions, as an administrator", () => {
  test.use({ storageState: ADMIN_STATE });

  test("adds issues, edits, starts and deletes the sprint from its own page", async ({
    page,
  }) => {
    const { key, sprint, inBacklog } = await seedSprintWithBacklog();
    const detail = `/projects/${key}/sprints/${sprint.id}`;

    await page.goto(detail);
    await expect(header(page)).toBeVisible({ timeout: 45_000 });

    /* All four, and nothing overlapping the sprint's own information. */
    await expect(header(page).getByRole("button", { name: "Add issues" })).toBeVisible();
    await expect(header(page).getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(header(page).getByRole("button", { name: "Start sprint" })).toBeVisible();
    await expect(
      header(page).getByRole("button", { name: "Delete sprint" }),
    ).toBeVisible();

    // ----------------------------------------------------------- Add issues
    await header(page).getByRole("button", { name: "Add issues" }).click();
    const picker = page.getByRole("dialog");
    await expect(picker).toBeVisible();
    await picker
      .locator(".prio-sprintpicker__row", { hasText: inBacklog.key })
      .getByRole("checkbox")
      .check();
    await picker.getByRole("button", { name: /Add \d+ to sprint/ }).click();
    await expect(picker).toBeHidden();

    /* The sprint now holds both, and the figures the page counts followed. */
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 2",
      { timeout: 15_000 },
    );
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: inBacklog.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: sprint.id });

    // ----------------------------------------------------------------- Edit
    const renamed = `${sprint.name} renamed`;
    await header(page).getByRole("button", { name: "Edit" }).click();
    const form = page.getByRole("dialog");
    await expect(form).toBeVisible();
    await form.getByLabel("Sprint name").fill(renamed);
    await form.getByRole("button", { name: /Save|Update/ }).click();
    await expect(form).toBeHidden();
    await expect(page.locator(".prio-sprint__name")).toContainText(renamed, {
      timeout: 15_000,
    });

    // --------------------------------------------------------- Start sprint
    await header(page).getByRole("button", { name: "Start sprint" }).click();
    /* The label the application itself gives a running sprint, read from the
       one table that decides it rather than written out here. */
    await expect(page.locator(".prio-sprint__status")).toHaveText(
      SPRINT_STATUS_LABEL.ACTIVE,
      { timeout: 15_000 },
    );
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: sprint.id },
        select: { status: true },
      }),
    ).toMatchObject({ status: "ACTIVE" });
    /* A running sprint cannot be started again, so the button goes. */
    await expect(
      header(page).getByRole("button", { name: "Start sprint" }),
    ).toHaveCount(0);

    // --------------------------------------------------------------- Delete
    await header(page).getByRole("button", { name: "Delete sprint" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete sprint" }).click();

    /* The page was the sprint, so it leaves for the list it came from — and
       the sprint is really gone, while its issues are not. */
    await expect(page).toHaveURL(new RegExp(`${key}/sprints$`), {
      timeout: 20_000,
    });
    expect(
      await prisma.sprint.findUnique({ where: { id: sprint.id } }),
    ).toBeNull();
    expect(
      await prisma.issue.count({ where: { key: inBacklog.key } }),
    ).toBe(1);
  });
});

test.describe("A sprint's header actions, as a member of the project", () => {
  test.use({ storageState: MEMBER_STATE });

  test("offers filling and editing the sprint, but not starting or deleting it", async ({
    page,
  }) => {
    const { key, sprint } = await seedSprintWithBacklog();

    await page.goto(`/projects/${key}/sprints/${sprint.id}`);
    await expect(header(page)).toBeVisible({ timeout: 45_000 });

    /* Filling a sprint and correcting its details are every working role's;
       the lifecycle and the delete are an administrator's, and the server
       refuses them regardless of what is drawn. */
    await expect(header(page).getByRole("button", { name: "Add issues" })).toBeVisible();
    await expect(header(page).getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(
      header(page).getByRole("button", { name: "Start sprint" }),
    ).toHaveCount(0);
    await expect(
      header(page).getByRole("button", { name: "Delete sprint" }),
    ).toHaveCount(0);
  });
});
