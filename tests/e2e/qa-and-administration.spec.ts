import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { ADMIN_STATE, MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * The three jobs as the interface presents them, and Administration's own
 * screens.
 *
 * The rules themselves are asserted against the server in
 * `tests/qa-create-rules.test.ts` and `tests/role-permissions.test.ts` — a
 * hidden control has never been the protection. What this walks is the other
 * half: that each person is offered exactly what they may do, that severity is
 * gone from the surfaces that used to carry it, and that Administration's
 * blocks, dialogs and edit flows work when a person actually uses them.
 */

async function teamId(slug: string): Promise<string> {
  const team =
    (await prisma.team.findUnique({ where: { slug }, select: { id: true } })) ??
    (await prisma.team.create({
      data: { slug, name: slug === TESTING_TEAM_SLUG ? "Testing" : "Development" },
      select: { id: true },
    }));
  return team.id;
}

async function memberId(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true },
  });
  return user.id;
}

/** Puts the member on a team for one describe, and takes them off after. */
function onTeam(slug: string) {
  let added: string | null = null;

  test.beforeAll(async () => {
    const [team, user] = [await teamId(slug), await memberId()];
    const existing = await prisma.teamMember.findFirst({
      where: { teamId: team, userId: user },
      select: { id: true },
    });
    if (existing) return;
    const row = await prisma.teamMember.create({
      data: { teamId: team, userId: user },
      select: { id: true },
    });
    added = row.id;
  });

  test.afterAll(async () => {
    if (added) await prisma.teamMember.deleteMany({ where: { id: added } });
  });
}

/** An open issue in a project the member belongs to. */
async function anIssueOfTheirs(): Promise<string> {
  const issue = await prisma.issue.findFirstOrThrow({
    where: {
      project: { members: { some: { userId: await memberId() } } },
      status: { in: ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW"] },
    },
    orderBy: { createdAt: "desc" },
    select: { key: true },
  });
  return issue.key.toLowerCase();
}

/**
 * The members of a project a tester may hand work to.
 *
 * `workRoleFromTeams` spelled out against the database, so this stays honest
 * as the seed changes: an administrator is never offered, somebody on Testing
 * alone is a tester and is not offered, and everybody else builds — whether
 * they are on Development, on both teams, or on no team at all, which is what
 * that rule already calls a developer.
 */
async function developersOnProject(key: string): Promise<string[]> {
  const members = await prisma.projectMember.findMany({
    where: { project: { key }, user: { isActive: true } },
    select: {
      user: {
        select: {
          name: true,
          role: true,
          teamMemberships: { select: { team: { select: { slug: true } } } },
        },
      },
    },
  });

  return members
    .filter(({ user }) => {
      if (user.role === "ADMIN") return false;
      const slugs = new Set(
        user.teamMemberships.map((row) => row.team.slug),
      );
      const testsOnly =
        slugs.has(TESTING_TEAM_SLUG) && !slugs.has(DEVELOPMENT_TEAM_SLUG);
      return !testsOnly;
    })
    .map(({ user }) => user.name)
    .sort();
}

/** The statuses the issue page's own status menu offers. */
async function statusMenuOptions(page: Page): Promise<string[]> {
  await page.locator(".prio-fieldtrigger").first().click();
  /* One status out of a set, so its entries are `menuitemradio`. */
  const items = page.getByRole("menuitemradio");
  await expect(items.first()).toBeVisible();
  const labels = (await items.allInnerTexts()).map((text) => text.trim());
  await page.keyboard.press("Escape");
  return labels;
}

/* ------------------------------------------------------------------- QA */

test.describe("A QA member", () => {
  test.use({ storageState: MEMBER_STATE });
  onTeam(TESTING_TEAM_SLUG);

  test("hands work to a developer, and still sets no due date", async ({
    page,
  }) => {
    /*
     * A tester raising a defect knows who should look at it, and having to
     * ask somebody else to make the assignment was the delay worth removing.
     * So Assignee is offered — narrowed to the people who build.
     *
     * A due date is still not theirs to set: when work is promised is a
     * planning decision, and it stays with whoever plans. `createIssue`
     * enforces both rules again on the way in; this is only what is offered.
     */
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });

    const assignee = dialog.locator("#create-assignee");
    await expect(assignee).toHaveCount(1);

    /* Everybody offered is developer-capable. Read from the database rather
       than hard-coded, so this stays true as the seed changes. */
    await expect
      .poll(async () => (await assignee.locator("option").count()) > 1)
      .toBe(true);
    const offered = (await assignee.locator("option").allInnerTexts())
      .slice(1)
      .map((text) => text.trim())
      .sort();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toEqual(await developersOnProject("ENG"));

    // The due date is still not a tester's to set.
    await expect(dialog.locator("#create-due")).toHaveCount(0);
    await expect(dialog.getByText("Due date", { exact: true })).toHaveCount(0);

    // …and severity is gone for everybody, this form included.
    await expect(dialog.locator("#create-severity")).toHaveCount(0);
    await expect(dialog.getByText("Severity")).toHaveCount(0);

    await page.keyboard.press("Escape");
  });

  test("can file work into the Backlog or as New, and into nothing else", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const options = await page
      .getByRole("dialog")
      .locator("#create-status option")
      .allInnerTexts();

    /* Raising work is a separate decision from moving it, and for a tester the
       filing list is the narrower of the two. What they file is a request for
       somebody to pick up — parked in the Backlog or ready as New; whether it
       is being built or finished is not theirs to declare at the moment they
       raise it. Backlog stays first, so it is what a tester gets by default. */
    expect(options.map((o) => o.trim())).toEqual(["Backlog", "New"]);
    await page.keyboard.press("Escape");
  });

  test("sees only their own statuses on an issue, and Done once it is In QA", async ({
    page,
  }) => {
    const key = await anIssueOfTheirs();
    await page.goto(`/issues/${key}`);

    const labels = await statusMenuOptions(page);
    for (const theirs of [
      "Backlog",
      "In QA",
      "Reopen",
      "Reject / Not an Issue",
      "Cancelled",
    ]) {
      expect(labels, `${theirs} is theirs`).toContain(theirs);
    }
    /* The build is the developer's half — New and In Progress say what
       somebody is working on, and Ready for QA is the hand-off *into* testing
       rather than something testing declares: a tester who could set it would
       be handing work to themselves. */
    for (const forbidden of ["New", "In Progress", "Ready for QA"]) {
      expect(labels, `${forbidden} is not offered`).not.toContain(forbidden);
    }

    /* Done is what testing concluded, so it is offered from In QA and not from
       anywhere else — the workflow, expressed as the menu. */
    expect(labels).not.toContain("Done");

    const issue = await prisma.issue.findFirstOrThrow({
      where: { key: key.toUpperCase() },
      select: { id: true, status: true },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { status: "IN_QA" },
    });

    try {
      await page.reload();
      expect(await statusMenuOptions(page)).toContain("Done");
    } finally {
      await prisma.issue.update({
        where: { id: issue.id },
        data: { status: issue.status },
      });
    }
  });

  test("cannot reach Administration, by link or by address", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Administration" }),
    ).toHaveCount(0);

    /* Typed in directly, the route renders nothing of Administration — no
       rosters, no people, no way in. `requireAdmin` is what refuses it; this
       is that refusal seen from the browser. */
    await page.goto("/admin");
    await expect(page.getByRole("button", { name: "Add members" })).toHaveCount(0);
    await expect(page.getByText("admin@symbiosystech.com")).toHaveCount(0);
  });

  test("cannot reach the People screen either", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByRole("button", { name: "New user" })).toHaveCount(0);
    await expect(page.getByText("admin@symbiosystech.com")).toHaveCount(0);
  });
});

/* ------------------------------------------------------------ developer */

test.describe("A developer", () => {
  test.use({ storageState: MEMBER_STATE });

  test.beforeAll(async () => {
    // The seed puts nobody on Testing; make sure of it for this describe.
    await prisma.teamMember.deleteMany({
      where: { teamId: await teamId(TESTING_TEAM_SLUG), userId: await memberId() },
    });
  });

  test("is offered the build's statuses, and nothing that closes work", async ({
    page,
  }) => {
    await page.goto(`/issues/${await anIssueOfTheirs()}`);

    const labels = await statusMenuOptions(page);
    for (const theirs of ["New", "In Progress", "Ready for QA"]) {
      expect(labels, `${theirs} is theirs`).toContain(theirs);
    }
    /* Everything else belongs to somebody else: In QA, Done, the backlog, the
       two verdicts that write work off and Reopen are all things testing
       concludes about the build rather than things the build declares. */
    for (const forbidden of [
      "Backlog",
      "In QA",
      "Done",
      "Reject / Not an Issue",
      "Cancelled",
      "Reopen",
    ]) {
      expect(labels, `${forbidden} is not theirs`).not.toContain(forbidden);
    }
  });

  test("is refused In QA by the server, whatever is sent", async ({ page }) => {
    /* The menu does not offer it; this is the other half — the same move made
       against the action directly, which is what a forged request is. */
    const key = await anIssueOfTheirs();
    const before = await prisma.issue.findFirstOrThrow({
      where: { key: key.toUpperCase() },
      select: { id: true, status: true },
    });

    await page.goto(`/issues/${key}`);
    const refused = await page.evaluate(async (issueId) => {
      const response = await fetch(location.href, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": "probe",
        },
        body: JSON.stringify([{ issueId, status: "IN_QA" }]),
      });
      return response.status;
    }, before.id);

    // Whatever the server answers, the issue has not moved.
    expect(refused).toBeGreaterThan(0);
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: before.id },
      select: { status: true },
    });
    expect(after.status).toBe(before.status);
  });
});

/* --------------------------------------------------------- severity gone */

test.describe("Severity", () => {
  test.use({ storageState: ADMIN_STATE });

  test("is absent from the list, its filters and an issue", async ({ page }) => {
    await page.goto("/issues");
    await expect(page.getByRole("columnheader", { name: "Severity" })).toHaveCount(
      0,
    );
    await expect(
      page.locator(".prio-filters").getByRole("button", { name: "Severity" }),
    ).toHaveCount(0);
    await expect(page.locator(".prio-severity")).toHaveCount(0);

    await page.goto("/bugs");
    await expect(page.locator(".prio-severity")).toHaveCount(0);

    const bug = await prisma.issue.findFirstOrThrow({
      where: { type: "BUG" },
      orderBy: { createdAt: "desc" },
      select: { key: true },
    });
    await page.goto(`/issues/${bug.key.toLowerCase()}`);
    await expect(page.getByText("Severity")).toHaveCount(0);
    await expect(page.locator(".prio-severity")).toHaveCount(0);
  });
});

/* -------------------------------------------------------- administration */

/**
 * Assignments this file moves, and what they were before it did.
 *
 * The roster editor's work picker offers a project's issues *minus* the ones
 * the person already holds (`SearchSelect` filters `selected` out), so a test
 * that assigns one and walks away shrinks the pool it draws from by one every
 * time it runs. Left alone it eventually empties: the person holds everything
 * in their projects, the picker has nothing to offer, and the test fails for
 * good against that database — which is what happened here, with all nine of
 * Website's issues on one person.
 *
 * `tester-assignment.spec.ts` had the same disease and its comment names it:
 * "every run took one more issue out of the pool it picks from, until nothing
 * was left that the tester did not already hold." This is the same remedy,
 * written once so both halves of it — the issue freed to guarantee a choice,
 * and the issue the choice landed on — are put back by the same code.
 *
 * The first value recorded for an issue wins, so freeing one and then
 * assigning it restores the assignee it had before any of this, not the null
 * it was given in between.
 */
const assigneesToRestore = new Map<string, string | null>();

/** Notes an issue's current assignee, once, before anything moves it. */
async function rememberAssignee(issueId: string): Promise<void> {
  if (assigneesToRestore.has(issueId)) return;
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { assigneeId: true },
  });
  assigneesToRestore.set(issueId, issue.assigneeId);
}

/** Puts every assignment this file moved back where it found it. */
async function restoreAssignees(): Promise<void> {
  for (const [id, assigneeId] of assigneesToRestore) {
    await prisma.issue.update({ where: { id }, data: { assigneeId } });
  }
  assigneesToRestore.clear();
}

/**
 * Makes sure the work picker will have something to offer this person.
 *
 * It offers what they do not already hold, so a person holding everything in
 * their projects is offered nothing — a real state, reached by this test's own
 * previous runs. One issue is released to guarantee a choice, and recorded so
 * it goes back.
 *
 * Nothing is released when the picker already has options, so the ordinary
 * run touches no data it did not have to.
 */
async function freeOneIssueFor(personId: string): Promise<void> {
  const inTheirProjects = {
    project: {
      isArchived: false,
      members: { some: { userId: personId } },
    },
  } as const;

  /*
   * Everything in their projects that is not already theirs.
   *
   * Spelled as an OR rather than `NOT: { assigneeId: personId }`, which is
   * the same trap `tester-assignment.spec.ts` documents: a comparison against
   * a value never matches NULL, so that form quietly excludes every
   * unassigned issue — exactly the ones the picker would have offered. With
   * it, this helper believed there was nothing to offer whenever the only
   * candidates were unassigned, and released one more issue every run.
   */
  const offerable = await prisma.issue.count({
    where: {
      ...inTheirProjects,
      OR: [{ assigneeId: null }, { assigneeId: { not: personId } }],
    },
  });
  if (offerable > 0) return;

  const held = await prisma.issue.findFirst({
    where: { ...inTheirProjects, assigneeId: personId },
    orderBy: { key: "asc" },
    select: { id: true },
  });
  if (!held) return;

  await rememberAssignee(held.id);
  await prisma.issue.update({
    where: { id: held.id },
    data: { assigneeId: null },
  });
}

test.describe("Administration", () => {
  test.use({ storageState: ADMIN_STATE });

  /* Whatever the roster editor moved goes back, whether the test that moved
     it passed or not — a run that fails half way through has still taken an
     issue out of the pool, and leaving it out is what made this spec
     un-runnable against a database it had already been run on. */
  test.afterAll(restoreAssignees);

  test("puts Development, Testing and Full Stack side by side", async ({
    page,
  }) => {
    await page.goto("/admin");

    /* Three blocks now: the two team rosters, and the full stack roster that
       follows from being on both. They share a row rather than the third
       starting a new one underneath. */
    const blocks = page.locator(
      ".row > [class*='col-lg-']:has(.prio-projectmembers__head)",
    );
    await expect(blocks).toHaveCount(3);

    const boxes = await blocks.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect()),
    );
    expect(boxes.length).toBe(3);
    for (const box of boxes) {
      expect(Math.abs(box.top - boxes[0]!.top)).toBeLessThan(2);
      expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThan(2);
    }
  });

  test("keeps the Full Stack roster independent of Development and Testing", async ({
    page,
  }) => {
    /*
     * This block used to be derived — the people on Development *and* on
     * Testing — with adding writing both rows and removing deleting both. That
     * made two deliberate memberships into side effects of a third, so taking
     * somebody off this list quietly took away a Testing row that had been
     * granted separately and for its own reasons. It is a roster in its own
     * right now, and says so.
     */
    await page.goto("/admin");

    const block = page
      .locator(".prio-issue__section")
      .filter({
        has: page.getByRole("heading", { name: /^Full Stack Developers · / }),
      });
    await expect(block).toBeVisible();
    await expect(block).toContainText("A membership of its own");
    await expect(block).not.toContainText("Not a separate team");

    // Offered and edited like the two rosters beside it, which both remain.
    await expect(
      block.getByRole("button", { name: "Add members" }),
    ).toHaveCount(1);
    for (const team of ["Development", "Testing"]) {
      await expect(
        page.locator(".prio-issue__section").filter({
          has: page.getByRole("heading", { name: new RegExp(`^${team} · `) }),
        }),
      ).toHaveCount(1);
    }
  });

  test("opens each block, and every one of them comes back", async ({ page }) => {
    /* By destination, not by the words on the tile: the tiles quote each other
       in their hints — Projects says "N issues total" — so matching "Issues"
       would find the wrong one.

       Users is not in this list any more. People is rendered on Administration
       itself, so its tile scrolls to the block instead of leaving the page,
       and there is nothing for it to come back from. */
    for (const [href, destination] of [
      ["/projects?from=admin", "projects"],
      ["/issues?from=admin", "issues"],
      ["/bugs?from=admin", "bugs"],
    ] as const) {
      await page.goto("/admin");
      await page.locator(`.prio-stat[href="${href}"]`).click();
      await expect(page).toHaveURL(new RegExp(destination));

      const back = page.getByRole("link", { name: "Back to Administration" });
      await expect(back, `${destination} offers the way back`).toBeVisible();
      await back.click();
      await expect(page).toHaveURL(/\/admin$/);
    }
  });

  test("holds People under Development and Testing, without leaving the page", async ({
    page,
  }) => {
    await page.goto("/admin");

    /* The Users tile points at the block on this page rather than a route of
       its own. */
    const tile = page.locator('.prio-stat[href="#people"]');
    await expect(tile).toHaveCount(1);
    await expect(page.locator('.prio-stat[href="/admin/users"]')).toHaveCount(0);

    await tile.click();
    await expect(page).toHaveURL(/\/admin(#people)?$/);

    /* One People block, rendered here — not a second copy of it. */
    const people = page.locator("#people");
    await expect(people).toHaveCount(1);
    await expect(people.getByRole("button", { name: /new user/i })).toBeVisible();

    /* And it sits below the two rosters, in the order Administration lists
       them: Development, Testing, then People. */
    const order = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("h2")].map((h) =>
        (h.textContent ?? "").trim(),
      );
      return heads;
    });
    const development = order.findIndex((t) => t.startsWith("Development"));
    const testing = order.findIndex((t) => t.startsWith("Testing"));
    const peopleHeading = order.findIndex((t) => t.startsWith("People"));
    expect(development).toBeGreaterThanOrEqual(0);
    expect(testing).toBeGreaterThanOrEqual(0);
    expect(peopleHeading).toBeGreaterThan(Math.max(development, testing));
  });

  test("keeps the People route working for anyone who goes there directly", async ({
    page,
  }) => {
    /* Embedding the block did not retire the route; it is linked from
       elsewhere and still renders the same component. */
    await page.goto("/admin/users");
    await expect(
      page.getByRole("heading", { name: "People", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /new user/i })).toBeVisible();
  });

  test("Add to Development searches, filters by role, and keeps chips", async ({
    page,
  }) => {
    await page.goto("/admin");

    await page
      /* By its heading: the Full Stack block names Development in its own
         description, so matching the card on the word finds two. */
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: /^Development · / }) })
      .getByRole("button", { name: "Add members" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    /* Each field carries its own chips and its own list, so both are
       addressed per field: several lists can be open at once, and an unscoped
       lookup would mix an issue into the people. Role arrives with a chip
       already, being a single choice with a default. */
    const chipsOf = (field: string) =>
      dialog.locator(`.prio-field:has(#${field}) .prio-chipset__chip`);
    const optionsOf = (field: string) =>
      page.locator(`#${field}-options`).getByRole("option");

    // Project: type, choose, and it becomes a chip.
    await dialog.locator("#roster-project").click();
    await dialog.locator("#roster-project").pressSequentially("Eng");
    await optionsOf("roster-project").first().click();
    await expect(chipsOf("roster-project")).toHaveCount(1);

    // Issues: the project's own, several of them, each a chip.
    await expect(dialog.locator("#roster-issues")).toBeVisible();
    await dialog.locator("#roster-issues").click();
    await optionsOf("roster-issues").first().click();
    await dialog.locator("#roster-issues").click();
    await optionsOf("roster-issues").first().click();
    await expect(chipsOf("roster-issues")).toHaveCount(2);

    /* The issues list stays open after a choice, ready for the next search,
       and takes the room the window actually has rather than a fixed 220px —
       so it covers the fields beneath it, as any open dropdown does. Escape
       dismisses it, which is what the field's own `data-local-escape` is for
       and what a person does before moving on. */
    await page.keyboard.press("Escape");
    await expect(optionsOf("roster-issues")).toHaveCount(0);

    // Members: searchable, multiple, and narrowed by the Role above.
    await dialog.locator("#team-search").click();
    const offered = await optionsOf("team-search").allInnerTexts();
    expect(offered.length).toBeGreaterThan(0);

    await optionsOf("team-search").first().click();
    await dialog.locator("#team-search").click();
    await optionsOf("team-search").first().click();
    await expect(chipsOf("team-search")).toHaveCount(2);

    // Likewise before reaching back up to Role, which a tall list can cover.
    await page.keyboard.press("Escape");
    await expect(optionsOf("team-search")).toHaveCount(0);

    /* Switching Role changes who is offered — the admin list is a different,
       shorter set than the member list. */
    await dialog.locator("#roster-role").click();
    await optionsOf("roster-role").filter({ hasText: "Admin" }).first().click();
    await dialog.locator("#team-search").click();
    const asAdmin = await optionsOf("team-search").allInnerTexts();
    expect(asAdmin).not.toEqual(offered);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  test("opens on every project the person is on, and edits work across them", async ({
    page,
  }) => {
    /*
     * The editor used to hold one project. Somebody working on two could only
     * be edited for one of them, and the save released their work in the
     * other — so the safe thing to do with a person on several projects was
     * not to edit them at all.
     *
     * It now opens on everything they are on. The load-bearing part is that
     * first assertion: the projects they hold are already selected before
     * anybody touches the form, which is what makes saving an untouched
     * editor a no-op rather than a mass unassignment.
     */
    const person = await prisma.user.findFirstOrThrow({
      where: {
        isActive: true,
        teamMemberships: { some: {} },
        projectMemberships: { some: { project: { isArchived: false } } },
      },
      select: {
        id: true,
        name: true,
        projectMemberships: {
          where: { project: { isArchived: false } },
          select: { project: { select: { name: true } } },
        },
      },
    });
    const theirProjects = person.projectMemberships.map((m) => m.project.name);

    /* The picker offers what they do not already hold, so this makes sure
       there is something left to offer. See `freeOneIssueFor`. */
    await freeOneIssueFor(person.id);

    await page.goto("/admin");
    await page
      .getByRole("button", { name: `Profile of ${person.name}` })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Edit" }).click();
    await expect(dialog.locator("#roster-edit-project")).toBeVisible();

    // Every project they are on is already a chip, none of them added by hand.
    for (const name of theirProjects) {
      await expect(
        dialog.locator(".prio-chipset__chip").filter({ hasText: name }),
      ).toHaveCount(1);
    }

    /* And the work picker is open on those projects without a project having
       to be chosen first — there is nothing left to choose. */
    await expect(dialog.locator("#roster-edit-issues")).toBeVisible();

    const optionsOf = (field: string) =>
      page.locator(`#${field}-options`).getByRole("option");

    await dialog.locator("#roster-edit-issues").click();
    const issueOption = optionsOf("roster-edit-issues").first();
    await expect(issueOption).toBeVisible();
    const label = await issueOption.innerText();
    const chosen = label.split("—")[0]!.trim();

    /* Noted before Save moves it, so it can be put back afterwards. Without
       this the test keeps one more issue every run and eventually leaves the
       picker with nothing to offer. */
    const target = await prisma.issue.findFirstOrThrow({
      where: { key: chosen },
      select: { id: true },
    });
    await rememberAssignee(target.id);

    await issueOption.click();

    /* The picker stays open after a choice, ready for the next search, and
       takes the room the window has — so it covers what is beneath it, Save
       included, as any open dropdown does. Escape dismisses it, which is what
       the field's own `data-local-escape` is for and what a person does before
       reaching for Save. */
    await page.keyboard.press("Escape");
    await expect(optionsOf("roster-edit-issues")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Save changes" }).click();

    /* The toast is what says the write landed. Asserting the key is still on
       screen would not: it is on screen either way, as the chip that was just
       chosen, so a refused save would look exactly like a successful one. */
    await expect(page.locator(".prio-toast")).toContainText(/updated/i, {
      timeout: 15_000,
    });

    // …and the profile, back out of edit mode, lists that work.
    await expect(dialog.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(dialog.getByText(chosen).first()).toBeVisible();

    const assigned = await prisma.issue.findFirstOrThrow({
      where: { key: chosen },
      select: { assigneeId: true },
    });
    expect(assigned.assigneeId).not.toBeNull();

    /* Nothing was taken away to make room for it: they are still on every
       project they started on. */
    const after = await prisma.user.findFirstOrThrow({
      where: { name: person.name },
      select: {
        projectMemberships: {
          where: { project: { isArchived: false } },
          select: { project: { select: { name: true } } },
        },
      },
    });
    expect(
      after.projectMemberships.map((m) => m.project.name).sort(),
    ).toEqual([...theirProjects].sort());
  });
});

/* ------------------------------------------------------------- developer */

test.describe("The Development roster", () => {
  test.use({ storageState: ADMIN_STATE });

  test("exists as its own block, beside Testing", async ({ page }) => {
    await page.goto("/admin");
    await expect(
      page.locator(".prio-issue__section-title", { hasText: "Development" }),
    ).toBeVisible();
    await expect(
      page.locator(".prio-issue__section-title", { hasText: "Testing" }),
    ).toBeVisible();
  });
});

test.describe("A developer account and Administration", () => {
  test.use({ storageState: MEMBER_STATE });

  test.beforeAll(async () => {
    await prisma.teamMember.deleteMany({
      where: { teamId: await teamId(DEVELOPMENT_TEAM_SLUG), userId: await memberId() },
    });
  });

  test("is refused the People screen and the roster actions", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByRole("button", { name: "New user" })).toHaveCount(0);

    await page.goto("/admin");
    await expect(page.getByRole("button", { name: "Add members" })).toHaveCount(0);
  });
});
