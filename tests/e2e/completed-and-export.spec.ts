import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * Two things a number has to be able to do: mean one thing, and lead to the
 * work it counted.
 *
 *   - the Home "Completed issues" card — its title, its number, the line under
 *     it and the list it opens are all "issues at DONE, in the projects this
 *     person can see", for an administrator and for a member alike;
 *   - the Excel export's attachment links — real clickable hyperlinks showing
 *     the filename, one per attachment, pointing at the configured public host.
 *
 * ExcelJS is used to *read* the workbook. The export writes it with
 * `write-excel-file`, unchanged; this is a reader in a test, not a second
 * spreadsheet implementation.
 */

/**
 * Reads a downloaded workbook.
 *
 * The cast is only about two `Buffer` declarations disagreeing — ExcelJS types
 * its parameter against its own bundled Node typings, so a plain
 * `Buffer<ArrayBufferLike>` from Playwright is rejected despite being the same
 * bytes.
 */
async function readWorkbook(body: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Issues");
  if (!sheet) throw new Error("the export has no Issues sheet");
  return sheet;
}

/** The Home card, and the number on it. */
async function completedCard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  const card = page.locator("a").filter({ hasText: "Completed issues" }).first();
  await expect(card).toBeVisible();
  const text = (await card.innerText()).replace(/\s+/g, " ").trim();
  return { card, text, value: Number(/(\d+)/.exec(text)![1]) };
}

/** The DONE issues this person is actually allowed to see. */
async function visibleDone(email: string | null): Promise<number> {
  if (email === null) {
    return prisma.issue.count({
      where: { status: "DONE", project: { isArchived: false } },
    });
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return prisma.issue.count({
    where: {
      status: "DONE",
      project: { isArchived: false, members: { some: { userId: user.id } } },
    },
  });
}

/* ------------------------------------------------------- the completed card */

test.describe("The Completed issues card, as an administrator", () => {
  test("says one thing in its title, number, subtitle and destination", async ({
    page,
  }) => {
    const { card, text, value } = await completedCard(page);

    // Title and subtitle both describe the number above them.
    expect(text).toMatch(/completed issues/i);
    expect(text).toContain(`${value} completed in total`);
    // Never the shape it used to have: a monthly figure over a total.
    expect(text).not.toMatch(/this month|vs last month/i);

    // The number is the real count of DONE issues in scope, not a stored one.
    expect(value).toBe(await visibleDone(null));

    await card.click();
    await page.waitForURL(/\/issues\?status=DONE$/);
    await page.waitForSelector("table.prio-table, .prio-empty");

    const total = Number(
      /(\d+)/.exec(await page.locator(".prio-filters__total").innerText())![1],
    );
    expect(total, "the list holds exactly what the card counted").toBe(value);

    // And every row really is Done.
    for (const status of await page
      .locator("table.prio-table tbody tr .prio-status")
      .allInnerTexts()) {
      expect(status.trim().toLowerCase()).toBe("done");
    }
  });

  test("follows an issue into and out of Done", async ({ page }) => {
    const before = (await completedCard(page)).value;

    const target = await prisma.issue.findFirstOrThrow({
      where: { status: { in: ["IN_REVIEW", "IN_QA"] } },
      select: { key: true, status: true },
    });
    const back = target.status === "IN_QA" ? "In QA" : "Ready for QA";

    async function move(to: string) {
      await page.goto(`/issues/${target.key.toLowerCase()}`);
      await page.locator(".prio-issue__headmeta .prio-status").first().click();
      await page.getByRole("menuitemradio", { name: to, exact: true }).click();
      await expect(
        page.locator(".prio-toast").filter({ hasText: "Moved to" }).first(),
      ).toBeVisible();
    }

    try {
      await move("Done");
      expect((await completedCard(page)).value, "Done adds one").toBe(before + 1);

      // Refreshing must not change a real count.
      await page.reload({ waitUntil: "networkidle" });
      expect((await completedCard(page)).value).toBe(before + 1);

      await move(back);
      expect((await completedCard(page)).value, "leaving Done removes one").toBe(
        before,
      );

      /* Cancelled is closed but not completed — the distinction the card used
         to lose when it counted `completedAt` regardless of status. */
      await move("Cancelled");
      expect(
        (await completedCard(page)).value,
        "cancelling is not completing",
      ).toBe(before);
    } finally {
      await move(back);
    }
  });
});

test.describe("The Completed issues card, as a member", () => {
  test.use({ storageState: MEMBER_STATE });

  test("counts and lists only the work they may see", async ({ page }) => {
    const mine = await visibleDone(MEMBER_EMAIL);
    const everything = await visibleDone(null);

    const { card, value } = await completedCard(page);
    expect(value).toBe(mine);
    /* The fixture is only meaningful if there is something to be excluded —
       DONE work in a project this member is not on. */
    expect(everything).toBeGreaterThan(mine);

    await card.click();
    await page.waitForURL(/\/issues\?status=DONE$/);
    await page.waitForSelector("table.prio-table, .prio-empty");

    expect(
      Number(
        /(\d+)/.exec(await page.locator(".prio-filters__total").innerText())![1],
      ),
    ).toBe(mine);

    // Nothing from a project they are not a member of.
    const hidden = await prisma.project.findMany({
      where: { members: { none: { user: { email: MEMBER_EMAIL } } } },
      select: { key: true },
    });
    const keys = await page
      .locator("table.prio-table tbody tr .prio-key")
      .allInnerTexts();
    for (const key of keys) {
      for (const project of hidden) {
        expect(
          key.trim().startsWith(`${project.key}-`),
          `${key} belongs to ${project.key}, which this member is not on`,
        ).toBe(false);
      }
    }
  });
});

/* --------------------------------------------------------- the Excel export */

test.describe("The Excel export's attachment links", () => {
  test("are clickable hyperlinks, one per file, showing the filename", async ({
    request,
  }) => {
    const response = await request.get("/api/issues/export");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("spreadsheetml");

    const sheet = await readWorkbook(await response.body());
    expect(sheet, "the workbook opens and keeps its sheet").toBeDefined();

    const headers = (sheet.getRow(1).values as unknown[])
      .slice(1)
      .map((v) => String(v));

    // Existing columns are untouched.
    for (const kept of [
      "Key",
      "Title",
      "Status",
      "Assignee",
      "Attachments",
      "Attachment files",
      "Attachment links",
      "Issue ID",
    ]) {
      expect(headers, `${kept} still exported`).toContain(kept);
    }

    // And the new per-file columns, as wide as the data needed.
    const linkColumns = headers.filter((h) => /^Attachment \d+$/.test(h));
    expect(linkColumns.length).toBeGreaterThan(0);

    const base = process.env.BASE_URL?.replace(/\/+$/, "") ?? "";
    let checked = 0;
    let severalOnOneRow = 0;

    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const links: string[] = [];

      for (const header of linkColumns) {
        const cell = row.getCell(headers.indexOf(header) + 1);
        const formula = (cell.value as { formula?: string } | null)?.formula;
        if (!formula) continue;

        links.push(formula);
        // A real HYPERLINK, with the URL first and the filename as the label.
        const parsed = /^HYPERLINK\("([^"]+)","(.*)"\)$/.exec(formula);
        expect(parsed, `unreadable formula: ${formula}`).not.toBeNull();

        const url = parsed![1]!;
        const label = parsed![2]!;
        expect(url).toContain("/api/attachments/");
        expect(url.startsWith(base), `${url} uses the configured host`).toBe(true);
        // The filename is what a reader sees, not the URL.
        expect(label).not.toContain("/api/attachments/");
        expect(label.length).toBeGreaterThan(0);
        checked += 1;
      }

      if (links.length > 1) {
        severalOnOneRow += 1;
        // Each file got its own cell, so each is separately clickable.
        expect(new Set(links).size).toBe(links.length);
      }
    });

    expect(checked, "some attachment links were checked").toBeGreaterThan(0);
    expect(
      severalOnOneRow,
      "an issue with several attachments has several link cells",
    ).toBeGreaterThan(0);
  });

  test("never writes a loopback address into the workbook", async ({
    request,
  }) => {
    /*
     * In development `BASE_URL` is deliberately localhost and the export
     * honours it — pointing a developer's spreadsheet at their own server is
     * correct. What must never happen is localhost appearing when nobody asked
     * for it, which is what the schema default used to guarantee in
     * production. That fallback is covered directly in
     * `tests/export-links.test.ts`; this asserts the workbook only ever
     * carries the configured host.
     */
    const configured = process.env.BASE_URL?.replace(/\/+$/, "") ?? "";
    const response = await request.get("/api/issues/export");
    const sheet = await readWorkbook(await response.body());

    const headers = (sheet.getRow(1).values as unknown[])
      .slice(1)
      .map((v) => String(v));
    const linkColumns = headers.filter((h) => /^Attachment \d+$/.test(h));

    sheet.eachRow((row, index) => {
      if (index === 1) return;
      for (const header of linkColumns) {
        const formula = (
          row.getCell(headers.indexOf(header) + 1).value as
            | { formula?: string }
            | null
        )?.formula;
        if (!formula) continue;
        expect(formula).toContain(configured);
        expect(formula).not.toContain("0.0.0.0");
      }
    });
  });

  /* Export authorization is unchanged and covered where it already was:
     `modules.spec.ts` asserts a signed-out request is refused, and
     `metric-navigation.spec.ts` asserts an attachment is not served across a
     project boundary. Nothing here relaxes either. */
});
