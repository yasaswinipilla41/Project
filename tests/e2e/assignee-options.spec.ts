import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { BOARD_STATUSES } from "@/lib/board";
import { MEMBER_STATE } from "./support";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";

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
  await page.getByRole("button", { name: /^Create$/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Project")).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

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

    /* The viewer is offered as "Assigned to me" rather than by name — the
       Issues bar's own convention, now shared by the board. Their own name is
       therefore absent, and that absence is the point: it would be the same
       filter twice, once under a label and once under a name. */
    const me = await prisma.user.findFirstOrThrow({
      where: { email: "admin@symbiosystech.com" },
      select: { id: true, name: true },
    });

    await page.goto("/projects/eng/board");
    await page.locator(".prio-board__assignee-trigger").click();
    const items = await openMenuItems(page);

    expect(items.some((t) => t.includes("Assigned to me"))).toBe(true);
    expect(items.some((t) => t.includes("Unassigned"))).toBe(true);

    for (const member of members) {
      const named = items.some((t) => t.includes(member.name));
      if (member.id === me.id) {
        expect(
          named,
          "the viewer's own name must not be offered as well as Assigned to me",
        ).toBe(false);
      } else {
        expect(
          named,
          `${member.name} must appear in the board's assignee filter`,
        ).toBe(true);
      }
    }

    /* Assigned to me + Unassigned + everyone except the viewer — the same
       number of rows the roster produced before, with one relabelled. */
    expect(items.length).toBe(members.length + 1);

    for (const member of idle) {
      if (member.id === me.id) continue; // Offered as "Assigned to me" above.
      expect(
        items.some((t) => t.includes(member.name)),
        `${member.name} has nothing assigned and must still be filterable`,
      ).toBe(true);
    }

    /* Listing everyone must not have cost the filter its job: picking a member
       who does have work narrows the board to exactly their cards. The viewer
       is excluded from the search because they are offered under a label
       rather than a name — "Assigned to me" carries the same id and is
       exercised by the member-account tests below. */
    const busy = members.find(
      (m) => m.id !== me.id && !idle.some((i) => i.id === m.id),
    );
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

  /*
   * This member is put on both teams for the run, and taken off again.
   *
   * The create dialog belongs to whoever may raise work, which is the Testing
   * half; the Assignee field on it belongs to whoever may decide who does a
   * piece of work, which a pure tester may not — they raise work and hand it
   * to nobody. Somebody who builds as well as checks has both, and is still
   * not an administrator, which is what this file is about: a non-admin sees
   * their own project's roster and no more.
   */
  let leaveTeams: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const member = await prisma.user.findUniqueOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true },
    });

    const added: string[] = [];
    for (const [slug, name] of [
      [TESTING_TEAM_SLUG, "Testing"],
      [DEVELOPMENT_TEAM_SLUG, "Development"],
    ] as const) {
      const team =
        (await prisma.team.findUnique({
          where: { slug },
          select: { id: true },
        })) ??
        (await prisma.team.create({
          data: { slug, name },
          select: { id: true },
        }));
      const already = await prisma.teamMember.findFirst({
        where: { teamId: team.id, userId: member.id },
        select: { id: true },
      });
      if (already) continue;
      const row = await prisma.teamMember.create({
        data: { teamId: team.id, userId: member.id },
        select: { id: true },
      });
      added.push(row.id);
    }

    if (added.length > 0) {
      leaveTeams = async () => {
        await prisma.teamMember.deleteMany({ where: { id: { in: added } } });
      };
    }
  });

  test.afterAll(async () => {
    if (leaveTeams) await leaveTeams();
  });

  /*
   * The Flow Board's Assignee filter is the one place a member's options are
   * deliberately *not* the project roster.
   *
   * A member filing and working their own issues has no business being handed
   * a list of their colleagues' names to browse; the three questions they
   * actually ask of a board are "is this mine", "is this nobody's" and "is
   * this with an administrator". An administrator's filter is untouched and
   * still lists everyone — that test lives in the describe above, and the two
   * together are what pin the difference.
   */
  test("the Flow Board filter offers roles, not colleagues", async ({ page }) => {
    const members = await projectMembers("ENG");

    await page.goto("/projects/eng/board");
    await page.locator(".prio-board__assignee-trigger").click();
    const items = await openMenuItems(page);

    expect(items.some((t) => t.includes("Assigned to me"))).toBe(true);
    expect(items.some((t) => t.includes("Unassigned"))).toBe(true);

    /* No member's name is on the list -- not a colleague's, and not the
       signed-in member's own. */
    for (const member of members) {
      expect(
        items.some((t) => t.includes(member.name)),
        `${member.name} must not be named in a member's assignee filter`,
      ).toBe(false);
    }

    /* Nothing beyond the three role buckets. Each row's leading avatar
       contributes its placeholder glyph to `innerText`, so the label is
       matched within the row rather than against it. */
    expect(items.length).toBeLessThanOrEqual(3);
    for (const item of items) {
      expect(
        ["Assigned to me", "Unassigned", "Admin"].some((label) =>
          item.includes(label),
        ),
        `unexpected option "${item}" in a member's assignee filter`,
      ).toBe(true);
    }
  });

  test("Assigned to me narrows the board to the member's own cards", async ({
    page,
  }) => {
    const me = await prisma.user.findUniqueOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true },
    });

    const expected = await prisma.issue.count({
      where: {
        project: { key: "ENG" },
        assigneeId: me.id,
        status: { in: BOARD_STATUSES },
      },
    });

    await page.goto("/projects/eng/board");
    await page.locator(".prio-board__assignee-trigger").click();
    await page
      .getByRole("menu")
      .first()
      .locator(
        '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]',
      )
      .filter({ hasText: "Assigned to me" })
      .first()
      .click();
    await page.keyboard.press("Escape");

    await expect
      .poll(async () => page.locator(".prio-board__card").count())
      .toBe(expected);
  });

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
