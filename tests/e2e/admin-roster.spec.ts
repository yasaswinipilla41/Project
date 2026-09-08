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
     * Projects, Issues and Bugs leave the page; Users points at the People
     * section on it, because that section is the users screen.
     */
    for (const destination of ["/projects", "/issues", "/bugs"] as const) {
      await page.goto("/admin");
      const tile = page.locator(`.prio-stat[href="${destination}"]`);
      await expect(tile).toHaveCount(1);
      await tile.click();
      await expect(page).toHaveURL(new RegExp(`${destination}(\\?|$)`));
    }

    await page.goto("/admin");
    await expect(page.locator('.prio-stat[href="/admin#people"]')).toHaveCount(1);
    await expect(page.locator("#people")).toBeAttached();
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

    /* All four fields, and the issue list withheld until a project names it. */
    await expect(dialog.getByLabel("Project")).toBeVisible();
    await expect(dialog.getByLabel("Role")).toBeVisible();
    await expect(dialog.getByLabel(/^Members/)).toBeVisible();
    await expect(
      dialog.getByText(/Choose a project first/i),
    ).toBeVisible();

    /*
     * The projects come from the dropdown itself, not from a query of our own.
     * Other specs in this suite create and archive projects while this one
     * runs, so a project id read from the database is not necessarily one the
     * rendered <select> is offering by the time we choose it. Reading the
     * options is also closer to what is being tested: that the list an
     * administrator is actually shown behaves.
     */
    const select = dialog.getByLabel("Project");
    const values = (await select.locator("option").evaluateAll((nodes) =>
      nodes
        .map((n) => ({
          value: (n as HTMLOptionElement).value,
          label: n.textContent ?? "",
        }))
        .filter((o) => o.value !== ""),
    )) as { value: string; label: string }[];

    expect(values.length).toBeGreaterThan(1);

    const issueList = dialog.locator(".prio-memberpicker").first();

    /* The first project that actually has issues. An empty one says so rather
       than listing another project's work, which is checked further down. */
    let chosen: { value: string; label: string } | null = null;
    for (const option of values) {
      await select.selectOption(option.value);
      const row = issueList.locator(".prio-memberrow").first();
      try {
        await expect(row).toBeVisible({ timeout: 8_000 });
        chosen = option;
        break;
      } catch {
        // No issues in this project; try the next.
      }
    }
    expect(chosen, "no project in the dropdown had any issues").not.toBeNull();

    /* Every listed issue carries the chosen project's key — the label reads
       "KEY — Name", so the prefix is the key. */
    const key = chosen!.label.split("—")[0]!.trim();
    const listed = await issueList
      .locator(".prio-memberpicker__name")
      .allTextContents();
    expect(listed.length).toBeGreaterThan(0);
    for (const text of listed) expect(text.trim().startsWith(key)).toBe(true);

    /* Choosing one, then changing the project, must not carry it over. */
    await issueList.locator(".prio-memberrow").first().click();
    await expect(dialog.getByText(/^Issues · 1$/)).toBeVisible();

    const other = values.find((o) => o.value !== chosen!.value)!;
    await select.selectOption(other.value);
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
    await expect(dialog.getByLabel("Project")).toBeVisible();
    await expect(dialog.getByLabel(/^Members/)).toBeVisible();

    /* Not the Developer dialog: no issues, no role. */
    await expect(dialog.getByLabel("Role")).toHaveCount(0);

    const people = dialog.locator(".prio-memberpicker .prio-memberrow");
    await expect(people.first()).toBeVisible();

    await people.nth(0).click();
    if ((await people.count()) > 1) await people.nth(1).click();

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
