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

  test("says why Key and Summary cannot be turned off", async ({ page }) => {
    const menu = await openMenu(page);

    /* They are listed rather than footnoted: a name that is simply absent
       reads as missing, so each appears as a locked row carrying the reason
       in place of a checkbox. */
    const locked = menu.locator(".prio-colpicker__locked");
    await expect(locked).toHaveCount(2);
    await expect(locked.nth(0)).toContainText("Key");
    await expect(locked.nth(0)).toContainText("Always visible");
    await expect(locked.nth(1)).toContainText("Summary");
    await expect(locked.nth(1)).toContainText("Always visible");

    /* And they are genuinely not offered — the rows describe the menu rather
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

/**
 * The drop zone the import asks for a file through.
 *
 * The browser's own "Choose File / No file chosen" chrome cannot be styled and
 * said nothing about what the import wants, so it is hidden behind a zone that
 * takes a click, a drop or a paste. The input itself is still the thing
 * holding the file, and these cases exist to prove the presentation changed
 * without a second upload path being introduced beside it.
 */
test.describe("the import drop zone", () => {
  const XLSX_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  /** Hands the zone a file the way a drop or a paste does. */
  async function sendFile(
    page: import("@playwright/test").Page,
    event: "drop" | "paste",
    name: string,
  ) {
    await page.evaluate(
      ({ event, name, type }) => {
        const data = new DataTransfer();
        data.items.add(new File(["fixture"], name, { type }));

        if (event === "drop") {
          document.querySelector(".prio-importdrop")!.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
            }),
          );
        } else {
          document.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: data,
            }),
          );
        }
      },
      { event, name, type: XLSX_TYPE },
    );
  }

  const openDialog = async (page: import("@playwright/test").Page) => {
    await page.goto("/issues");
    await page.getByRole("button", { name: "Import" }).click();
    const dialog = page.getByRole("dialog", { name: "Import work items" });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  test("asks for the file in its own words, not the browser's", async ({ page }) => {
    const dialog = await openDialog(page);

    await expect(dialog.locator(".prio-importdrop__text")).toHaveText(
      "Drag & drop or paste Excel template file here",
    );

    /* The old presentation is gone: no "Spreadsheet" field label, and the
       input is out of sight rather than removed. */
    await expect(dialog.getByText("Spreadsheet", { exact: true })).toHaveCount(0);
    const input = dialog.locator("#import-file");
    await expect(input).toHaveCount(1);
    const box = await input.boundingBox();
    expect(box === null || box.width <= 1, "the file input is hidden").toBe(true);

    /* It still only offers to take the format the parser reads. */
    await expect(input).toHaveAttribute("accept", /\.xlsx/);
  });

  test("keeps the sentence that names the columns, and its emphasis", async ({
    page,
  }) => {
    const dialog = await openDialog(page);
    const hint = dialog.locator(".prio-hint");

    await expect(hint).toContainText(
      "Needs a Title column and a Project key column. Type, Status, Priority, " +
        "Assignee, Labels, Due date and Description are used when present.",
    );
    await expect(hint.locator("strong")).toHaveText(["Title", "Project key"]);
  });

  test("opens the real file picker when the zone is clicked", async ({ page }) => {
    const dialog = await openDialog(page);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.locator(".prio-importdrop").click(),
    ]);
    /* The picker belongs to the input that was there all along. */
    expect(chooser.isMultiple()).toBe(false);
  });

  test("takes a dropped file, and says which one it is holding", async ({ page }) => {
    const dialog = await openDialog(page);
    const importButton = dialog.getByRole("button", { name: "Import", exact: true });

    /* Nothing to import until there is something to import. */
    await expect(importButton).toBeDisabled();

    await sendFile(page, "drop", "dropped-work-items.xlsx");

    await expect(dialog.locator(".prio-importdrop__file")).toHaveText(
      "dropped-work-items.xlsx",
    );
    await expect(dialog.locator(".prio-importdrop")).toHaveAttribute(
      "data-chosen",
      "true",
    );
    await expect(importButton).toBeEnabled();
  });

  test("takes a pasted file too", async ({ page }) => {
    const dialog = await openDialog(page);

    await sendFile(page, "paste", "pasted-work-items.xlsx");

    await expect(dialog.locator(".prio-importdrop__file")).toHaveText(
      "pasted-work-items.xlsx",
    );
    await expect(
      dialog.getByRole("button", { name: "Import", exact: true }),
    ).toBeEnabled();
  });

  /*
   * Dropping the wrong thing is answered at once rather than after a round
   * trip. The rule is the server's own — the extension it refuses — so the
   * two cannot come to disagree about what is importable.
   */
  test("refuses a file that is not a spreadsheet, and stays refusable", async ({
    page,
  }) => {
    const dialog = await openDialog(page);

    await sendFile(page, "drop", "notes.txt");

    await expect(dialog.locator(".prio-alert")).toContainText(
      "Import expects an .xlsx spreadsheet",
    );
    await expect(dialog.locator(".prio-importdrop__file")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Import", exact: true }),
    ).toBeDisabled();

    /* And the zone still works afterwards: a refusal is not a dead end. */
    await sendFile(page, "drop", "second-try.xlsx");
    await expect(dialog.locator(".prio-importdrop__file")).toHaveText(
      "second-try.xlsx",
    );
    await expect(
      dialog.getByRole("button", { name: "Import", exact: true }),
    ).toBeEnabled();
  });

  test("marks itself while a file is dragged over it", async ({ page }) => {
    const dialog = await openDialog(page);
    const zone = dialog.locator(".prio-importdrop");

    await expect(zone).not.toHaveAttribute("data-dragging", "true");

    await page.evaluate(() => {
      document.querySelector(".prio-importdrop")!.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        }),
      );
    });

    await expect(zone).toHaveAttribute("data-dragging", "true");
  });

  test("keeps Cancel, and the promise printed beside it", async ({ page }) => {
    const dialog = await openDialog(page);

    await expect(dialog.locator(".prio-dialog__footer-note")).toHaveText(
      "Nothing is created until every row is valid.",
    );

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("fits a phone without spilling sideways", async ({ page }) => {
    const dialog = await openDialog(page);

    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForTimeout(250);

    const zone = (await dialog.locator(".prio-importdrop").boundingBox())!;
    const panel = (await dialog.boundingBox())!;
    expect(zone.width).toBeLessThanOrEqual(panel.width);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    /* Both actions stay reachable rather than wrapping out of the panel. */
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
  });
});
