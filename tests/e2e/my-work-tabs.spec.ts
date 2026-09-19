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

test.describe("choosing a tile says so while it is being answered", () => {
  /*
   * Pressing a tile is a server navigation: the address bar changes at once
   * and the list cannot, so without a word from the page the press reads as
   * ignored and the previous tile's rows sit there looking like the answer.
   *
   * The signal is on the tile that was pressed rather than over the list,
   * which also marks which answer is coming.
   */
  test("marks the pressed tile until its answer arrives, then stops", async ({
    page,
  }) => {
    await page.goto("/my-work");
    await expect(tile(page, "Open")).toHaveAttribute("data-selected", "true");

    /* Watched from the moment of the press, because it clears as soon as the
       server answers and a single look afterwards would always miss it. */
    let pending = false;
    const watch = (async () => {
      for (let i = 0; i < 100; i += 1) {
        if (await page.locator(".prio-stat__pending").count()) {
          pending = true;
          return;
        }
        await page.waitForTimeout(8);
      }
    })();

    await tile(page, "Completed").click();
    await watch;
    await expect(page).toHaveURL(/show=completed/);

    expect(pending, "the pressed tile said it was working").toBe(true);

    /* And it is gone once the list is there — a spinner that outlives its
       answer is worse than none. */
    await expect(
      page.getByRole("heading", { name: "Completed by me" }),
    ).toBeVisible();
    await expect(page.locator(".prio-stat__pending")).toHaveCount(0);
  });

  test("keeps every figure on screen while another tile's list loads", async ({
    page,
  }) => {
    await page.goto("/my-work");

    /* The summary row is not what changes, so it is never blanked or drawn
       twice: four tiles before, four after, and the pressed one marked. */
    await tile(page, "Overdue").click();
    await expect(page).toHaveURL(/show=overdue/);

    await expect(page.locator("a.prio-stat")).toHaveCount(4);
    for (const label of ["Open", "Completed", "Overdue", "Due this week"]) {
      await expect(tile(page, label)).toHaveCount(1);
    }
    await expect(tile(page, "Overdue")).toHaveAttribute("data-selected", "true");
    await expect(tile(page, "Open")).not.toHaveAttribute("data-selected", "true");
  });

  test("stands the whole page in while it is first opened", async ({ page }) => {
    /* Arriving at My Work from elsewhere is a segment change, which is the one
       Next shows route loading UI for. Verified from the response rather than
       the screen, since it is replaced the moment the page itself arrives. */
    const response = await page.request.get("/my-work");
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain("prio-skeleton");
    expect(html).toContain("Loading your work");
  });
});
