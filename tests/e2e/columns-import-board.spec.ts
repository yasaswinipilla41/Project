import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Three surfaces that were each missing one thing: the board's columns had
 * two answers for their own height, the Columns menu explained nothing and
 * offered no way back, and the import asked for a spreadsheet shape it never
 * handed anybody.
 *
 * The board assertions are geometry rather than CSS — whether a card can
 * actually be reached — so a rewrite that keeps the behaviour keeps them
 * passing, and one that reinstates a second height formula does not.
 */

test.use({ storageState: ADMIN_STATE });

const COOKIE = "prio.issues.columns";

test.describe("the Flow Board's columns and their height", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/projects/eng/board");
    await page.waitForLoadState("networkidle");
  });

  /**
   * Every column, scrolled to its end, with the last card measured against
   * the box that holds it.
   */
  async function columnsAtEnd(page: import("@playwright/test").Page) {
    return page.evaluate(async () => {
      const rows: {
        status: string;
        cards: number;
        cutOff: number;
        spare: number;
        reachable: boolean;
      }[] = [];

      for (const column of document.querySelectorAll(".prio-board__column")) {
        const body = column.querySelector(".prio-board__column-body");
        if (!(body instanceof HTMLElement)) continue;
        const cards = [...body.querySelectorAll(".prio-board__card")];

        body.scrollTop = body.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const bodyBox = body.getBoundingClientRect();
        const columnBox = column.getBoundingClientRect();
        const last = cards.at(-1)?.getBoundingClientRect();

        rows.push({
          status: (column as HTMLElement).dataset.status ?? "?",
          cards: cards.length,
          /* Above zero means the last card is still cut off after scrolling
             as far as the column goes — the failure being guarded against. */
          cutOff: last ? Math.round(last.bottom - bodyBox.bottom) : -1,
          /* How much of the column the body does not use. A second height
             formula shows up here as a gap that grows with the viewport. */
          spare: Math.round(columnBox.bottom - bodyBox.bottom),
          reachable: body.scrollHeight - body.clientHeight >= 0,
        });
      }
      return rows;
    });
  }

  for (const height of [900, 760, 640] as const) {
    test(`reaches the last card of every column at ${height}px tall`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height });
      await page.waitForTimeout(300);

      const columns = await columnsAtEnd(page);
      expect(columns.length).toBeGreaterThan(0);

      /* Done is named because it is the one that was reported, but the claim
         is about every column: Done is not special, and a fix that only
         helped Done would be the wrong fix. */
      expect(columns.map((c) => c.status)).toContain("DONE");

      for (const column of columns) {
        expect(column.cutOff, `${column.status} last card cut off`).toBeLessThanOrEqual(0);
        expect(column.reachable, `${column.status} scrollable`).toBe(true);
        /* The body takes the column's remaining height, so the unused strip
           below it is padding and nothing more. */
        expect(column.spare, `${column.status} unused height`).toBeLessThanOrEqual(8);
      }
    });
  }

  test("keeps a long column scrolling inside itself, not down the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    /* Backlog holds over a thousand cards here. Its overflow must stay its
       own: the page growing to the height of the tallest column is the
       regression `contain: paint` exists to prevent. */
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });
});

test.describe("the Columns menu", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies({ name: COOKIE });
    await page.goto("/issues");
  });

  const openMenu = async (page: import("@playwright/test").Page) => {
    await page.getByRole("button", { name: /^Columns/ }).click();
    return page.getByRole("menu", { name: "Columns" });
  };

  test("says why Key and Summary are not on the list", async ({ page }) => {
    const menu = await openMenu(page);

    await expect(menu.locator(".prio-menu__note")).toContainText(
      "Key and Summary are always visible and cannot be hidden.",
    );

    /* And they are genuinely not offered — the note describes the menu rather
       than apologising for it. */
    await expect(menu.getByRole("menuitemradio", { name: "Key" })).toHaveCount(0);
    await expect(
      menu.getByRole("menuitemradio", { name: "Summary" }),
    ).toHaveCount(0);

    /* The nine that are. */
    for (const label of [
      "Status",
      "Priority",
      "Assignee",
      "Reporter",
      "Completed by",
      "Completed",
      "Due",
      "Created",
      "Updated",
    ]) {
      await expect(
        menu.getByRole("menuitemradio", { name: label, exact: true }),
      ).toHaveCount(1);
    }
    await expect(menu.getByRole("menuitemradio")).toHaveCount(9);
  });

  test("counts what is selected, and puts it back", async ({ page }) => {
    const menu = await openMenu(page);
    const footer = menu.locator(".prio-menu__footertext");
    const badge = page
      .getByRole("button", { name: /^Columns/ })
      .locator(".prio-filterchip__count");

    await expect(footer).toHaveText("9 of 9 selected");
    /* Two mandatory columns plus nine optional ones. Derived, never a
       literal: the badge is what the table actually drew. */
    await expect(badge).toHaveText("11");

    // Turn one off: the menu, the badge and the table all move together.
    await menu.getByRole("menuitemradio", { name: "Priority", exact: true }).click();
    await expect(footer).toHaveText("8 of 9 selected");
    await expect(badge).toHaveText("10");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("columnheader", { name: "Priority" }),
    ).toHaveCount(0);

    // And Reset puts every one of them back.
    const reopened = await openMenu(page);
    await reopened.getByRole("menuitem", { name: "Reset to default" }).click();
    await expect(reopened.locator(".prio-menu__footertext")).toHaveText(
      "9 of 9 selected",
    );
    await expect(badge).toHaveText("11");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("columnheader", { name: "Priority" }),
    ).toHaveCount(1);
  });

  test("resets a preference that was already stored", async ({ page, context }) => {
    /* Reset has to restore the application's default, not merely undo the
       last click — so it is given a preference it did not make. */
    await context.addCookies([
      {
        name: COOKIE,
        value: "key,title,status,actions",
        url: "http://localhost:3000",
      },
    ]);
    await page.goto("/issues");
    await expect(
      page.getByRole("columnheader", { name: "Assignee" }),
    ).toHaveCount(0);

    const menu = await openMenu(page);
    await menu.getByRole("menuitem", { name: "Reset to default" }).click();
    await page.keyboard.press("Escape");

    for (const label of ["Status", "Priority", "Assignee", "Reporter", "Updated"]) {
      await expect(
        page.getByRole("columnheader", { name: label, exact: true }),
      ).toHaveCount(1);
    }
    /* Key and Summary were never at risk, and are still there. */
    await expect(page.getByRole("columnheader", { name: "Key" })).toHaveCount(1);
    await expect(page.getByRole("columnheader", { name: "Summary" })).toHaveCount(1);
  });

  test("keeps Reset reachable from the keyboard", async ({ page }) => {
    /* Tab closes a menu and the arrow keys walk only menu items, so a footer
       button that is not one would be mouse-only. */
    const menu = await openMenu(page);
    const reset = menu.getByRole("menuitem", { name: "Reset to default" });
    await expect(reset).toHaveCount(1);
    await reset.focus();
    await expect(reset).toBeFocused();
  });
});

test.describe("the import template", () => {
  test("downloads a spreadsheet shaped like the one the import asks for", async ({
    page,
  }) => {
    await page.goto("/issues");
    await page.getByRole("button", { name: "Import" }).click();

    const dialog = page.getByRole("dialog", { name: "Import work items" });
    await expect(dialog).toBeVisible();

    /* Directly below the sentence that names the columns — it is that
       sentence made into a file. */
    const hint = dialog.locator(".prio-hint");
    await expect(hint).toContainText("Needs a Title column");
    const button = dialog.getByRole("button", { name: "Download Template" });
    await expect(button).toBeVisible();

    const hintBox = (await hint.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    expect(buttonBox.y).toBeGreaterThanOrEqual(hintBox.y + hintBox.height - 1);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      button.click(),
    ]);
    expect(download.suggestedFilename()).toBe("prio-work-items-template.xlsx");

    /* The dialog is still open and still ready to import — downloading is not
       a way out of it. */
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
  });

  test("hands back a file the import parser actually reads", async ({ page }) => {
    await page.goto("/issues");
    await page.getByRole("button", { name: "Import" }).click();
    const dialog = page.getByRole("dialog", { name: "Import work items" });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Download Template" }).click(),
    ]);
    const path = await download.path();

    /*
     * Opened with the same library the importer opens uploads with, and its
     * header row compared against the headers the importer matches on. A
     * template that merely downloads proves nothing; this proves it is the
     * right spreadsheet.
     */
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.worksheets[0]!;

    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell) => headers.push(String(cell.value ?? "").trim()));

    expect(headers).toEqual([
      "Title",
      "Project key",
      "Type",
      "Status",
      "Priority",
      "Assignee",
      "Labels",
      "Due date",
      "Description",
    ]);

    /* Header row only. A sample row would have to carry a real project key
       and a real member to survive validation, and somebody filling in the
       rows around it would import the sample as work. */
    expect(sheet.rowCount).toBe(1);
  });

  test("is offered on a project's list too, where the import is that project's", async ({
    page,
  }) => {
    const project = await prisma.project.findFirstOrThrow({
      where: { isArchived: false, issues: { some: {} } },
      select: { key: true },
      orderBy: { key: "asc" },
    });

    await page.goto(`/projects/${project.key.toLowerCase()}/list`);
    await page.getByRole("button", { name: "Import" }).click();

    const dialog = page.getByRole("dialog", { name: "Import work items" });
    await expect(dialog).toContainText(project.key);
    await expect(
      dialog.getByRole("button", { name: "Download Template" }),
    ).toBeVisible();
  });
});
