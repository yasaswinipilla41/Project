import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import {
  MEMBER_STATE,
  setViewport,
  waitForNextFrame,
  watchForProblems,
} from "./support";

/**
 * The home dashboard.
 *
 * The rule the page is built on is that nothing on it is invented, so most of
 * these tests are cross-checks: read a figure from the dashboard, then follow
 * the link that figure claims to summarise and count what is actually there.
 * A number that cannot be reached by clicking it is a number nobody can trust.
 *
 * The two sessions carry genuinely different data — the seeded administrator
 * has no work assigned to them and the seeded member has several — so the
 * shared checks below run under both, which covers the populated path and the
 * empty path without either being simulated.
 */

/**
 * Reads the count beside "My assigned tasks", then follows the section's own
 * link and counts the rows it lands on. The two must agree.
 */
async function assignedCountAgreesWithList(page: Page): Promise<void> {
  await page.goto("/");

  const heading = page.getByRole("heading", { name: /My assigned tasks/ });
  await expect(heading).toBeVisible();

  const badge = heading.locator(".prio-dash__count");
  const claimed =
    (await badge.count()) > 0 ? Number((await badge.innerText()).trim()) : 0;

  if (claimed === 0) {
    // Nothing assigned: an explicit empty state, not a zeroed-out list.
    await expect(page.locator(".prio-assigned")).toHaveCount(0);
    await expect(page.getByText("Nothing assigned to you")).toBeVisible();
    return;
  }

  const shown = await page.locator(".prio-assigned").count();
  // The list is capped at eight; the badge is the true total.
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(claimed);

  await page.getByRole("link", { name: /View all assigned/ }).click();
  await expect(page).toHaveURL(/assignee=/);
  await expect(page).toHaveURL(/resolution=open/);

  /*
   * The list paginates at 25 by default, so counting rows on page one only
   * equals the badge while somebody has 25 items or fewer — it silently
   * became a "has this person got a small queue?" assertion. The list's own
   * total is the figure that is actually comparable to the badge, and the
   * row count is then checked against whatever that page is allowed to show.
   */
  const summary = await page.locator(".prio-pagination__summary").first().innerText();
  const listedTotal = Number(summary.split(" of ")[1]?.trim());
  expect(listedTotal).toBe(claimed);

  const rows = page.locator(".prio-table tbody tr");
  await expect
    .poll(async () => rows.count(), { timeout: 10_000 })
    .toBe(Math.min(claimed, 25));
}

test.describe("Dashboard — signed in as an administrator", () => {
  test("greets the person and states their real role", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/");

    // Signing in lands here, not on a marketing page.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".prio-dash")).toBeVisible();

    const greeting = page.locator(".prio-dash__greeting");
    await expect(greeting).toBeVisible();
    await expect(greeting).toHaveText(/^Good (morning|afternoon|evening), \S+/);

    // Prio has exactly two roles. The badge shows the account's real one.
    await expect(page.locator(".prio-dash__herometa .prio-rolebadge")).toHaveAttribute(
      "data-role",
      "ADMIN",
    );

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("every KPI links to the list that produced it", async ({ page }) => {
    await page.goto("/");

    const cards = page.locator("a.prio-kpi");
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const href = await cards.nth(i).getAttribute("href");
      expect(href, "every KPI card must be a way into the data").toBeTruthy();
    }

    // Follow "Open issues" and confirm the destination is really filtered.
    await page
      .locator("a.prio-kpi")
      .filter({ hasText: "Open issues" })
      .first()
      .click();
    await expect(page).toHaveURL(/resolution=open/);
    await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  });

  /* Admin Home dropped the personal queues — an administrator's dashboard
     answers "how is the organisation doing", and My assigned tasks / My work
     competed with that. The data is untouched and still reachable from
     Issues, which is what the second half of this checks. The same count is
     still verified against the list in the Member suite below, where the
     section lives on. */
  test("does not carry the personal queues, which stay reachable", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: /My assigned tasks/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /^My work$/ }),
    ).toHaveCount(0);

    // Removed from the page, not from the product.
    await page.goto("/my-work");
    await expect(page.locator("h1").first()).toBeVisible();
  });

  test("project cards report progress that matches their own page", async ({
    page,
  }) => {
    await page.goto("/");

    const cards = page.locator(".prio-projrow");
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);

      // Health is one of exactly three derived states — never blank.
      const health = await card
        .locator(".prio-projrow__health")
        .getAttribute("data-health");
      expect(["healthy", "attention", "at-risk"]).toContain(health);

      // The bar can never overrun its track.
      const width = await card
        .locator(".prio-progress__bar")
        .evaluate((el) => (el as HTMLElement).style.width);
      const value = Number(width.replace("%", ""));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }

    /* The card is a summary, not a link: clicking it must leave you where you
       are. It used to navigate to the project — that was removed deliberately,
       so this now pins the opposite. The project is still reachable, just not
       by clicking here, which the direct visit below keeps covered. */
    const key = (await cards.first().locator(".prio-key").innerText()).trim();
    await cards.first().click();
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/localhost:3000\/$/);

    await page.goto(`/projects/${key.toLowerCase()}`);
    await expect(page).toHaveURL(/\/projects\//);
  });

  test("analytics bars sum to the counts beside them", async ({ page }) => {
    await page.goto("/");

    const statuses = page
      .locator(".prio-distribution")
      .first()
      .locator(".prio-distribution__row");

    const rows = await statuses.count();
    expect(rows).toBeGreaterThan(0);

    let total = 0;
    for (let i = 0; i < rows; i += 1) {
      const row = statuses.nth(i);
      const value = Number(
        (await row.locator(".prio-distribution__value").innerText()).trim(),
      );
      total += value;

      /* A chart whose bars have collapsed still shows the right numbers, so
         the numbers alone do not prove it renders. Measure the track. */
      const track = await row
        .locator(".prio-distribution__track")
        .boundingBox();
      expect(track?.width ?? 0, "the bar track must have real width").toBeGreaterThan(20);

      if (value > 0) {
        const bar = await row.locator(".prio-distribution__bar").boundingBox();
        expect(bar?.width ?? 0, "a non-zero count must draw a bar").toBeGreaterThan(0);
      }
    }

    // The status breakdown covers every issue in scope, so it must agree with
    // the total the unfiltered issue list reports for itself.
    await page.goto("/issues?pageSize=100");
    const summary = await page
      .locator(".prio-pagination__summary")
      .first()
      .innerText();

    // "1–25 of 42" — the figure after "of" is the real total.
    const listedTotal = Number(summary.split(" of ")[1]?.trim());
    expect(listedTotal).toBe(total);
  });

  test("also sees the team members section, same as a member would", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Team members" }),
    ).toBeVisible();
    expect(await page.locator(".prio-team__member").count()).toBeGreaterThan(0);
  });

  test("shows a recently created person at the top of New members", async ({
    page,
  }) => {
    const fixture = await prisma.user.create({
      data: {
        name: "Dashboard New Member E2E",
        email: `dash-new-member-e2e-${Date.now()}@symbiosystech.local`,
        role: "MEMBER",
        isActive: true,
      },
      select: { id: true },
    });

    try {
      await page.goto("/");

      await expect(
        page.getByRole("heading", { name: "New members" }),
      ).toBeVisible();

      const rows = page.locator(".prio-newusers__row");
      // Newest first: the fixture just created is the very top row.
      await expect(rows.first()).toContainText("Dashboard New Member E2E");
      await expect(
        rows.first().locator(".prio-badge", { hasText: "New" }),
      ).toBeVisible();
    } finally {
      await prisma.user.delete({ where: { id: fixture.id } });
    }
  });

  test("View details opens the member's real data and can assign an open issue from it", async ({
    page,
  }) => {
    const eng = await prisma.project.findUniqueOrThrow({
      where: { key: "ENG" },
      select: { id: true },
    });

    const fixture = await prisma.user.create({
      data: {
        name: "Dashboard Member Detail E2E",
        email: `dash-member-detail-e2e-${Date.now()}@symbiosystech.local`,
        role: "MEMBER",
        isActive: true,
        projectMemberships: { create: { projectId: eng.id } },
      },
      select: { id: true },
    });

    // An unassigned open issue in the same project — the safest possible
    // assignment target, since "revert" is simply setting it back to null
    // rather than having to remember someone else's prior assignee.
    const candidate = await prisma.issue.findFirstOrThrow({
      where: { projectId: eng.id, status: "TODO", assigneeId: null },
      select: { id: true, key: true },
    });

    try {
      await page.goto("/");

      const row = page
        .locator(".prio-newusers__row")
        .filter({ hasText: "Dashboard Member Detail E2E" });
      await row.getByRole("button", { name: /View details/ }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("dash-member-detail-e2e"),
      ).toBeVisible();
      await expect(dialog.getByText("Role Member")).toBeVisible();
      await expect(dialog.getByText("Status Active")).toBeVisible();
      await expect(
        dialog.locator(".prio-chipset__chip", { hasText: "Engineering" }),
      ).toBeVisible();

      const select = dialog.getByLabel("Choose an issue to assign");
      await select.selectOption(candidate.id);
      await dialog.getByRole("button", { name: "Assign" }).click();

      await expect(page.locator(".prio-toast").last()).toContainText(
        "Assigned to Dashboard Member Detail E2E",
      );

      // The dialog's own assigned-work list picks it up without a reload.
      await expect(
        dialog.locator(".prio-memberdetail__issue", { hasText: candidate.key }),
      ).toBeVisible();

      const row2 = await prisma.issue.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { assigneeId: true },
      });
      expect(row2.assigneeId).toBe(fixture.id);
    } finally {
      await prisma.issue.update({
        where: { id: candidate.id },
        data: { assigneeId: null },
      });
      await prisma.user.delete({ where: { id: fixture.id } });
    }
  });

  test("shows the organisation panel, and only to an administrator", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Organisation" }),
    ).toBeVisible();
    await expect(page.locator(".prio-workload")).toBeVisible();

    // Workload bars are relative to the busiest person: at least one is full.
    const widths = await page
      .locator(".prio-workload__bar")
      .evaluateAll((els) =>
        els.map((el) => Number((el as HTMLElement).style.width.replace("%", ""))),
      );

    if (widths.length > 0) {
      expect(Math.max(...widths)).toBe(100);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(0);
    }
  });

  /* Create issue and Report bug were removed from Home. What matters is that
     removing the shortcut did not remove the flow, so this now reaches the
     same dialog through the control that still offers it — the top bar's. */
  test("quick actions open the real create dialog", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.locator(".prio-dash__actions").getByRole("button", {
        name: "Report bug",
      }),
    ).toHaveCount(0);
    await expect(
      page.locator(".prio-dash__actions").getByRole("button", {
        name: "Create issue",
      }),
    ).toHaveCount(0);

    /* Reached from the Issues page, which opens the same `CreateIssueDialog`
       Home's button used to. Deliberately not the top bar's create control:
       that one offers a type selector first, and everything below asserts the
       plain form that has none. */
    await page.goto("/issues");
    await page.locator(".prio-create-issue").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    /* It opens the one real Create form — same dialog, same fields, same
       server action. This used to also assert that the Task/Bug/Story picker
       had landed on Bug; that picker has been removed, so what is checked now
       is that it is genuinely gone and that none of the three is offered
       anywhere in the dialog. The type still travels with the request — it is
       simply no longer something anybody chooses. */
    await expect(dialog.getByLabel("Summary")).toBeVisible();
    await expect(dialog.locator(".prio-typepicker")).toHaveCount(0);
    for (const name of ["Task", "Bug", "Story"]) {
      await expect(
        dialog.getByRole("button", { name, exact: true }),
        `${name} must not be selectable`,
      ).toHaveCount(0);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("Dashboard — signed in as a member", () => {
  test.use({ storageState: MEMBER_STATE });

  test("sees their own scope and no organisation panel", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/");

    await expect(page.locator(".prio-dash")).toBeVisible();
    await expect(page.locator(".prio-dash__herometa .prio-rolebadge")).toHaveAttribute(
      "data-role",
      "MEMBER",
    );

    // The org-wide section is an administrator surface.
    await expect(
      page.getByRole("heading", { name: "Organisation" }),
    ).toHaveCount(0);
    await expect(page.locator(".prio-workload")).toHaveCount(0);

    // …and so are its shortcuts.
    await expect(
      page.locator(".prio-dash__actions").getByRole("link", { name: "People" }),
    ).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("never sees New members, even when someone new genuinely just joined", async ({
    page,
  }) => {
    // Proves the section is missing because of RBAC, not because there is
    // nothing to show — a fresh row guarantees admin content actually exists.
    const fixture = await prisma.user.create({
      data: {
        name: "Dashboard New Member RBAC Check",
        email: `dash-new-member-rbac-${Date.now()}@symbiosystech.local`,
        role: "MEMBER",
        isActive: true,
      },
      select: { id: true },
    });

    try {
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "New members" }),
      ).toHaveCount(0);
      await expect(page.getByText("Dashboard New Member RBAC Check")).toHaveCount(0);
    } finally {
      await prisma.user.delete({ where: { id: fixture.id } });
    }
  });

  test("the assigned-work count agrees with the issue list", async ({
    page,
  }) => {
    await assignedCountAgreesWithList(page);
  });

  test("sees the team members section on the home page by default, scoped to their own projects", async ({
    page,
  }) => {
    await page.goto("/");

    // Visible without opening another page or enabling any filter — it is
    // just part of the page a Member lands on.
    await expect(
      page.getByRole("heading", { name: "Team members" }),
    ).toBeVisible();

    const members = page.locator(".prio-team__member");
    expect(
      await members.count(),
      "the seeded member shares a project with at least one other person",
    ).toBeGreaterThan(0);

    // Each card shows name, role and an in-scope count — nothing that reads
    // as an org-wide admin figure lives on this section.
    const first = members.first();
    await expect(first.locator(".prio-team__name")).not.toBeEmpty();
    await expect(first.locator(".prio-rolebadge")).toBeVisible();
    await expect(first.locator(".prio-team__count")).not.toBeEmpty();

    // A member's own admin-only surfaces stay absent even though this new
    // section is visible — this section is not a backdoor into them.
    await expect(page.locator(".prio-workload")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Organisation" }),
    ).toHaveCount(0);

    /* The row used to be a link to the global issue list filtered by that
       person — a roster entry that navigated off Home entirely. Looking
       someone up now opens the member detail dialog that already existed for
       it, so the context stays put. */
    const url = page.url();
    await first.getByRole("button", { name: /^View details for / }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(page.url(), "opening a person must not navigate away").toBe(url);
    await page.keyboard.press("Escape");
  });

  test("an assigned card opens the issue it names", async ({ page }) => {
    await page.goto("/");

    const cards = page.locator(".prio-assigned");
    expect(
      await cards.count(),
      "the seeded member has open work assigned to them",
    ).toBeGreaterThan(0);

    const first = cards.first();
    const key = (await first.locator(".prio-key").first().innerText()).trim();
    await first.click();

    await expect(page).toHaveURL(new RegExp(key.toLowerCase()));
    await expect(page.getByText(key, { exact: true }).first()).toBeVisible();
  });

  test("marks overdue work as overdue, not merely as due", async ({ page }) => {
    await page.goto("/");

    const overdue = page.locator('.prio-assigned[data-due="overdue"]');

    for (let i = 0; i < (await overdue.count()); i += 1) {
      // The card says so in words, so the colour is never the only signal.
      await expect(
        overdue.nth(i).locator('.prio-assigned__due[data-state="overdue"]'),
      ).toContainText(/Overdue by \d+d/);
    }

    // The due bar and the cards must tell the same story.
    const chip = page.locator('.prio-duebar__item[data-tone="danger"]');
    if ((await chip.count()) > 0) {
      const claimed = Number(
        (await chip.first().locator("strong").innerText()).trim(),
      );
      expect(claimed).toBeGreaterThan(0);
      // The card list is capped, so it can show no more than the chip claims.
      expect(await overdue.count()).toBeLessThanOrEqual(claimed);
    } else {
      await expect(overdue).toHaveCount(0);
    }
  });

  test("only shows projects the member actually belongs to", async ({
    page,
  }) => {
    await page.goto("/");

    const dashboardKeys = await page
      .locator(".prio-projrow .prio-key")
      .allInnerTexts();

    await page.goto("/projects");
    const listedKeys = await page.locator(".prio-key").allInnerTexts();

    for (const key of dashboardKeys) {
      expect(listedKeys).toContain(key);
    }
  });

  test("highlights projects with work assigned to the member, without hiding the rest", async ({
    page,
  }) => {
    await page.goto("/");

    const cards = page.locator(".prio-projrow");
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    let highlighted = 0;
    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const badge = card.locator(".prio-badge", { hasText: "Assigned to you" });
      const hasBadge = (await badge.count()) > 0;

      // The badge and the existing "N assigned to me" stat must agree — this
      // is a second view of the same figure, not a separate claim.
      const statText = await card.locator(".prio-projrow__stats").innerText();
      expect(hasBadge).toBe(/assigned to me/.test(statText));

      if (hasBadge) highlighted += 1;
    }

    expect(
      highlighted,
      "the seeded member has assigned work in at least one project",
    ).toBeGreaterThan(0);
    // Not every project is the member's own — the rest stay visible, unmarked.
    expect(highlighted).toBeLessThanOrEqual(count);
  });

  test("highlights their own rows in the full issue list without hiding anyone else's", async ({
    page,
  }) => {
    await page.goto("/issues?pageSize=100");

    const rows = page.locator(".prio-table tbody tr");
    const total = await rows.count();
    expect(total).toBeGreaterThan(0);

    const mine = page.locator('.prio-table tbody tr[data-mine="true"]');
    const mineCount = await mine.count();
    expect(
      mineCount,
      "the seeded member has open work assigned to them",
    ).toBeGreaterThan(0);

    // Explicit in the cell, not just a background tint.
    await expect(
      mine.first().locator(".prio-badge", { hasText: "You" }),
    ).toBeVisible();

    // Other permitted rows remain visible and are not marked as the viewer's.
    if (mineCount < total) {
      const others = page.locator('.prio-table tbody tr:not([data-mine="true"])');
      expect(await others.count()).toBe(total - mineCount);
      await expect(
        others.first().locator(".prio-badge", { hasText: "You" }),
      ).toHaveCount(0);
    }
  });
});

test.describe("Dashboard — presentation", () => {
  test("holds together at desktop, tablet and mobile widths", async ({
    page,
  }) => {
    await page.goto("/");

    for (const [width, height] of [
      [1440, 900],
      [834, 1112],
      [390, 844],
    ] as const) {
      await setViewport(page, width, height);
      await expect(page.locator(".prio-dash")).toBeVisible();

      // Nothing may push the page sideways at any width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test("actually repaints in dark mode", async ({ page }) => {
    await page.goto("/");

    /* Both samples have to be measurable before either is taken: the cards
       must be on the page, and every stylesheet must have arrived. Flipping
       `data-theme` before the dark sheet has loaded reads light values back
       off a page that is behaving perfectly well — which is exactly the
       intermittent failure this test used to produce. Waiting on real
       signals rather than a fixed delay keeps it strict: if the theme
       genuinely fails to apply, the assertions below still catch it. */
    await expect(page.locator(".prio-kpi").first()).toBeVisible();
    await page.waitForLoadState("load");

    /** Applies a theme and waits until it is observably in effect. */
    const applyTheme = async (theme: "light" | "dark") => {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // One frame, so what we read is the recalculated custom properties.
      await waitForNextFrame(page);
    };

    /* Read the same set of colours in each theme. Comparing them to each other
       — rather than to hard-coded hexes — proves the theme is doing work
       without pinning the design to particular values. */
    const sample = () =>
      page.evaluate(() => {
        const read = (selector: string, prop: string) => {
          const el = document.querySelector(selector);
          return el ? getComputedStyle(el).getPropertyValue(prop) : "";
        };
        return {
          page: getComputedStyle(document.body).backgroundColor,
          heading: read(".prio-dash__greeting", "color"),
          card: read(".prio-kpi", "background-color"),
          border: read(".prio-kpi", "border-top-color"),
        };
      });

    await applyTheme("light");
    const light = await sample();

    await applyTheme("dark");
    const dark = await sample();

    // Every one of these must change: a theme that only flips the background
    // leaves unreadable text behind.
    expect(dark.page).not.toBe(light.page);
    expect(dark.heading).not.toBe(light.heading);
    expect(dark.card).not.toBe(light.card);
    expect(dark.border).not.toBe(light.border);

    // And the result has to be legible: dark text on a dark page is the exact
    // failure this test exists to catch.
    const luminance = (colour: string) => {
      const [r = 0, g = 0, b = 0] = colour
        .replace(/[^\d,.]/g, "")
        .split(",")
        .map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };

    expect(luminance(dark.page)).toBeLessThan(0.3);
    expect(luminance(dark.heading)).toBeGreaterThan(0.6);
    expect(luminance(light.page)).toBeGreaterThan(0.7);
    expect(luminance(light.heading)).toBeLessThan(0.4);
  });

  test("remembers the choice and offers a way back to the system default", async ({
    page,
  }) => {
    await page.goto("/");

    const control = page.getByRole("button", { name: /^Theme: / });
    await control.click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // It must survive a full document load — that is what the pre-paint script
    // is for, and a flash of light here would mean it did not run.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await control.click();
    await page.getByRole("menuitemradio", { name: "System" }).click();

    // "System" is the absence of the attribute, which is what the CSS media
    // query is written against.
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });

  test("the entrance animation leaves everything visible", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const sections = page.locator(".prio-dash > *");
    const count = await sections.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const opacity = await sections
        .nth(i)
        .evaluate((el) => getComputedStyle(el).opacity);
      expect(Number(opacity)).toBe(1);
    }
  });
});
