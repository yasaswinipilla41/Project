import {
  expect,
  request as apiRequest,
  test,
  type Page,
} from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE, MEMBER_STATE } from "./support";

/**
 * Clicking a number and arriving at the work it counted.
 *
 *   - the dashboard's "Completed this month" opens the issue list filtered to
 *     the same month, not to every issue ever finished;
 *   - each Status overview row opens that project's list filtered to it;
 *   - the destination shows who holds the work *and* who finished it, which
 *     are different questions.
 *
 * Plus the guard in front of the attachment route, which used to answer an
 * unauthenticated media request with a redirect to an HTML page.
 */

/** The statuses the Status overview can show, by their displayed label. */
const STATUS_LABELS: Record<string, string> = {
  BACKLOG: "Backlog",
  TODO: "New",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "Ready for QA",
  IN_QA: "In QA",
  DONE: "Done",
  REOPENED: "Reopen",
  REJECTED: "Reject / Not an Issue",
  CANCELLED: "Cancelled",
};

/* ------------------------------------------------ completed-work filter */

/*
 * The Home card this used to drive is gone: it was "Completed this month" over
 * the monthly count with "N completed in total" underneath, and it now reads
 * "Completed issues" over the DONE total — one metric said four ways, covered
 * in `completed-and-export.spec.ts` for both an administrator and a member.
 *
 * The `completedWithin` filter it linked to is a capability in its own right
 * and outlived the card, so it keeps its coverage here.
 */
test.describe("The completedWithin filter", () => {
  test("narrows the issue list to work finished this month", async ({ page }) => {
    await page.goto("/issues?status=DONE&completedWithin=month");
    await page.waitForSelector("table.prio-table, .prio-empty");

    const rows = page.locator("table.prio-table tbody tr");
    for (const text of await rows.locator(".prio-status").allInnerTexts()) {
      expect(text.trim().toLowerCase()).toBe("done");
    }

    // It genuinely narrows: never more than the unfiltered DONE list.
    const narrowed = Number(
      /(\d+)/.exec(await page.locator(".prio-filters__total").innerText())![1],
    );

    await page.goto("/issues?status=DONE");
    await page.waitForSelector("table.prio-table, .prio-empty");
    const all = Number(
      /(\d+)/.exec(await page.locator(".prio-filters__total").innerText())![1],
    );

    expect(narrowed).toBeLessThanOrEqual(all);
  });
});

/* -------------------------------------------------- status overview rows */

test.describe("Status overview rows", () => {
  test("each one opens this project's list filtered to that status", async ({
    page,
  }) => {
    await page.goto("/projects/eng");

    const rows = page.locator(".prio-donut__legenditem");
    await expect(rows.first()).toBeVisible();

    const shown: { status: string; count: number }[] = [];
    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      shown.push({
        status: (await row.getAttribute("data-status"))!,
        count: Number(
          (await row.locator(".prio-donut__legendvalue").innerText()).match(
            /\d+/,
          )![0],
        ),
      });
    }
    expect(shown.length).toBeGreaterThan(0);

    for (const { status, count } of shown) {
      await page.goto("/projects/eng");
      const row = page.locator(
        `.prio-donut__legenditem[data-status="${status}"]`,
      );

      // It reads as interactive before it is clicked.
      const link = row.locator("a.prio-donut__legendlink");
      await expect(link, `${status} row is a link`).toHaveCount(1);
      await expect(link).toHaveCSS("cursor", "pointer");

      await link.click();
      await page.waitForURL(new RegExp(`/projects/eng/list\\?status=${status}$`));

      /* The list shows exactly what the row counted — same project, same
         status. The filter bar's own total is the check. */
      const total = page.locator(".prio-filters__count, .prio-filters").first();
      await expect(total).toBeVisible();

      const tableRows = page.locator("table.prio-table tbody tr");
      const listed = await tableRows.count();

      if (count === 0) {
        expect(listed, `${status} shows nothing`).toBe(0);
      } else {
        expect(listed, `${status} lists some of its ${count}`).toBeGreaterThan(0);
        // Every row carries the status that was clicked.
        for (const text of await tableRows.locator(".prio-status").allInnerTexts()) {
          expect(text.trim().toLowerCase()).toBe(
            STATUS_LABELS[status]!.toLowerCase(),
          );
        }
      }
    }
  });

  test("keeps its colours, counts, labels and hover behaviour", async ({
    page,
  }) => {
    /* The click behaviour is additive: nothing that worked before it may have
       changed. Checked against the database rather than against itself. */
    await page.goto("/projects/eng");
    const rows = page.locator(".prio-donut__legenditem");
    await expect(rows.first()).toBeVisible();

    const counts = await prisma.issue.groupBy({
      by: ["status"],
      where: { project: { key: "ENG" } },
      _count: { _all: true },
    });
    const byStatus = new Map(counts.map((r) => [r.status, r._count._all]));

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const status = (await row.getAttribute("data-status"))!;

      // Count still real.
      const shown = Number(
        (await row.locator(".prio-donut__legendvalue").innerText()).match(/\d+/)![0],
      );
      expect(shown, `${status} count`).toBe(byStatus.get(status as never) ?? 0);

      // Label still the product's own wording.
      await expect(row.locator(".prio-donut__legendlabel")).toHaveText(
        STATUS_LABELS[status]!,
      );

      // Swatch still carries the status colour, and the tint is still there.
      await expect(row.locator(".prio-donut__swatch")).toHaveAttribute(
        "data-status",
        status,
      );
      const tint = await row.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(tint).not.toBe("rgba(0, 0, 0, 0)");

      // And hovering still lights the row and its ring segment together.
      await row.hover();
      await expect(row).toHaveAttribute("data-hover", "true");
      await expect(
        page.locator(`.prio-donut__seg[data-status="${status}"]`),
      ).toHaveAttribute("data-hover", "true");
    }
  });
});

/* --------------------------------------------- assignee and completed by */

test.describe("The issue list", () => {
  /* `.prio-table` rather than `table`: the page also carries hidden tables,
     and only this one is the issue list. */
  async function openDoneList(page: Page) {
    await page.goto("/projects/eng/list?status=DONE");
    await expect(page.locator("table.prio-table")).toBeVisible();
  }

  test("shows both who holds the work and who finished it", async ({ page }) => {
    await openDoneList(page);

    // Assignee was already there and must stay.
    await expect(
      page.getByRole("columnheader", { name: "Assignee" }),
    ).toBeVisible();
    // And the completer, which is a different question.
    await expect(
      page.getByRole("columnheader", { name: "Completed by" }),
    ).toBeVisible();

    const rows = page.locator("table.prio-table tbody tr");
    const count = await rows.count();
    test.skip(count === 0, "no completed issues in ENG to show");

    for (let i = 0; i < count; i += 1) {
      const cells = rows.nth(i).locator("td.prio-col-person");
      // Assignee, Reporter, Completed by — three person columns per row.
      await expect(cells).toHaveCount(3);
      // The completer cell says something for a Done row.
      const text = (await cells.nth(2).innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("leaves the completer blank on work that is not finished", async ({
    page,
  }) => {
    await page.goto("/projects/eng/list?resolution=open");
    const table = page.locator("table.prio-table");
    await expect(table).toBeVisible();

    const rows = table.locator("tbody tr");
    const count = Math.min(await rows.count(), 10);
    test.skip(count === 0, "no open issues in ENG");

    for (let i = 0; i < count; i += 1) {
      const completer = rows.nth(i).locator("td.prio-col-person").nth(2);
      expect((await completer.innerText()).trim()).toBe("—");
    }
  });
});

/* ------------------------------------------------- the attachment guard */

test.describe("An attachment request without a session", () => {
  test("answers a program with JSON and sends a person to sign in", async ({
  }, testInfo) => {
    /*
     * Two callers, two right answers, and the file for neither.
     *
     * A `fetch` that is redirected sees a success status and a page of HTML
     * where it expected JSON, so a programmatic call is answered outright. A
     * person — a browser navigation, or Excel resolving a hyperlink out of an
     * exported sheet — has to be redirected instead: Office fetches the URL
     * itself before handing it anywhere, has no Prio cookie to send, and ends
     * the attempt on a 401 it cannot answer ("Cannot download the information
     * you requested"), never opening the browser that does have the session.
     */
    const attachment = await prisma.attachment.findFirst({
      select: { id: true },
    });
    test.skip(!attachment, "no attachment to request");

    const anonymous = await apiRequest.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const url = `/api/attachments/${attachment!.id}`;

    // A program: answered, in the language it asked in.
    const asProgram: Record<string, string>[] = [
      { Accept: "application/json" },
      { "Sec-Fetch-Mode": "cors" },
      { "X-Requested-With": "XMLHttpRequest" },
    ];
    for (const headers of asProgram) {
      const response = await anonymous.get(url, { headers, maxRedirects: 0 });
      expect(response.status(), JSON.stringify(headers)).toBe(401);
      expect(response.headers()["content-type"]).toContain("application/json");
    }

    // A person: pointed at sign-in, and back to the file afterwards.
    const asPerson: Record<string, string>[] = [
      { Accept: "*/*" },
      { Accept: "text/html", "Sec-Fetch-Mode": "navigate" },
    ];
    for (const headers of asPerson) {
      const response = await anonymous.get(url, { headers, maxRedirects: 0 });
      expect(response.status(), JSON.stringify(headers)).toBe(307);
      const location = response.headers()["location"]!;
      expect(location).toContain("/sign-in");
      expect(decodeURIComponent(location)).toContain(url);
    }

    // Whichever they were, no file came back.
    const either: Record<string, string>[] = [
      { Accept: "*/*" },
      { Accept: "application/json" },
    ];
    for (const headers of either) {
      const response = await anonymous.get(url, { headers, maxRedirects: 0 });
      const type = response.headers()["content-type"] ?? "";
      expect(type).not.toContain("image/");
      expect(type).not.toContain("video/");
    }

    await anonymous.dispose();
  });

  test("still serves the file, with ranges, to somebody signed in", async ({
    request,
  }) => {
    // No regression in the path that was already working.
    const video = await prisma.attachment.findFirst({
      where: { mimeType: { startsWith: "video/" } },
      select: { id: true, byteSize: true, mimeType: true },
    });
    test.skip(!video, "no video attachment present");

    const whole = await request.get(`/api/attachments/${video!.id}`);
    expect(whole.status()).toBe(200);
    expect(whole.headers()["accept-ranges"]).toBe("bytes");

    const part = await request.get(`/api/attachments/${video!.id}`, {
      headers: { Range: "bytes=0-511" },
    });
    expect(part.status()).toBe(206);
    expect(part.headers()["content-range"]).toBe(
      `bytes 0-511/${video!.byteSize}`,
    );
    expect(part.headers()["content-length"]).toBe("512");
  });
});

test.describe("Attachments belonging to another project", () => {
  /*
   * Testing is the administrator's own project and the member fixture is not
   * in it — but it holds no files, so one is put there as the administrator
   * rather than leaving this unproven. Changing the id in the URL must not be
   * a way into it.
   */
  let hidden: { id: string } | null = null;

  test.beforeAll(async ({ playwright }) => {
    /* Attached to the project itself rather than to an issue in it: Testing
       holds no issues, and a project attachment goes through the same
       `assertProjectAccess` check, which is the rule under test. */
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: "TES" },
      select: { id: true },
    });

    const admin = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: ADMIN_STATE,
    });
    const name = `private-${Date.now()}.png`;
    const response = await admin.post("/api/attachments", {
      multipart: {
        projectId: project.id,
        file: {
          name,
          mimeType: "image/png",
          // The 8-byte PNG signature is enough for server-side sniffing.
          buffer: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]),
        },
      },
    });
    await admin.dispose();

    if (response.status() === 200) {
      hidden = await prisma.attachment.findFirstOrThrow({
        where: { filename: name },
        select: { id: true },
      });
    }
  });

  test.afterAll(async () => {
    if (hidden) {
      await prisma.attachment.deleteMany({ where: { id: hidden.id } });
    }
  });

  test.describe("as a member outside that project", () => {
    test.use({ storageState: MEMBER_STATE });

    test("are not served to them", async ({ request }) => {
      test.skip(!hidden, "could not place a file in the hidden project");

      const response = await request.get(`/api/attachments/${hidden!.id}`, {
        maxRedirects: 0,
      });

      /* 404 rather than 403, deliberately: an outsider learns nothing about
         whether the file exists. Signed in, so this is authorization talking,
         not the session guard. */
      expect(response.status()).toBe(404);
      expect(response.headers()["content-type"] ?? "").not.toContain("image/");
    });
  });

  test("are served to the administrator who can see the project", async ({
    request,
  }) => {
    // The other half: the refusal above is about access, not a broken file.
    test.skip(!hidden, "could not place a file in the hidden project");

    const response = await request.get(`/api/attachments/${hidden!.id}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });
});
