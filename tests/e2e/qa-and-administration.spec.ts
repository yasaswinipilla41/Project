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

  test("files work without an assignee or a due date", async ({ page }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Both fields are absent from the form, not merely disabled.
    await expect(dialog.locator("#create-assignee")).toHaveCount(0);
    await expect(dialog.locator("#create-due")).toHaveCount(0);
    await expect(dialog.getByText("Assignee", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Due date", { exact: true })).toHaveCount(0);

    // …and severity is gone for everybody, this form included.
    await expect(dialog.locator("#create-severity")).toHaveCount(0);
    await expect(dialog.getByText("Severity")).toHaveCount(0);

    await page.keyboard.press("Escape");
  });

  test("is offered the statuses testing uses, and cannot file work as Done", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const options = await page
      .getByRole("dialog")
      .locator("#create-status option")
      .allInnerTexts();

    /* One status, because raising work is one act: something nobody has
       picked up yet. The other four they may set are verdicts about work that
       already exists — see the status-menu test below. */
    expect(options.map((o) => o.trim())).toEqual(["Backlog"]);
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
      "Reject / Not an Issue",
      "Cancelled",
    ]) {
      expect(labels, `${theirs} is theirs`).toContain(theirs);
    }
    /* The build is the developer's half: New and In Progress say what somebody
       is working on, and Ready for QA is the hand-off from whoever built it. */
    for (const forbidden of ["New", "In Progress", "Ready for QA", "Reopen"]) {
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
    /* Everything else belongs to somebody else: In QA and Done are what
       testing concluded, Backlog and Reopen are decisions about what is being
       worked on next, and the two that write work off are an administrator's. */
    for (const forbidden of [
      "Backlog",
      "In QA",
      "Done",
      "Reopen",
      "Reject / Not an Issue",
      "Cancelled",
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

test.describe("Administration", () => {
  test.use({ storageState: ADMIN_STATE });

  test("puts Development and Testing side by side", async ({ page }) => {
    await page.goto("/admin");

    const blocks = page.locator(".row > .col-lg-6:has(.prio-projectmembers__head)");
    await expect(blocks).toHaveCount(2);

    const [first, second] = await blocks.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect()),
    );
    expect(first, "two blocks are laid out").toBeTruthy();
    expect(second).toBeTruthy();
    // Same row, equal width: side by side rather than stacked.
    expect(Math.abs(first!.top - second!.top)).toBeLessThan(2);
    expect(Math.abs(first!.width - second!.width)).toBeLessThan(2);
  });

  test("opens each block, and every one of them comes back", async ({ page }) => {
    /* By destination, not by the words on the tile: the tiles quote each other
       in their hints — Projects says "N issues total" — so matching "Issues"
       would find the wrong one. */
    for (const [href, destination] of [
      ["/admin/users", "admin/users"],
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

  test("Add to Development searches, filters by role, and keeps chips", async ({
    page,
  }) => {
    await page.goto("/admin");

    await page
      .locator(".prio-issue__section:has-text('Development')")
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
      dialog.locator(`#${field}-options`).getByRole("option");

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

    // Members: searchable, multiple, and narrowed by the Role above.
    await dialog.locator("#team-search").click();
    const offered = await optionsOf("team-search").allInnerTexts();
    expect(offered.length).toBeGreaterThan(0);

    await optionsOf("team-search").first().click();
    await dialog.locator("#team-search").click();
    await optionsOf("team-search").first().click();
    await expect(chipsOf("team-search")).toHaveCount(2);

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

  test("edits a roster member's project and work, and it persists", async ({
    page,
  }) => {
    await page.goto("/admin");

    // Somebody on a roster: the Testing block's first member, whoever that is.
    const anyMember = page.locator(".prio-memberrow").first();
    await expect(anyMember).toBeVisible();
    await anyMember.getByRole("button", { name: /^Profile of / }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Edit" }).click();
    await expect(dialog.locator("#roster-edit-project")).toBeVisible();

    // Choose a project, then a piece of its work.
    const optionsOf = (field: string) =>
      dialog.locator(`#${field}-options`).getByRole("option");

    await dialog.locator("#roster-edit-project").click();
    await optionsOf("roster-edit-project").first().click();
    await expect(dialog.locator("#roster-edit-issues")).toBeVisible();

    await dialog.locator("#roster-edit-issues").click();
    const issueOption = optionsOf("roster-edit-issues").first();
    const chosen = (await issueOption.innerText()).split("—")[0]!.trim();
    await issueOption.click();

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
