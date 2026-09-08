import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_STATE } from "./support";
import { TESTING_TEAM_SLUG } from "@/lib/authz";

/**
 * Creating and editing work from the project calendar.
 *
 * The calendar used to be a read-only month view: it drew issues that already
 * had a due date and offered no way to give one. Clicking a day now opens a
 * composer on that day, and what it writes is an ordinary issue — the same row
 * the board and the list read — so the properties worth defending are the ones
 * that would make it *not* ordinary:
 *
 *   - it lands on the day that was clicked, not the day before or after;
 *   - it belongs to the project whose calendar it was created from;
 *   - it survives a reload, and another member sees it;
 *   - clicking an existing item opens that issue rather than creating another.
 */

const stamp = () => Math.random().toString(36).slice(2, 7).toUpperCase();

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
});

/** The month the calendar is showing, as the page's own `?month=` value. */
function monthParam(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A day in the current month that is safe to click (never the 29th–31st). */
const DAY_A = 8;
const DAY_B = 17;

async function openCalendar(page: Page, projectKey: string, month: string) {
  await page.goto(`/projects/${projectKey.toLowerCase()}/calendar?month=${month}`);
  await page.waitForSelector(".prio-calendar");
}

/** The cell for a given day of the month. */
function cell(page: Page, day: number) {
  return page
    .locator(".prio-calendar__cell:not([data-empty])")
    .filter({ has: page.locator(`.prio-calendar__day:text-is("${day}")`) })
    .first();
}

/** Opens the composer on `day` and files an issue through it. */
async function createOnDay(
  page: Page,
  day: number,
  title: string,
  options: { type?: string; assignee?: string } = {},
) {
  const target = cell(page, day);
  await target.hover();
  await target.locator(".prio-calendar__add").click();

  const composer = page.locator(".prio-calendar__composer");
  await expect(composer).toBeVisible();

  await composer.getByLabel("What needs to be done?").fill(title);
  if (options.type) {
    await composer.getByLabel("Issue type").selectOption({ label: options.type });
  }
  if (options.assignee) {
    await composer
      .getByLabel("Assignee")
      .selectOption({ label: options.assignee });
  }
  await composer.getByRole("button", { name: "Create", exact: true }).click();

  // The composer closes on success, and the page re-queries.
  await expect(composer).toBeHidden({ timeout: 20_000 });
}

/** Registers a created issue for cleanup and returns its row. */
async function trackByTitle(title: string) {
  const issue = await prisma.issue.findFirstOrThrow({
    where: { title },
    select: {
      id: true,
      key: true,
      dueDate: true,
      type: true,
      projectId: true,
      assigneeId: true,
      project: { select: { key: true } },
    },
  });
  created.push(issue.id);
  return issue;
}

test.describe("Creating from a calendar date", () => {
  test("an admin files an issue on the day they clicked, and it stays there", async ({
    page,
  }) => {
    const month = monthParam(new Date());
    const title = `Calendar admin ${stamp()}`;

    await openCalendar(page, "ENG", month);
    await createOnDay(page, DAY_A, title, { type: "Bug" });

    // On screen, in that day's cell, straight away — no reload needed.
    await expect(
      cell(page, DAY_A).locator(".prio-calendar__issue", { hasText: title }),
    ).toBeVisible({ timeout: 20_000 });

    const issue = await trackByTitle(title);

    /* The day that was clicked, read back from the database. A date-only value
       is stored at UTC midnight, so this is the assertion that would fail if a
       timezone conversion moved it. */
    expect(issue.dueDate).not.toBeNull();
    expect(issue.dueDate!.toISOString().slice(0, 10)).toBe(
      `${month}-${String(DAY_A).padStart(2, "0")}`,
    );
    expect(issue.type).toBe("BUG");
    expect(issue.project.key).toBe("ENG");

    // And it is still there, on the same day, after a reload.
    await page.reload();
    await expect(
      cell(page, DAY_A).locator(".prio-calendar__issue", { hasText: title }),
    ).toBeVisible();
  });

  test("several days each keep their own date", async ({ page }) => {
    const month = monthParam(new Date());
    const first = `Calendar day-a ${stamp()}`;
    const second = `Calendar day-b ${stamp()}`;

    await openCalendar(page, "ENG", month);
    await createOnDay(page, DAY_A, first);
    await createOnDay(page, DAY_B, second);

    const a = await trackByTitle(first);
    const b = await trackByTitle(second);

    expect(a.dueDate!.toISOString().slice(0, 10)).toBe(
      `${month}-${String(DAY_A).padStart(2, "0")}`,
    );
    expect(b.dueDate!.toISOString().slice(0, 10)).toBe(
      `${month}-${String(DAY_B).padStart(2, "0")}`,
    );

    await page.reload();
    await expect(
      cell(page, DAY_A).locator(".prio-calendar__issue", { hasText: first }),
    ).toBeVisible();
    await expect(
      cell(page, DAY_B).locator(".prio-calendar__issue", { hasText: second }),
    ).toBeVisible();
  });

  test("the issue belongs to the project whose calendar made it", async ({
    page,
  }) => {
    const month = monthParam(new Date());
    const title = `Calendar isolation ${stamp()}`;

    await openCalendar(page, "ENG", month);
    await createOnDay(page, DAY_A, title);

    const issue = await trackByTitle(title);
    expect(issue.project.key).toBe("ENG");

    // Another project's calendar, same month, does not show it.
    await openCalendar(page, "WEB", month);
    await expect(
      page.locator(".prio-calendar__issue", { hasText: title }),
    ).toHaveCount(0);
  });

  test("refuses an empty title, and does not write anything", async ({ page }) => {
    const month = monthParam(new Date());
    await openCalendar(page, "ENG", month);

    const before = await prisma.issue.count({ where: { project: { key: "ENG" } } });

    const target = cell(page, DAY_A);
    await target.hover();
    await target.locator(".prio-calendar__add").click();

    const composer = page.locator(".prio-calendar__composer");
    await composer.getByRole("button", { name: "Create", exact: true }).click();

    await expect(composer.getByRole("alert")).toBeVisible();
    await expect(composer).toBeVisible();
    expect(
      await prisma.issue.count({ where: { project: { key: "ENG" } } }),
    ).toBe(before);
  });

  test("Escape and Cancel both close it without writing", async ({ page }) => {
    const month = monthParam(new Date());
    await openCalendar(page, "ENG", month);

    const before = await prisma.issue.count({ where: { project: { key: "ENG" } } });
    const composer = page.locator(".prio-calendar__composer");

    // Escape.
    const target = cell(page, DAY_A);
    await target.hover();
    await target.locator(".prio-calendar__add").click();
    await expect(composer).toBeVisible();
    await composer.getByLabel("What needs to be done?").fill("never saved");
    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();

    // Cancel.
    await target.hover();
    await target.locator(".prio-calendar__add").click();
    await expect(composer).toBeVisible();
    await composer.getByRole("button", { name: "Cancel" }).click();
    await expect(composer).toBeHidden();

    expect(
      await prisma.issue.count({ where: { project: { key: "ENG" } } }),
    ).toBe(before);
  });

  test("clicking an existing item opens that issue instead of creating one", async ({
    page,
  }) => {
    const month = monthParam(new Date());
    const title = `Calendar open ${stamp()}`;

    await openCalendar(page, "ENG", month);
    await createOnDay(page, DAY_A, title);
    const issue = await trackByTitle(title);

    const before = await prisma.issue.count({ where: { project: { key: "ENG" } } });

    await cell(page, DAY_A)
      .locator(".prio-calendar__issue", { hasText: title })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/issues/${issue.key.toLowerCase()}$`),
    );
    // No second issue was filed by the click.
    expect(
      await prisma.issue.count({ where: { project: { key: "ENG" } } }),
    ).toBe(before);
  });

  test("existing calendar behaviour is untouched", async ({ page }) => {
    const month = monthParam(new Date());
    await openCalendar(page, "ENG", month);

    /* Weekday headers, Monday first. Read as rendered — the stylesheet
       uppercases them, and `innerText` reflects that. */
    expect(
      await page.locator(".prio-calendar__weekday").allInnerTexts(),
    ).toEqual(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

    // Month navigation still works, and still shares as a URL.
    const heading = page.locator(".prio-calendar__month");
    const shown = await heading.innerText();
    await page.getByRole("link", { name: "Next" }).click();
    await expect(heading).not.toHaveText(shown);
    await page.getByRole("link", { name: "Previous" }).click();
    await expect(heading).toHaveText(shown);

    // The project's own tab strip is still there and still on Calendar.
    await expect(
      page.locator(".prio-projectnav__tab[data-active]"),
    ).toHaveText("Calendar");
  });
});

test.describe("Creating from a calendar date as a tester", () => {
  test.use({ storageState: MEMBER_STATE });

  /*
   * Filing work is a tester's act, so the member is put on the Testing team
   * for the run — the seed puts nobody on it, which makes every member a
   * developer, and the day composer is not offered to a developer at all.
   */
  let leaveTeam: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const member = await prisma.user.findUniqueOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true },
    });
    const team =
      (await prisma.team.findUnique({
        where: { slug: TESTING_TEAM_SLUG },
        select: { id: true },
      })) ??
      (await prisma.team.create({
        data: { slug: TESTING_TEAM_SLUG, name: "Testing" },
        select: { id: true },
      }));
    const already = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: member.id },
      select: { id: true },
    });
    if (already) return;
    const added = await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id },
      select: { id: true },
    });
    leaveTeam = async () => {
      await prisma.teamMember.deleteMany({ where: { id: added.id } });
    };
  });

  test.afterAll(async () => {
    if (leaveTeam) await leaveTeam();
  });

  test("a tester can file one, and it persists for everyone", async ({ page }) => {
    const month = monthParam(new Date());
    const title = `Calendar member ${stamp()}`;

    await openCalendar(page, "ENG", month);
    await createOnDay(page, DAY_B, title);

    await expect(
      cell(page, DAY_B).locator(".prio-calendar__issue", { hasText: title }),
    ).toBeVisible({ timeout: 20_000 });

    const issue = await trackByTitle(title);
    expect(issue.dueDate!.toISOString().slice(0, 10)).toBe(
      `${month}-${String(DAY_B).padStart(2, "0")}`,
    );

    /* Shared, not per-viewer: it is a row in the project, so the next person
       to open this calendar sees it. Asserted through a second browser
       context signed in as somebody else. */
    const admin = await page.context().browser()!.newContext({
      storageState: "test-results/.auth/admin.json",
    });
    const adminPage = await admin.newPage();
    await adminPage.goto(`/projects/eng/calendar?month=${month}`);
    await expect(
      adminPage.locator(".prio-calendar__issue", { hasText: title }),
    ).toBeVisible({ timeout: 20_000 });
    await admin.close();
  });
});
