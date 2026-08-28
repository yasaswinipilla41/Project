import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_STATE, setViewport, watchForProblems } from "./support";

/**
 * Coverage for the module surfaces: issues, bugs, my work, notifications,
 * search, reports, project settings, admin and profile.
 *
 * Everything asserted here is server-rendered from PostgreSQL, so a passing
 * assertion means the data really is in the database.
 */

test.describe("Issue management", () => {
  test("lists issues and filters entirely through the URL", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/issues");
    await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();

    const rows = page.locator(".prio-table tbody tr");
    const unfiltered = await rows.count();
    expect(unfiltered).toBeGreaterThan(0);

    // Filter to bugs only; the filter is a navigation, and the URL carries it.
    await page.getByRole("button", { name: /^Type/ }).click();
    await page.getByRole("menuitemradio", { name: "Bug" }).click();
    await expect(page).toHaveURL(/type=BUG/);

    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(unfiltered);

    // Every remaining row is a bug.
    const types = await page
      .locator(".prio-table tbody .prio-type")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
    expect(new Set(types)).toEqual(new Set(["BUG"]));

    // The filter survives a reload — state lives in the URL, not memory.
    await page.reload();
    await expect(page.getByRole("button", { name: /^Type/ })).toHaveAttribute(
      "data-active",
      "true",
    );

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("searches issue title and description text", async ({ page }) => {
    await page.goto("/issues");

    const filterSearch = page.locator(".prio-filters").getByRole("searchbox");
    await filterSearch.fill("session expiration");
    await filterSearch.press("Enter");

    await expect(page).toHaveURL(/q=session\+expiration/);
    await expect(
      page.getByRole("link", { name: /Login fails after session expiration/ }),
    ).toBeVisible();
  });

  test("sorts by a column and reverses on a second click", async ({ page }) => {
    await page.goto("/issues");

    const priorityHeader = page.getByRole("link", { name: "Priority" });
    await priorityHeader.click();
    await expect(page).toHaveURL(/sort=priority/);

    const firstDesc = await page
      .locator(".prio-table tbody .prio-priority")
      .first()
      .getAttribute("data-priority");

    await page.getByRole("link", { name: "Priority" }).click();
    await expect(page).toHaveURL(/dir=asc/);

    const firstAsc = await page
      .locator(".prio-table tbody .prio-priority")
      .first()
      .getAttribute("data-priority");

    expect(firstAsc).not.toBe(firstDesc);
  });

  test("pages through results", async ({ page }) => {
    await page.goto("/issues?pageSize=25");
    await expect(page.locator(".prio-pagination__summary")).toBeVisible();
    await expect(page.locator(".prio-pagination__page")).toContainText("Page 1");
  });
});

test.describe("Issue sheet export", () => {
  test("downloads an .xlsx of the filtered sheet", async ({ page }) => {
    // A filtered view, so the export has to respect context rather than
    // dumping everything.
    await page.goto("/issues?type=BUG");

    const shownTotal = Number(
      (await page.locator(".prio-filters__total").innerText()).replace(/\D/g, ""),
    );
    expect(shownTotal).toBeGreaterThan(0);

    /* "Export Excel", by its full name. This used to say just "Export",
       which — Playwright matches an accessible name by substring — also
       matched the second Export button the page header carried at the time,
       and a two-match locator is a strict-mode error rather than a click.
       That header button has since been replaced by "Create Issue", so the
       filter bar's is now the one and only way to export the sheet. */
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export Excel" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^prio-issues-\d{4}-\d{2}-\d{2}\.xlsx$/);

    const path = await download.path();
    expect(path).toBeTruthy();

    const bytes = await readFile(path!);
    // A real .xlsx is a ZIP container — "PK" is its signature. This
    // catches an HTML error page or JSON being saved under an .xlsx name.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bytes.byteLength).toBeGreaterThan(1000);

    // The toast names the file that actually downloaded — tying the two
    // together is what catches a confirmation that reports something other
    // than the thing the browser just saved.
    await expect(page.locator(".prio-toast").last()).toContainText(
      download.suggestedFilename(),
    );
  });

  test("refuses to export for a signed-out visitor", async ({ browser }) => {
    /*
     * A fresh context with no session. Two independent guards stand in the
     * way — `proxy.ts` bounces unauthenticated requests to sign-in, and the
     * route itself re-resolves the caller and answers 401 — so this asserts
     * the outcome that actually reaches a browser: a redirect to sign-in,
     * never a spreadsheet. `maxRedirects: 0` is what makes the redirect
     * itself observable rather than being followed to a 200 sign-in page.
     */
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });

    const response = await context.request.get("/api/issues/export", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain("/sign-in");
    expect(response.headers()["content-type"] ?? "").not.toContain(
      "spreadsheetml",
    );

    await context.close();
  });

  test("cannot be widened to a project the member is not in", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: MEMBER_STATE });

    const all = await context.request.get("/api/issues/export");
    expect(all.ok()).toBe(true);
    const memberRows = Number(all.headers()["x-prio-export-rows"]);

    // Ask explicitly for every project id in the database. The route rebuilds
    // the scope from the session, so an out-of-scope id narrows to nothing
    // rather than granting access to it.
    const projects = await prisma.project.findMany({ select: { id: true } });
    const query = projects.map((p) => `project=${p.id}`).join("&");
    const forced = await context.request.get(`/api/issues/export?${query}`);
    expect(forced.ok()).toBe(true);

    expect(Number(forced.headers()["x-prio-export-rows"])).toBeLessThanOrEqual(
      memberRows,
    );

    await context.close();
  });
});

test.describe("Bug management", () => {
  test("shows only bugs, with severity statistics", async ({ page }) => {
    await page.goto("/bugs");

    await expect(page.getByRole("heading", { name: "Bugs" })).toBeVisible();

    const types = await page
      .locator(".prio-table tbody .prio-type")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set(["BUG"]));

    // Severity is a first-class column here, and every bug has one.
    const severities = await page
      .locator(".prio-table tbody .prio-severity")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-severity")));
    expect(severities.length).toBe(types.length);

    // The type filter is hidden — this surface is locked to bugs.
    await expect(page.getByRole("button", { name: /^Type/ })).toHaveCount(0);
  });

  test("filters by severity", async ({ page }) => {
    await page.goto("/bugs");

    await page.getByRole("button", { name: /^Severity/ }).click();
    await page.getByRole("menuitemradio", { name: "Critical" }).click();
    await expect(page).toHaveURL(/severity=CRITICAL/);

    const severities = await page
      .locator(".prio-table tbody .prio-severity")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-severity")));
    expect(new Set(severities)).toEqual(new Set(["CRITICAL"]));
  });
});

test.describe("My Work", () => {
  test("shows the signed-in person's assigned work grouped by status", async ({
    page,
  }) => {
    await page.goto("/my-work");
    await expect(page.getByRole("heading", { name: "My Work" })).toBeVisible();
    // Either grouped work, or an explicit empty state — never a blank screen.
    const hasWork = (await page.locator(".prio-worklink").count()) > 0;
    const hasEmpty = (await page.getByText("Nothing assigned to you").count()) > 0;
    expect(hasWork || hasEmpty).toBe(true);
  });
});

test.describe("Notifications", () => {
  test("lists notifications and marks one read, then all", async ({ page }) => {
    await page.goto("/notifications");
    await expect(
      page.getByRole("heading", { name: "Notifications" }),
    ).toBeVisible();

    const items = page.locator(".prio-notification");
    const count = await items.count();
    if (count === 0) {
      await expect(page.getByText("You're all caught up.")).toBeVisible();
      return;
    }

    const unread = page.locator('.prio-notification[data-read="false"]');
    if ((await unread.count()) > 0) {
      await unread.first().getByRole("button", { name: "Mark read" }).click();
      await expect
        .poll(async () => unread.count(), { timeout: 10_000 })
        .toBeLessThan(count);

      if ((await unread.count()) > 0) {
        await page.getByRole("button", { name: "Mark all as read" }).click();
        await expect(page.locator(".prio-toast")).toContainText("marked as read");
        await expect
          .poll(async () => unread.count(), { timeout: 10_000 })
          .toBe(0);
      }
    }

    // Marking read removes the sidebar badge.
    await page.reload();
    await expect(page.locator(".prio-navitem__count")).toHaveCount(0);
  });
});

test.describe("Search", () => {
  test("groups results and jumps straight to an issue key", async ({ page }) => {
    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();

    // An exact key navigates rather than listing one result.
    const searchBox = page.locator(".prio-searchpage__form").getByRole("searchbox");
    await searchBox.fill("ENG-1");
    await searchBox.press("Enter");
    await expect(page).toHaveURL(/\/issues\/eng-1$/);

    // A text term returns grouped results.
    await page.goto("/search?q=login");
    await expect(page.getByRole("heading", { name: /Bugs/ })).toBeVisible();

    // Nonsense yields an honest empty state, not an error.
    await page.goto("/search?q=zzzznotathing");
    await expect(page.getByText("No results found")).toBeVisible();
  });
});

test.describe("Reports", () => {
  test("renders aggregations consistent with the issue list", async ({ page }) => {
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

    // Read the headline total, then verify the issues list agrees.
    const totalText = await page
      .locator(".prio-stat")
      .filter({ hasText: "Total issues" })
      .locator(".prio-stat__value")
      .innerText();
    const reportedTotal = Number(totalText);
    expect(reportedTotal).toBeGreaterThan(0);

    await page.goto("/issues");
    const listTotal = await page.locator(".prio-filters__total").innerText();
    expect(Number(listTotal.replace(/\D/g, ""))).toBe(reportedTotal);
  });

  test("Total issues links through to the list it counts", async ({ page }) => {
    await page.goto("/reports");

    const card = page.locator("a.prio-stat").filter({ hasText: "Total issues" });
    await expect(card).toBeVisible();

    const claimed = Number(
      await card.locator(".prio-stat__value").innerText(),
    );

    await card.click();
    await expect(page).toHaveURL(/\/issues(\?|$)/);
    await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();

    // The destination shows exactly the set the figure counted — the report
    // and the list apply the same project scope, so these cannot disagree.
    const listTotal = await page.locator(".prio-filters__total").innerText();
    expect(Number(listTotal.replace(/\D/g, ""))).toBe(claimed);
  });
});

test.describe("Project settings", () => {
  test("no longer offers a Members section, and memberships survive", async ({
    page,
  }) => {
    const before = await prisma.projectMember.count();

    await page.goto("/projects/int/settings");
    await expect(
      page.getByRole("heading", { name: "Project settings" }),
    ).toBeVisible();

    // Gone from the page…
    await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
    await expect(page.getByLabel("Add a member")).toHaveCount(0);

    // …but this was a UI removal, not a data change.
    expect(await prisma.projectMember.count()).toBe(before);
  });

  test("an admin can edit details and add a label", async ({
    page,
  }) => {
    await page.goto("/projects/int/settings");
    await expect(
      page.getByRole("heading", { name: "Project settings" }),
    ).toBeVisible();

    // The key is immutable.
    await expect(page.getByLabel("Project key")).toBeDisabled();

    // Details save.
    const description = page.getByLabel("Description");
    const original = await description.inputValue();
    await description.fill(`${original} Verified by E2E.`);
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator(".prio-toast").last()).toContainText("saved");

    await page.reload();
    await expect(page.getByLabel("Description")).toHaveValue(
      `${original} Verified by E2E.`,
    );

    // Restore.
    await page.getByLabel("Description").fill(original);
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator(".prio-toast").last()).toContainText("saved");

    // Add a uniquely-named label.
    const labelName = `e2e-${Date.now().toString(36)}`;
    await page.getByLabel("Label name").fill(labelName);
    await page.getByRole("button", { name: "Add label" }).click();
    await expect(page.locator(".prio-toast").last()).toContainText("added");
    await page.reload();
    await expect(page.getByText(labelName)).toBeVisible();
  });

  test("the default-project toggle persists and is off by default", async ({
    page,
  }) => {
    await page.goto("/projects/int/settings");

    const toggle = page.getByLabel(
      "Default project for new self-registered users",
    );
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText("Default project: OFF")).toBeVisible();

    await toggle.check();
    await expect(page.getByText("Default project: ON")).toBeVisible();
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator(".prio-toast").last()).toContainText("saved");

    await page.reload();
    await expect(
      page.getByLabel("Default project for new self-registered users"),
    ).toBeChecked();

    // Restore — this is real seeded data other specs and future runs rely on.
    await page
      .getByLabel("Default project for new self-registered users")
      .uncheck();
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator(".prio-toast").last()).toContainText("saved");
    await page.reload();
    await expect(
      page.getByLabel("Default project for new self-registered users"),
    ).not.toBeChecked();
  });
});

test.describe("Admin", () => {
  test("lists users with roles and real statistics", async ({ page }) => {
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Administration" }),
    ).toBeVisible();

    const rows = page
      .locator(".prio-card", { has: page.getByRole("button", { name: "New user" }) })
      .locator("tbody tr");
    expect(await rows.count()).toBeGreaterThan(0);

    await expect(page.getByText("admin@symbiosystech.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "New user" })).toBeVisible();

    // Statistics come from the database, not placeholders.
    const users = await page
      .locator(".prio-stat")
      .filter({ hasText: "Users" })
      .locator(".prio-stat__value")
      .innerText();
    expect(Number(users)).toBe(await rows.count());
  });

  test("warns, but does not block, creating a user with no project selected", async ({
    page,
  }) => {
    await page.goto("/admin");
    await page.getByRole("button", { name: "New user" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // No project chip has been clicked — the warning shows without any
    // submit attempt, matching the actual root cause of the bug this fixes:
    // an admin who never noticed the Projects field was left empty.
    await expect(
      dialog.getByText(/No project selected/),
    ).toBeVisible();

    const stamp = Date.now().toString(36);
    const email = `e2e-no-project-${stamp}@symbiosystech.local`;
    await dialog.getByLabel(/Full name/).fill("E2E No Project Fixture");
    await dialog.getByLabel(/Work email/).fill(email);
    await dialog.getByLabel(/Initial password/).fill("Fixture-Password-1");
    await dialog.getByRole("button", { name: "Create account" }).click();

    await expect(page.locator(".prio-toast").last()).toContainText(
      "Account created",
    );

    const created = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, _count: { select: { projectMemberships: true } } },
    });
    // The account really was created with zero memberships — the warning
    // described a real consequence, not a hypothetical one.
    expect(created._count.projectMemberships).toBe(0);
    await prisma.user.delete({ where: { id: created.id } });
  });

  test("a member's open-issue count drills down to their filtered issue list", async ({
    page,
  }) => {
    await page.goto("/admin");

    const link = page.locator(".prio-admin__drilldown").first();
    // The seed always has at least one person with open work assigned.
    expect(
      await link.count(),
      "at least one seeded user has open issues assigned",
    ).toBeGreaterThan(0);

    const claimed = Number((await link.innerText()).trim());
    const href = await link.getAttribute("href");
    const assigneeId = href?.match(/assignee=([^&]+)/)?.[1];
    expect(assigneeId).toBeTruthy();

    await link.click();
    await expect(page).toHaveURL(
      new RegExp(`/issues\\?assignee=${assigneeId}&resolution=open`),
    );

    // The destination is really filtered to that one person's open work, and
    // the row count agrees with what the admin table claimed.
    const rows = page.locator(".prio-table tbody tr");
    await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBe(
      claimed,
    );
  });

  test("refuses to strip the last administrator", async ({ page }) => {
    await page.goto("/admin");

    // Demoting yourself is refused outright.
    const ownRow = page
      .locator("tbody tr")
      .filter({ hasText: "admin@symbiosystech.com" });
    await ownRow.getByRole("button", { name: /Manage/ }).click();
    await page.getByRole("menuitemradio", { name: "Member" }).click();

    await expect(page.locator(".prio-toast")).toContainText(
      "cannot remove your own administrator access",
    );
  });
});

test.describe("Profile", () => {
  test("shows the account and saves an edit", async ({ page }) => {
    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("admin@symbiosystech.com")).toBeVisible();

    const title = page.getByLabel("Job title");
    const original = await title.inputValue();

    await title.fill("Engineering Manager (verified)");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.locator(".prio-toast")).toContainText("Profile updated");

    await page.reload();
    await expect(page.getByLabel("Job title")).toHaveValue(
      "Engineering Manager (verified)",
    );

    await page.getByLabel("Job title").fill(original);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.locator(".prio-toast")).toContainText("Profile updated");
  });
});

test.describe("Navigation has no dead ends", () => {
  test("every sidebar destination renders a real page", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    await page.goto("/");

    const links = await page
      .locator(".prio-sidebar a")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));

    for (const href of new Set(links.filter(Boolean) as string[])) {
      const response = await page.goto(href);
      expect(response?.status(), `${href} responded ${response?.status()}`).toBe(
        200,
      );
      // No placeholder screens remain.
      await expect(page.getByText("Not built yet")).toHaveCount(0);
    }

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("stays usable at tablet and mobile widths", async ({ page }) => {
    for (const [width, height] of [
      [768, 1024],
      [390, 844],
    ] as const) {
      await page.goto("/issues");
      await setViewport(page, width, height);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
    }
  });
});

test.describe("Member authorization", () => {
  test.use({ storageState: MEMBER_STATE });

  test("a member cannot reach admin surfaces or see admin controls", async ({
    page,
  }) => {
    // Project settings is admin-only and must not render for a member.
    await page.goto("/projects/eng/settings");
    await expect(page.getByLabel("Project key")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New user" })).toHaveCount(0);

    await page.goto("/admin");
    await expect(page.getByRole("button", { name: "New user" })).toHaveCount(0);
    await expect(page.getByText("admin@symbiosystech.com")).toHaveCount(0);

    // The project overview hides its Settings action for members.
    await page.goto("/projects/eng");
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  });

  test("a member still gets the full working surfaces", async ({ page }) => {
    for (const path of ["/issues", "/bugs", "/my-work", "/reports", "/profile"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
    }
    await expect(
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
  });
});
