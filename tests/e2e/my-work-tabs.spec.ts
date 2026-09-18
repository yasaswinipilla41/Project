import { expect, test, type Page } from "@playwright/test";
import { MEMBER_STATE } from "./support";

/**
 * My Work's four figures, and the lists they now choose.
 *
 * Pressing Completed used to leave My Work for `/issues?completedBy=<id>` —
 * a different page, a different header, and a query string that had to carry
 * the reader's own identity to a list that would then have to decide whether
 * to believe it. The figures belong to this page, so the lists do too.
 *
 * What these assert is the behaviour rather than the mechanism: one list at a
 * time, Open to begin with, the chosen tile marked, and the address bar
 * carrying the choice so a refresh and the back button both survive it.
 */

test.use({ storageState: MEMBER_STATE });

function tile(page: Page, label: string) {
  return page
    .locator("a.prio-stat")
    .filter({
      has: page.locator(".prio-stat__label", {
        hasText: new RegExp(`^${label}$`),
      }),
    });
}

test.describe("the four figures choose the list", () => {
  test("opens on Open, with that tile marked and no other list showing", async ({
    page,
  }) => {
    await page.goto("/my-work");

    await expect(tile(page, "Open")).toHaveAttribute("data-selected", "true");
    for (const other of ["Completed", "Overdue", "Due this week"]) {
      await expect(tile(page, other)).not.toHaveAttribute(
        "data-selected",
        "true",
      );
    }

    /* Open is the status-grouped queue, so none of the single-list headings
       is on the page. */
    await expect(
      page.getByRole("heading", { name: "Completed by me" }),
    ).toHaveCount(0);
  });

  test("stays on My Work when a tile is pressed", async ({ page }) => {
    await page.goto("/my-work");
    await tile(page, "Completed").click();

    /* The whole point: still here, not on the global issue list. */
    await expect(page).toHaveURL(/\/my-work\?show=completed$/);
    await expect(
      page.getByRole("heading", { name: "My Work" }),
    ).toBeVisible();
    await expect(tile(page, "Completed")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  test("shows one list at a time", async ({ page }) => {
    await page.goto("/my-work?show=overdue");

    await expect(page.getByRole("heading", { name: "Overdue" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Completed by me" }),
    ).toHaveCount(0);

    await tile(page, "Due this week").click();
    await expect(
      page.getByRole("heading", { name: "Due this week" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overdue" })).toHaveCount(0);
  });

  test("survives a reload and the back button, because the choice is in the URL", async ({
    page,
  }) => {
    await page.goto("/my-work");
    await tile(page, "Completed").click();
    await expect(page).toHaveURL(/show=completed/);

    await page.reload();
    await expect(tile(page, "Completed")).toHaveAttribute(
      "data-selected",
      "true",
    );

    await page.goBack();
    await expect(page).toHaveURL(/\/my-work$/);
    await expect(tile(page, "Open")).toHaveAttribute("data-selected", "true");
  });

  test("falls back to Open when the URL asks for something that is not a tile", async ({
    page,
  }) => {
    /* The parameter is user-controlled like every other one here, and an
       unrecognised value is dropped rather than trusted. */
    await page.goto("/my-work?show=everything");
    await expect(tile(page, "Open")).toHaveAttribute("data-selected", "true");
  });
});

test.describe("the figure and its list are the same question", () => {
  test("the count is the whole set, not the page of it that is drawn", async ({
    page,
  }) => {
    await page.goto("/my-work?show=completed");

    const figure = Number(
      (await tile(page, "Completed").locator(".prio-stat__value").innerText()).trim(),
    );
    const heading = page.getByRole("heading", { name: "Completed by me" });
    await expect(heading).toBeVisible();

    /* The heading repeats the figure, and the rows below are capped. Where the
       cap bites, the page says so rather than letting the two disagree in
       silence. */
    await expect(heading).toContainText(String(figure));

    const rows = await page.locator(".prio-worklink").count();
    if (rows < figure) {
      await expect(page.getByText(/Showing the first \d+ of \d+/)).toBeVisible();
    }
  });
});
