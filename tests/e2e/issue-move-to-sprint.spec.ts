import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * Move to sprint, on an issue's own Details panel.
 *
 * The server rules — who may move, which sprints are eligible, what happens to
 * a stale destination — are asserted directly against the actions in
 * `tests/sprint-eligibility.test.ts`. This file asserts the part a unit test
 * cannot see: that the control on the page reflects those rules, that it shows
 * a loading state rather than an empty one while it is asking, that an empty
 * answer and a failed one are different sentences, and that a move made here
 * actually lands and shows up on the destination sprint.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.projectMember.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

function dates(offsetDays: number) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return { startDate: start, endDate: end };
}

/**
 * A project with one active sprint, one planned sprint, one completed sprint,
 * and an issue in the backlog — plus a second project with its own sprint, so
 * "only this project's sprints are offered" can be seen rather than assumed.
 */
async function seedProject({ withSprints = true }: { withSprints?: boolean } = {}) {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true },
  });

  const stamp = Date.now().toString(36).toUpperCase();
  const project = await prisma.project.create({
    data: {
      key: `MTS${stamp}`.slice(0, 10),
      name: `Move to sprint fixture ${stamp}`,
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprints = withSprints
    ? {
        active: await prisma.sprint.create({
          data: {
            projectId: project.id,
            createdById: admin.id,
            name: `E2E active ${stamp}`,
            status: "ACTIVE",
            startedAt: new Date(),
            ...dates(0),
          },
          select: { id: true, name: true },
        }),
        planned: await prisma.sprint.create({
          data: {
            projectId: project.id,
            createdById: admin.id,
            name: `E2E planned ${stamp}`,
            ...dates(14),
          },
          select: { id: true, name: true },
        }),
        completed: await prisma.sprint.create({
          data: {
            projectId: project.id,
            createdById: admin.id,
            name: `E2E completed ${stamp}`,
            status: "COMPLETED",
            completedAt: new Date(),
            ...dates(-28),
          },
          select: { id: true, name: true },
        }),
      }
    : null;

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Work that needs a sprint",
      type: "TASK",
      status: "BACKLOG",
      reporterId: admin.id,
    },
    select: { id: true, key: true },
  });

  return { project, sprints, issue, stamp };
}

/** A sprint in a project neither the admin's fixture nor its members own. */
async function seedForeignSprint(stamp: string) {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      key: `FGN${stamp}`.slice(0, 10),
      name: `Another team ${stamp}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  createdProjects.push(project.id);

  return prisma.sprint.create({
    data: {
      projectId: project.id,
      createdById: admin.id,
      name: `E2E elsewhere ${stamp}`,
      status: "ACTIVE",
      startedAt: new Date(),
      ...dates(0),
    },
    select: { id: true, name: true },
  });
}

/** The Details panel's Sprint row. */
function sprintRow(page: Page) {
  return page
    .locator(".prio-meta-row")
    .filter({ has: page.locator(".prio-meta-row__label", { hasText: "Sprint" }) });
}

test.describe("The issue Details panel's Sprint row", () => {
  test("states the sprint, offers every eligible one, and moves the issue", async ({
    page,
  }) => {
    const { sprints, issue, stamp } = await seedProject();
    const foreign = await seedForeignSprint(stamp);
    if (!sprints) throw new Error("fixture");

    await page.goto(`/issues/${issue.key.toLowerCase()}`);

    // An issue in the backlog is in no sprint, and the row says so.
    const row = sprintRow(page);
    await expect(row).toBeVisible();
    await expect(row).toContainText("No sprint");

    const trigger = row.getByRole("button", {
      name: new RegExp(`Move ${issue.key} to a sprint`, "i"),
    });
    await trigger.click();

    const menu = page.getByRole("menu", {
      name: new RegExp(`Move ${issue.key} to a sprint`, "i"),
    });
    await expect(menu).toBeVisible();

    /*
     * Both of this project's open sprints, and neither the completed one nor
     * another project's — which the administrator can open, so this is
     * eligibility rather than visibility.
     */
    await expect(
      menu.getByRole("menuitemradio", { name: new RegExp(sprints.active.name) }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitemradio", { name: new RegExp(sprints.planned.name) }),
    ).toBeVisible();
    await expect(menu.getByText(sprints.completed.name)).toHaveCount(0);
    await expect(menu.getByText(foreign.name)).toHaveCount(0);

    // Nowhere to remove it from yet, so no Backlog entry is offered.
    await expect(
      menu.getByRole("menuitem", { name: /Remove from sprint/i }),
    ).toHaveCount(0);

    await menu
      .getByRole("menuitemradio", { name: new RegExp(sprints.planned.name) })
      .click();

    // The row follows the server's answer, not the click.
    await expect(sprintRow(page)).toContainText(sprints.planned.name);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: sprints.planned.id });

    /* And the issue is in the destination sprint, which is the point of the
       move — read on the sprint's own page rather than inferred. */
    const key = (await projectKeyOf(issue.id)).toLowerCase();
    await page.goto(`/projects/${key}/sprints/${sprints.planned.id}`);
    await expect(
      page.getByRole("heading", { name: "Issues in this sprint" }),
    ).toBeVisible();
    await expect(page.getByText(issue.key).first()).toBeVisible();
  });

  test("changes an issue's sprint, and takes it back out to the backlog", async ({
    page,
  }) => {
    const { sprints, issue } = await seedProject();
    if (!sprints) throw new Error("fixture");

    await prisma.issue.update({
      where: { id: issue.id },
      data: { sprintId: sprints.active.id },
    });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await expect(sprintRow(page)).toContainText(sprints.active.name);

    // -------------------------------------------- change it to another sprint
    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();
    let menu = page.getByRole("menu", { name: /Move .* to a sprint/i });

    /* The sprint it is in is marked as the current choice rather than hidden —
       the row is a field, and a field shows its own value. */
    await expect(
      menu.getByRole("menuitemradio", { name: new RegExp(sprints.active.name) }),
    ).toHaveAttribute("aria-checked", "true");

    await menu
      .getByRole("menuitemradio", { name: new RegExp(sprints.planned.name) })
      .click();
    await expect(sprintRow(page)).toContainText(sprints.planned.name);

    // ------------------------------------------------- and out again entirely
    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();
    menu = page.getByRole("menu", { name: /Move .* to a sprint/i });
    await menu.getByRole("menuitem", { name: /Remove from sprint/i }).click();

    await expect(sprintRow(page)).toContainText("No sprint");
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true, status: true, title: true },
      }),
    ).toMatchObject({
      sprintId: null,
      // Only the sprint changed.
      status: "BACKLOG",
      title: "Work that needs a sprint",
    });
  });

  test("says there are no eligible sprints rather than nothing at all", async ({
    page,
  }) => {
    /* A project with no open sprint: the reader is authorized, the request
       succeeded, and the answer is genuinely empty — which is a sentence, not
       a blank panel, and not an error. */
    const { issue } = await seedProject({ withSprints: false });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();

    const menu = page.getByRole("menu", { name: /Move .* to a sprint/i });
    await expect(menu.getByText("No eligible sprints available.")).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  });

  test("refuses to move an issue whose sprint has been completed", async ({
    page,
  }) => {
    const { sprints, issue } = await seedProject();
    if (!sprints) throw new Error("fixture");

    /* A finished issue `completeSprint` left in its closed sprint. Its
       membership is part of that sprint's record, so there is nowhere to move
       it — and the panel says why rather than showing an empty list. */
    await prisma.issue.update({
      where: { id: issue.id },
      data: { sprintId: sprints.completed.id, status: "DONE" },
    });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await expect(sprintRow(page)).toContainText(sprints.completed.name);

    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();

    const menu = page.getByRole("menu", { name: /Move .* to a sprint/i });
    await expect(menu.getByText(/has been completed/i)).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  });

  test("shows a loading state while the eligible sprints are being read", async ({
    page,
  }) => {
    const { issue } = await seedProject();

    /*
     * The server action is held up long enough to see the state the control is
     * in while it waits. What matters is which state that is: "Loading
     * sprints…", never "No eligible sprints available." — an empty state shown
     * before the answer arrives is a claim the page cannot yet make.
     */
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/issues/**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await held;
      return route.fallback();
    });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();

    const menu = page.getByRole("menu", { name: /Move .* to a sprint/i });
    await expect(menu.getByText("Loading sprints…")).toBeVisible();
    await expect(menu.getByText("No eligible sprints available.")).toHaveCount(0);
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);

    release();
    await expect(menu.getByRole("menuitemradio").first()).toBeVisible();
    await expect(menu.getByText("Loading sprints…")).toHaveCount(0);
  });

  test("reports a failed read as a failure, with a way to try again", async ({
    page,
  }) => {
    const { sprints, issue } = await seedProject();
    if (!sprints) throw new Error("fixture");

    /* The first read fails; the second is let through. A failed request is not
       an empty one, so the panel must say so and offer a retry rather than
       claim there are no sprints. */
    let failed = false;
    await page.route("**/issues/**", async (route) => {
      if (route.request().method() !== "POST" || failed) return route.fallback();
      failed = true;
      return route.abort("failed");
    });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();

    const menu = page.getByRole("menu", { name: /Move .* to a sprint/i });
    await expect(menu.getByText("No eligible sprints available.")).toHaveCount(0);
    const retry = menu.getByRole("button", { name: /Try again/i });
    await expect(retry).toBeVisible();

    await retry.click();
    await expect(
      menu.getByRole("menuitemradio", { name: new RegExp(sprints.active.name) }),
    ).toBeVisible();
  });
});

test.describe("The Sprint row for somebody who may not move work", () => {
  test.use({ storageState: MEMBER_STATE });

  test("states the sprint without offering a move, and is not on a project they cannot open", async ({
    page,
  }) => {
    /*
     * Every working role may move sprint issues — that is the existing rule and
     * `tests/sprint-eligibility.test.ts` asserts it — so what is tested here is
     * the other half: the issue of a project this reader is not a member of is
     * not reachable at all, which is the same refusal the server gives.
     */
    const { issue, project } = await seedProject();
    await prisma.projectMember.deleteMany({
      where: { projectId: project.id, user: { role: "MEMBER" } },
    });

    const response = await page.goto(`/issues/${issue.key.toLowerCase()}`);
    expect(response).not.toBeNull();
    await expect(page.locator(".prio-meta-row__label", { hasText: "Sprint" })).toHaveCount(
      0,
    );
  });

  test("lets a project member move the work, which is the existing rule", async ({
    page,
  }) => {
    const { sprints, issue } = await seedProject();
    if (!sprints) throw new Error("fixture");

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await sprintRow(page)
      .getByRole("button", { name: /Move .* to a sprint/i })
      .click();

    const menu = page.getByRole("menu", { name: /Move .* to a sprint/i });
    await menu
      .getByRole("menuitemradio", { name: new RegExp(sprints.active.name) })
      .click();

    await expect(sprintRow(page)).toContainText(sprints.active.name);
  });
});

/** The project key an issue belongs to, for building a sprint URL. */
async function projectKeyOf(issueId: string): Promise<string> {
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { project: { select: { key: true } } },
  });
  return issue.project.key;
}
