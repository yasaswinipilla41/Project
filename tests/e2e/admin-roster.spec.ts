import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { ADMIN_STATE, MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * Administration's rosters, and what a QA member is shown, through the browser.
 *
 * The server rules are asserted directly in `tests/roster.test.ts` — a filtered
 * dropdown is never what makes a write safe. What this walks is the other half:
 * that the blocks are reachable, the dialogs offer the fields they are supposed
 * to, the dependent list actually depends, and a QA member is not handed a
 * sprint screen.
 */

async function memberId(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true },
  });
  return user.id;
}

async function teamId(slug: string): Promise<string> {
  const team = await prisma.team.findUniqueOrThrow({
    where: { slug },
    select: { id: true },
  });
  return team.id;
}

test.describe("Administration summary blocks", () => {
  test.use({ storageState: ADMIN_STATE });

  test("each block opens what it counts", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.locator(".prio-stat").first()).toBeVisible();

    /*
     * Addressed by destination rather than by the text on the tile. The tiles
     * quote each other in their hints — Projects says "N issues total" — so
     * matching on the word "Issues" finds the Projects tile first, and the
     * test would pass while clicking the wrong thing.
     *
     * All four leave the page now, People included: it has a route of its own
     * so that every block behaves the same way and every destination can offer
     * the same way back. The three shared pages carry `from=admin`, which is
     * what tells them to show it — they are reached from the sidebar too.
     */
    for (const [href, destination] of [
      ["/admin/users", "/admin/users"],
      ["/projects?from=admin", "/projects"],
      ["/issues?from=admin", "/issues"],
      ["/bugs?from=admin", "/bugs"],
    ] as const) {
      await page.goto("/admin");
      const tile = page.locator(`.prio-stat[href="${href}"]`);
      await expect(tile).toHaveCount(1);
      await tile.click();
      await expect(page).toHaveURL(new RegExp(destination));

      const back = page.getByRole("link", { name: "Back to Administration" });
      await expect(back, `${destination} offers the way back`).toBeVisible();
      await back.click();
      await expect(page).toHaveURL(/\/admin$/);
    }
  });
});

test.describe("the Development block", () => {
  test.use({ storageState: ADMIN_STATE });

  test("is a block of its own, beside Testing", async ({ page }) => {
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: /^Testing · \d+$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Development · \d+$/ }),
    ).toBeVisible();
  });

  test("asks for project, issues, role and members — issues follow the project", async ({
    page,
  }) => {
    await page.goto("/admin");

    const block = page
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: /^Development · / }) });
    await block.getByRole("button", { name: "Add members" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    /* All four fields, each of them typed into and picked from, and the issue
       list withheld until a project names it. */
    for (const field of [
      "#roster-project",
      "#roster-role",
      "#team-search",
    ] as const) {
      await expect(dialog.locator(field)).toBeVisible();
    }
    await expect(dialog.getByText(/Choose a project first/i)).toBeVisible();

    /*
     * The projects come from the field itself, not from a query of our own.
     * Other specs in this suite create and archive projects while this one
     * runs, so a project read from the database is not necessarily one the
     * control is offering by the time we choose it.
     *
     * Each field's options are addressed through its own listbox. Several
     * fields can have one open at a time, and `getByRole("option")` across the
     * dialog would mix an issue into the list of projects.
     */
    const optionsOf = (field: string) =>
      dialog.locator(`#${field}-options`).getByRole("option");

    const project = dialog.locator("#roster-project");
    await project.click();
    const offered = await optionsOf("roster-project").allInnerTexts();
    expect(offered.length).toBeGreaterThan(1);

    /* The first project that actually has issues. An empty one says so rather
       than listing another project's work. */
    let key: string | null = null;
    for (let index = 0; index < offered.length; index += 1) {
      await project.click();
      await optionsOf("roster-project").nth(index).click();

      /* The issues are fetched when the project is chosen, so the field
         appears after the round trip — "Loading issues…" stands in its place
         until then. */
      const issues = dialog.locator("#roster-issues");
      try {
        await expect(issues).toBeVisible({ timeout: 10_000 });
      } catch {
        continue; // This project has none; it says so instead.
      }

      await issues.click();
      const rows = await optionsOf("roster-issues").allInnerTexts();
      if (rows.length === 0) {
        await page.keyboard.press("Escape");
        continue;
      }

      // Every issue offered belongs to the chosen project: the label reads
      // "KEY-N — Summary", so the prefix is that project's key.
      key = rows[0]!.split("-")[0]!.trim();
      for (const row of rows) expect(row.trim().startsWith(key)).toBe(true);

      // Choosing one gives it a chip…
      await optionsOf("roster-issues").first().click();
      await expect(dialog.getByText(/^Issues · 1$/)).toBeVisible();
      break;
    }
    expect(key, "no project offered any issues").not.toBeNull();

    /* …and changing the project does not carry it over. */
    await project.click();
    const projects = optionsOf("roster-project");
    await projects.nth((await projects.count()) - 1).click();
    await expect(dialog.getByText(/^Issues · 1$/)).toHaveCount(0);
  });

  test("Assign stays disabled until a project and a person are chosen", async ({
    page,
  }) => {
    await page.goto("/admin");

    const block = page
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: /^Development · / }) });
    await block.getByRole("button", { name: "Add members" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Assign" })).toBeDisabled();
  });
});

test.describe("the Testing block", () => {
  test.use({ storageState: ADMIN_STATE });

  test("asks for a project and takes several people at once", async ({
    page,
  }) => {
    await page.goto("/admin");

    const block = page
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: /^Testing · / }) });
    await block.getByRole("button", { name: "Add members" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("#roster-project")).toBeVisible();
    await expect(dialog.locator("#team-search")).toBeVisible();

    /* Not the Development dialog: no issues, no role. */
    await expect(dialog.locator("#roster-role")).toHaveCount(0);
    await expect(dialog.locator("#roster-issues")).toHaveCount(0);

    // Several people, one after another, each staying as a chip.
    await dialog.locator("#team-search").click();
    await dialog.getByRole("option").first().click();
    await dialog.locator("#team-search").click();
    if ((await dialog.getByRole("option").count()) > 0) {
      await dialog.getByRole("option").first().click();
    }

    await expect(dialog.getByText(/^Members · [12]$/)).toBeVisible();
  });
});

test.describe("a roster member's profile", () => {
  test.use({ storageState: ADMIN_STATE });

  test.beforeAll(async () => {
    await prisma.teamMember.upsert({
      where: {
        teamId_userId: {
          teamId: await teamId(DEVELOPMENT_TEAM_SLUG),
          userId: await memberId(),
        },
      },
      update: {},
      create: {
        teamId: await teamId(DEVELOPMENT_TEAM_SLUG),
        userId: await memberId(),
      },
    });
  });

  test.afterAll(async () => {
    await prisma.teamMember.deleteMany({
      where: {
        teamId: await teamId(DEVELOPMENT_TEAM_SLUG),
        userId: await memberId(),
      },
    });
  });

  test("shows name, role, project and work, and each issue opens", async ({
    page,
  }) => {
    await page.goto("/admin");

    const block = page
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: /^Development · / }) });

    await block.getByRole("button", { name: /^Profile of / }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Assigned project")).toBeVisible();
    await expect(dialog.getByText(/^Assigned work · \d+$/)).toBeVisible();
    await expect(dialog.locator(".prio-rolebadge")).toBeVisible();

    const issue = dialog
      .locator('a[href^="/issues/"]')
      .first();

    if ((await issue.count()) > 0) {
      const href = await issue.getAttribute("href");
      await issue.click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      /* The ordinary issue page, not a second copy of it. */
      await expect(page.locator(".prio-issue")).toBeVisible();
    }
  });
});

test.describe("a QA member and sprints", () => {
  test.use({ storageState: MEMBER_STATE });

  test.beforeAll(async () => {
    await prisma.teamMember.upsert({
      where: {
        teamId_userId: {
          teamId: await teamId(TESTING_TEAM_SLUG),
          userId: await memberId(),
        },
      },
      update: {},
      create: {
        teamId: await teamId(TESTING_TEAM_SLUG),
        userId: await memberId(),
      },
    });
  });

  test.afterAll(async () => {
    await prisma.teamMember.deleteMany({
      where: {
        teamId: await teamId(TESTING_TEAM_SLUG),
        userId: await memberId(),
      },
    });
  });

  test("is named a QA member, top right", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.locator(".prio-dash__heroaside .prio-rolebadge"),
    ).toHaveText("QA member");
  });

  test("gets no Sprints tab, and the route turns them away", async ({
    page,
  }) => {
    const project = await prisma.project.findFirstOrThrow({
      where: {
        isArchived: false,
        members: { some: { userId: await memberId() } },
      },
      select: { key: true },
    });
    const base = `/projects/${project.key.toLowerCase()}`;

    await page.goto(`${base}/summary`);
    await expect(page.locator(".prio-projectnav")).toBeVisible();

    /* The other tabs are all there; Sprints is not one of them. */
    await expect(
      page.locator(".prio-projectnav__tab", { hasText: "Summary" }),
    ).toBeVisible();
    await expect(
      page.locator(".prio-projectnav__tab", { hasText: "Sprints" }),
    ).toHaveCount(0);

    /*
     * And a hidden link is not a check: the URL itself refuses.
     *
     * Asserted on what comes back rather than on a 404 status. The project
     * layout streams before the page calls `notFound()`, so the response has
     * already committed 200 by the time the refusal is decided. What the
     * reader gets is the not-found page and none of the sprint screen, which
     * is what being turned away means here.
     */
    await page.goto(`${base}/sprints`);
    await expect(page.locator(".prio-notfound")).toBeVisible();
    await expect(page.locator(".prio-sprints")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /new sprint/i }),
    ).toHaveCount(0);
  });
});
