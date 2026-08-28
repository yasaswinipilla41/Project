import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { BOARD_STATUSES } from "@/lib/board";
import { MEMBER_STATE } from "./support";

/**
 * Who may be picked as an assignee.
 *
 * The rule is that an assignee list is built from the project's *membership*,
 * never from the issues that happen to exist. A member who has never been
 * given anything is exactly as assignable as one carrying ten items — and is
 * the person you most often need to pick, since assigning work is how they
 * stop having none.
 *
 * Every expectation below is read from the database rather than hard-coded, so
 * these stay honest as the seed changes. The load-bearing assertion in each is
 * the same: the members with *zero* assigned issues are present.
 */

interface Member {
  id: string;
  name: string;
}

async function projectMembers(key: string): Promise<Member[]> {
  const project = await prisma.project.findUnique({
    where: { key },
    select: {
      id: true,
      members: { select: { user: { select: { id: true, name: true } } } },
    },
  });
  if (!project) throw new Error(`No project ${key}.`);
  return project.members
    .map((m) => m.user)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Members of `key` who are not the assignee of a single issue in it. */
async function membersWithNothingAssigned(key: string): Promise<Member[]> {
  const members = await projectMembers(key);
  const assigned = await prisma.issue.findMany({
    where: { project: { key }, assigneeId: { not: null } },
    select: { assigneeId: true },
    distinct: ["assigneeId"],
  });
  const busy = new Set(assigned.map((row) => row.assigneeId));
  return members.filter((m) => !busy.has(m.id));
}

async function projectId(key: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { key },
    select: { id: true },
  });
  if (!project) throw new Error(`No project ${key}.`);
  return project.id;
}

/** Visible text of every item in the menu that is currently open. */
async function openMenuItems(page: Page, name?: string | RegExp) {
  const menu = name
    ? page.getByRole("menu", { name })
    : page.getByRole("menu").first();
  await menu.waitFor();
  const raw = await menu
    .locator(
      '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]',
    )
    .allInnerTexts();
  // Avatars contribute their initials to innerText; collapse to one line.
  return raw.map((text) => text.replace(/\s+/g, " ").trim());
}

async function openCreateDialog(page: Page) {
  await page.goto("/issues");
  await page.getByRole("button", { name: "Create Issue" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Summary")).toBeVisible();
  return dialog;
}

test.describe("Assignee options come from project membership", () => {
  test("Create Issue offers every member of the chosen project", async ({
    page,
  }) => {
    const members = await projectMembers("ENG");
    const idle = await membersWithNothingAssigned("ENG");
    expect(
      idle.length,
      "the fixture needs at least one member with nothing assigned",
    ).toBeGreaterThan(0);

    const dialog = await openCreateDialog(page);
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });

    const assignee = dialog.getByLabel("Assignee");
    await expect
      .poll(async () => (await assignee.locator("option").allInnerTexts()).length)
      .toBe(members.length + 1); // + Unassigned

    const options = (await assignee.locator("option").allInnerTexts()).map((t) =>
      t.trim(),
    );

    expect(options[0], "Unassigned stays the first option").toBe("Unassigned");
    expect(options.slice(1).sort()).toEqual(
      members.map((m) => m.name).sort(),
    );

    // The point of the whole exercise.
    for (const member of idle) {
      expect(
        options,
        `${member.name} has nothing assigned and must still be offered`,
      ).toContain(member.name);
    }
  });

  test("changing the project reloads the assignee options", async ({ page }) => {
    const eng = await projectMembers("ENG");
    const web = await projectMembers("WEB");

    const dialog = await openCreateDialog(page);
    const assignee = dialog.getByLabel("Assignee");

    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });
    await expect
      .poll(async () => (await assignee.locator("option").count()) - 1)
      .toBe(eng.length);
    const first = (await assignee.locator("option").allInnerTexts())
      .slice(1)
      .map((t) => t.trim())
      .sort();
    expect(first).toEqual(eng.map((m) => m.name).sort());

    await dialog.getByLabel("Project").selectOption({ label: "Website (WEB)" });
    await expect
      .poll(async () => (await assignee.locator("option").count()) - 1)
      .toBe(web.length);
    const second = (await assignee.locator("option").allInnerTexts())
      .slice(1)
      .map((t) => t.trim())
      .sort();
    expect(second).toEqual(web.map((m) => m.name).sort());
  });

  test("Create Issue does not offer people from outside the project", async ({
    page,
  }) => {
    const members = await projectMembers("ENG");
    const memberIds = new Set(members.map((m) => m.id));
    const outsiders = (
      await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      })
    ).filter((u) => !memberIds.has(u.id));

    expect(
      outsiders.length,
      "the fixture needs at least one active non-member",
    ).toBeGreaterThan(0);

    const dialog = await openCreateDialog(page);
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });
    await expect
      .poll(async () => (await dialog.getByLabel("Assignee").locator("option").count()) - 1)
      .toBe(members.length);

    const options = (
      await dialog.getByLabel("Assignee").locator("option").allInnerTexts()
    ).map((t) => t.trim());

    for (const outsider of outsiders) {
      expect(
        options,
        `${outsider.name} is not an ENG member and must not be offered`,
      ).not.toContain(outsider.name);
    }
  });

  test("the issue page offers every member of that issue's project", async ({
    page,
  }) => {
    const members = await projectMembers("ENG");
    const idle = await membersWithNothingAssigned("ENG");

    await page.goto("/issues/eng-2");
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

    await page.locator(".prio-fieldtrigger__person").first().click();
    const items = await openMenuItems(page, "Change assignee");

    expect(items.some((t) => t.includes("Unassigned"))).toBe(true);
    for (const member of members) {
      expect(
        items.some((t) => t.includes(member.name)),
        `${member.name} must be assignable from the issue page`,
      ).toBe(true);
    }
    // One row per member, plus Unassigned — no omissions and no strays.
    expect(items.length).toBe(members.length + 1);

    for (const member of idle) {
      expect(
        items.some((t) => t.includes(member.name)),
        `${member.name} has nothing assigned and must still be assignable`,
      ).toBe(true);
    }
  });

  test("the Flow Board filter lists every member, and still filters", async ({
    page,
  }) => {
    const members = await projectMembers("ENG");
    const idle = await membersWithNothingAssigned("ENG");

    await page.goto("/projects/eng/board");
    await page.locator(".prio-board__assignee-trigger").click();
    const items = await openMenuItems(page);

    expect(items.some((t) => t.includes("Unassigned"))).toBe(true);
    for (const member of members) {
      expect(
        items.some((t) => t.includes(member.name)),
        `${member.name} must appear in the board's assignee filter`,
      ).toBe(true);
    }
    expect(items.length).toBe(members.length + 1);

    for (const member of idle) {
      expect(
        items.some((t) => t.includes(member.name)),
        `${member.name} has nothing assigned and must still be filterable`,
      ).toBe(true);
    }

    /* Listing everyone must not have cost the filter its job: picking a member
       who does have work narrows the board to exactly their cards. */
    const busy = members.find((m) => !idle.some((i) => i.id === m.id));
    expect(busy, "the fixture needs a member with work").toBeTruthy();

    await page
      .getByRole("menu")
      .first()
      .locator(
        '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]',
      )
      .filter({ hasText: busy!.name })
      .first()
      .click();
    await page.keyboard.press("Escape");

    /* The board only carries the statuses it has columns for, so the count to
       expect is theirs — not every issue the member owns. */
    const expected = await prisma.issue.count({
      where: {
        project: { key: "ENG" },
        assigneeId: busy!.id,
        status: { in: BOARD_STATUSES },
      },
    });
    expect(expected, "the chosen member needs work on the board").toBeGreaterThan(0);
    await expect
      .poll(async () => page.locator(".prio-board__card").count())
      .toBe(expected);
  });
});

test.describe("Assignee options for a member account", () => {
  test.use({ storageState: MEMBER_STATE });

  test("a member sees their own project's full membership, and no more", async ({
    page,
  }) => {
    const engId = await projectId("ENG");
    const membership = await prisma.projectMember.findFirst({
      where: { projectId: engId, user: { email: "priya.nair@symbiosystech.com" } },
      select: { id: true },
    });
    test.skip(!membership, "the member fixture is not in ENG");

    const members = await projectMembers("ENG");
    const dialog = await openCreateDialog(page);
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });

    const assignee = dialog.getByLabel("Assignee");
    await expect
      .poll(async () => (await assignee.locator("option").count()) - 1)
      .toBe(members.length);

    const options = (await assignee.locator("option").allInnerTexts()).map((t) =>
      t.trim(),
    );
    expect(options.slice(1).sort()).toEqual(members.map((m) => m.name).sort());
  });
});
