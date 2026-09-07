import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_STATE } from "./support";

/**
 * Sharing the Issues Sheet, from the dialog through to the download.
 *
 * The search-and-pick half already existed; what these check is that it still
 * behaves — matches, no-matches, picking, removing, and never offering someone
 * who already has access — and that the half added around it holds: the person
 * shared with is told, the notification opens their sheet, and the sheet they
 * land on can actually be downloaded.
 */

/*
 * The search field is a controlled React input: setting its value outright
 * does not run the onChange that filters the candidates, so every one of these
 * types for real.
 */
async function typeSearch(
  search: import("@playwright/test").Locator,
  text: string,
) {
  await search.click();
  await search.press("ControlOrMeta+a");
  await search.press("Backspace");
  if (text) await search.pressSequentially(text, { delay: 25 });
}

/** Opens /issues and the Share dialog on it. */
async function openShare(page: import("@playwright/test").Page) {
  await page.goto("/issues");
  await page.getByRole("button", { name: /^Share$/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("The Share Issues Sheet dialog", () => {
  test("searches members, and says so when nothing matches", async ({ page }) => {
    const dialog = await openShare(page);
    const search = dialog.locator("#share-search");

    /* Somebody the dialog can actually offer: active, and not already on the
       share — the candidate list excludes anyone who already has access. */
    const shared = await prisma.issueSheetShareMember.findMany({
      select: { userId: true },
    });
    const someone = await prisma.user.findFirstOrThrow({
      where: {
        isActive: true,
        id: { notIn: shared.map((m) => m.userId) },
        // Not the administrator doing the sharing: you are never your own
        // candidate, so searching for yourself correctly finds nothing.
        email: { not: "admin@symbiosystech.com" },
      },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    await typeSearch(search, someone.name.split(" ")[0]!);
    await expect(
      dialog.locator('[role="option"]').first(),
    ).toBeVisible();

    // Picking one marks it, so the grant knows who it is for.
    const first = dialog.locator('[role="option"]').first();
    await first.click();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("button", { name: "Share" })).toBeEnabled();

    // And a search that matches nobody says so, rather than offering nothing.
    await typeSearch(search, "zzzznobodyzzzz");
    await expect(dialog).toContainText(/No matching member/i);
    await expect(dialog.locator('[role="option"]')).toHaveCount(0);
  });

  test("never offers someone who already has access", async ({ page }) => {
    const existing = await prisma.issueSheetShareMember.findFirst({
      select: { user: { select: { name: true } } },
    });
    test.skip(!existing, "nobody is on the share yet");

    const dialog = await openShare(page);
    const name = existing!.user.name;

    // They are listed as already having it…
    await expect(dialog).toContainText(name);

    // …and searching for them offers no second grant.
    const search = dialog.locator("#share-search");
    await typeSearch(search, name);
    await expect(
      dialog.locator('[role="option"]').filter({ hasText: name }),
    ).toHaveCount(0);
  });
});

test.describe("Being shared with", () => {
  test("the recipient is told, and the notification opens their sheet", async ({
    browser,
  }) => {
    /* Granted through the real dialog as an administrator, then read as the
       person who received it. */
    const member = await prisma.user.findFirstOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true, name: true },
    });

    // Start from no grant, so this is a first grant and does notify.
    await prisma.issueSheetShareMember.deleteMany({ where: { userId: member.id } });
    await prisma.notification.deleteMany({
      where: { userId: member.id, type: "INVITED" },
    });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const dialog = await openShare(adminPage);

    const search = dialog.locator("#share-search");
    await typeSearch(search, member.name);
    await dialog.locator('[role="option"]').filter({ hasText: member.name }).first().click();
    await dialog.getByRole("button", { name: "Share" }).click();

    await expect
      .poll(
        async () =>
          prisma.issueSheetShareMember.count({ where: { userId: member.id } }),
        { timeout: 15_000 },
      )
      .toBe(1);
    await adminContext.close();

    // They were told.
    const invites = await prisma.notification.findMany({
      where: { userId: member.id, type: "INVITED" },
      select: { message: true },
    });
    expect(invites).toHaveLength(1);
    expect(invites[0]!.message).toMatch(/Issues Sheet/i);

    // And the notification takes them to the sheet, which offers the download.
    const memberContext = await browser.newContext({ storageState: MEMBER_STATE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/notifications");

    /* A notification opens in place first — it says what happened before it
       offers the way onward. */
    await memberPage
      .locator("button.prio-notification__link")
      .filter({ hasText: /Issues Sheet/i })
      .first()
      .click();

    const open = memberPage.getByRole("link", { name: /Open the Issues Sheet/i });
    await expect(open).toBeVisible();
    const href = await open.getAttribute("href");
    expect(href, "opens their own shared sheet").toMatch(
      /^\/shared\/issues\/[A-Za-z0-9_-]+$/,
    );

    await open.click();
    await expect(
      memberPage.getByRole("heading", { name: /Shared Issues Sheet/i }),
    ).toBeVisible();

    /* The sheet can be taken away as Excel — the same Export control /issues
       carries, hitting the same route. */
    const exportButton = memberPage.getByRole("button", { name: /Export Excel/i });
    await expect(exportButton).toBeVisible();

    const download = memberPage.waitForEvent("download", { timeout: 30_000 });
    await exportButton.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);

    await memberContext.close();
  });
});
