import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./support";

/**
 * The Flow Board as a view of a project, rather than a place you end up.
 *
 * The board's route never left the project — it has always been
 * `/projects/<key>/board` — but it used to arrive with the project's tab strip
 * suppressed, so Summary, List, Sprints, Calendar, Timeline and Activity all
 * vanished on reaching it. The only way onward was the browser's Back button,
 * which is what made a project-scoped page feel like a global one.
 *
 * The strip is shown here now, with Flow Board as the current tab. What the
 * board still withholds is the shell's *header*: it draws its own, and two
 * headers with two action menus was the reason the chrome was hidden in the
 * first place.
 */

const KEY = "eng";
const BASE = `/projects/${KEY}`;

test.describe("The Flow Board, inside its project", () => {
  test.use({ storageState: ADMIN_STATE });

  test("keeps the project's tabs, and marks itself the current one", async ({
    page,
  }) => {
    await page.goto(`${BASE}/summary`);

    const nav = page.getByRole("navigation", { name: "Project views" });
    await expect(nav).toBeVisible();

    // Arrive the way a person does: by pressing the tab.
    await nav.getByRole("link", { name: "Flow Board" }).click();

    // The project is still the subject, and the URL still says so.
    await expect(page).toHaveURL(new RegExp(`${BASE}/board$`));

    // The strip came too, and knows where it is.
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Flow Board" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // And every other view is still one click away.
    for (const tab of ["Summary", "List", "Calendar", "Timeline", "Activity"]) {
      await expect(nav.getByRole("link", { name: tab })).toBeVisible();
    }

    // The board itself is what is drawn below it.
    await expect(
      page.getByRole("heading", { name: "Flow Board", level: 1 }),
    ).toBeVisible();
  });

  test("survives a reload, and the browser's own Back and Forward", async ({
    page,
  }) => {
    await page.goto(`${BASE}/summary`);
    const nav = page.getByRole("navigation", { name: "Project views" });
    await nav.getByRole("link", { name: "Flow Board" }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/board$`));

    /* A reload is the case a client-side-only fix would fail: the strip has to
       come back from the server, not from whatever the last navigation left in
       memory. */
    await page.reload();
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Flow Board" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${BASE}/summary$`));
    await expect(nav).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${BASE}/board$`));
    await expect(nav).toBeVisible();
  });

  test("leads back into the same project, not out of it", async ({ page }) => {
    await page.goto(`${BASE}/board`);

    const nav = page.getByRole("navigation", { name: "Project views" });
    await nav.getByRole("link", { name: "List" }).click();

    /* The project key is the thing under test: a tab that dropped it would
       land on the global list with a filter, which is what these views used to
       do before the shell existed. */
    await expect(page).toHaveURL(new RegExp(`${BASE}/list$`));

    await nav.getByRole("link", { name: "Summary" }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/summary$`));
  });

  test("still refuses a project the reader cannot open", async ({ page }) => {
    /* The strip is presentation; access is not. A key that is not theirs
       answers the same way it did before any of this changed. */
    await page.goto("/projects/nosuchproject/board");
    await expect(page.locator("body")).toContainText(/not found|404/i);
  });
});
