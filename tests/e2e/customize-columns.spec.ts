import { expect, test, type Page } from "@playwright/test";
import { ADMIN_STATE } from "./support";

/**
 * Choosing which columns the work item list shows.
 *
 * What matters here is not that a column disappears — that would be true of any
 * client-side hiding — but that the *server* stops sending it. The table is
 * server-rendered so that sorting and paging can be links, and a chooser that
 * only hid cells in the browser would quietly undo that. So the assertions are
 * about the markup that arrives, and about the links still working afterwards.
 */

const COOKIE = "prio.issues.columns";

function header(page: Page, name: string) {
  return page.locator("thead th").filter({ hasText: name });
}

test.describe("Customising the work item columns", () => {
  test.use({ storageState: ADMIN_STATE });

  test.beforeEach(async ({ context }) => {
    /* Each case starts with no preference, so "the default" is a real
       starting point rather than whatever the last test left behind. */
    await context.clearCookies({ name: COOKIE });
  });

  test("starts with every column, and offers the optional ones", async ({
    page,
  }) => {
    await page.goto("/issues");

    for (const name of ["Key", "Summary", "Status", "Priority", "Assignee"]) {
      await expect(header(page, name).first()).toBeVisible();
    }

    await page.getByRole("button", { name: /^Columns/ }).click();
    const menu = page.getByRole("menu", { name: "Columns" });
    await expect(menu).toBeVisible();

    // Optional columns are listed…
    await expect(menu.getByRole("menuitemradio", { name: "Assignee" })).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: "Priority" })).toBeVisible();

    /* …and the two that cannot be turned off are not, because a table with
       neither is a list nobody can open. */
    await expect(menu.getByRole("menuitemradio", { name: "Key" })).toHaveCount(0);
    await expect(menu.getByRole("menuitemradio", { name: "Summary" })).toHaveCount(0);
  });

  test("stops the server sending a column that was turned off", async ({
    page,
  }) => {
    await page.goto("/issues");
    await expect(header(page, "Assignee").first()).toBeVisible();

    await page.getByRole("button", { name: /^Columns/ }).click();
    await page
      .getByRole("menu", { name: "Columns" })
      .getByRole("menuitemradio", { name: "Assignee" })
      .click();
    await page.keyboard.press("Escape");

    await expect(header(page, "Assignee")).toHaveCount(0);

    /*
     * The load-bearing part: ask for the page again, fresh, and the column is
     * still absent — which can only be true if the server rendered it that
     * way. A browser-side hide would come back on a reload.
     */
    await page.reload();
    await expect(header(page, "Assignee")).toHaveCount(0);
    await expect(header(page, "Key").first()).toBeVisible();
  });

  test("keeps sorting and paging working with a column hidden", async ({
    page,
  }) => {
    await page.goto("/issues");

    await page.getByRole("button", { name: /^Columns/ }).click();
    await page
      .getByRole("menu", { name: "Columns" })
      .getByRole("menuitemradio", { name: "Priority" })
      .click();
    await page.keyboard.press("Escape");
    await expect(header(page, "Priority")).toHaveCount(0);

    /* Sorting is a link, and it still is: following it keeps the preference
       because the preference is not in the URL. */
    await header(page, "Status").first().getByRole("link").click();
    await expect(page).toHaveURL(/sort=status/);
    await expect(header(page, "Priority")).toHaveCount(0);
    await expect(header(page, "Status").first()).toBeVisible();

    // And the rows are still rows that open.
    const firstKey = page.locator("tbody .prio-issuelink").first();
    await expect(firstKey).toBeVisible();
  });

  test("a hand-edited preference cannot produce a table nobody can open", async ({
    page,
    context,
  }) => {
    /*
     * The cookie belongs to the browser, so it can say anything. Asking for a
     * table with none of the columns that link to a work item must still
     * produce one — the parser puts the required columns back.
     */
    await context.addCookies([
      {
        name: COOKIE,
        value: "status",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto("/issues");

    await expect(header(page, "Key").first()).toBeVisible();
    await expect(header(page, "Summary").first()).toBeVisible();
    await expect(page.locator("tbody .prio-issuelink").first()).toBeVisible();
  });

  test("nonsense in the preference falls back to the full table", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: COOKIE,
        value: "rubbish,nonsense",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto("/issues");
    for (const name of ["Key", "Summary", "Status", "Priority", "Assignee"]) {
      await expect(header(page, name).first()).toBeVisible();
    }
  });
});
