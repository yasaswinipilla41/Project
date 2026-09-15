import { expect, test, type Browser } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_EMAIL, MEMBER_STATE, watchForProblems } from "./support";

/**
 * The Create window's Minimize and Maximize, beside the Close it always had,
 * and New on its Status list.
 *
 * Minimize and Maximize are presentation only, so what is worth pinning is
 * that nothing is lost across them: the typed summary and description, the
 * chosen priority, a staged attachment. And that the page behind a minimised
 * form really is usable — scroll released, navigation working — while the form
 * waits at the bottom of the window.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdTitles: string[] = [];

test.afterAll(async () => {
  if (createdTitles.length > 0) {
    await prisma.issue.deleteMany({ where: { title: { in: createdTitles } } });
  }
});

test.describe("The Create window", () => {
  test("minimises, maximises and restores without losing anything, and Close still closes", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const dialog = page.getByRole("dialog", { name: /create/i });
    await expect(dialog).toBeVisible();

    const title = `Window controls ${Date.now()}`;
    const description = "Kept across minimise and maximise.";
    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Summary").fill(title);
    await dialog.getByLabel("Description").fill(description);
    await dialog.getByLabel("Priority").selectOption("HIGH");
    await dialog
      .getByLabel("Attachments")
      .setInputFiles({ name: "kept.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(dialog.getByTitle("kept.png")).toBeVisible();

    // [Minimize] [Maximize] [Close], in the header.
    const minimize = dialog.getByRole("button", { name: "Minimize dialog" });
    const maximize = dialog.getByRole("button", { name: "Maximize dialog" });
    const close = dialog.getByRole("button", { name: "Close dialog" });
    await expect(minimize).toBeVisible();
    await expect(maximize).toBeVisible();
    await expect(close).toBeVisible();
    const [minBox, maxBox, closeBox] = await Promise.all([
      minimize.boundingBox(),
      maximize.boundingBox(),
      close.boundingBox(),
    ]);
    expect(minBox!.x).toBeLessThan(maxBox!.x);
    expect(maxBox!.x).toBeLessThan(closeBox!.x);

    const kept = async () => {
      await expect(dialog.getByLabel("Summary")).toHaveValue(title);
      await expect(dialog.getByLabel("Description")).toHaveValue(description);
      await expect(dialog.getByLabel("Priority")).toHaveValue("HIGH");
      await expect(dialog.getByTitle("kept.png")).toBeVisible();
    };

    // Maximise, and back.
    const normal = (await dialog.boundingBox())!;
    await maximize.click();
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => (await dialog.boundingBox())!.width)
      .toBeGreaterThan(viewport.width - 80);
    await expect
      .poll(async () => (await dialog.boundingBox())!.height)
      .toBeGreaterThan(viewport.height - 80);
    await kept();
    await dialog.getByRole("button", { name: "Restore dialog size" }).click();
    await expect
      .poll(async () => Math.round((await dialog.boundingBox())!.width))
      .toBe(Math.round(normal.width));
    await kept();

    // Minimise: folded to its title bar at the bottom of the window.
    await dialog.getByRole("button", { name: "Minimize dialog" }).click();
    await expect(dialog.getByLabel("Summary")).toBeHidden();
    const bar = (await dialog.boundingBox())!;
    expect(bar.height).toBeLessThan(90);
    expect(bar.y + bar.height).toBeGreaterThan(viewport.height - 60);
    await expect(dialog).toHaveAttribute("aria-modal", "false");

    // The page behind is usable while it waits.
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    await page.locator('.prio-sidebar a[href="/issues"]').click();
    await expect(page).toHaveURL(/\/issues/);
    await expect(dialog).toBeVisible();

    // Restore: everything as it was.
    await dialog.getByRole("button", { name: "Restore dialog" }).click();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await kept();

    // Minimised then maximised goes straight to full size, still intact.
    await dialog.getByRole("button", { name: "Minimize dialog" }).click();
    await dialog.getByRole("button", { name: "Maximize dialog" }).click();
    await kept();
    await dialog.getByRole("button", { name: "Restore dialog size" }).click();

    // Close still closes, exactly as before.
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("offers New on Status, and an issue created as New is New everywhere", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();
    const dialog = page.getByRole("dialog", { name: /create/i });

    const title = `Created as New ${Date.now()}`;
    createdTitles.push(title);
    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Summary").fill(title);

    const status = dialog.getByLabel("Status");
    const options = await status.locator("option").allTextContents();
    expect(options).toContain("New");
    // Nothing that was offered before has gone.
    for (const existing of ["Backlog", "In Progress", "Ready for QA", "In QA", "Done"]) {
      expect(options).toContain(existing);
    }

    await status.selectOption({ label: "New" });
    await dialog.getByRole("button", { name: /^Create (Task|Issue)/ }).click();
    await expect(page).toHaveURL(/\/issues\/eng-\d+/);
    await expect(page.locator(".prio-issue__headmeta")).toContainText("New");

    const row = await prisma.issue.findFirstOrThrow({
      where: { title },
      select: { status: true },
    });
    expect(row.status).toBe("TODO");

    // And in the list.
    await page.goto(`/issues?q=${encodeURIComponent(title)}`);
    const list = page.locator("table.prio-table");
    await expect(list).toContainText(title);
    await expect(list).toContainText("New");
  });
});

/** Puts the member on Testing — and only Testing — for one test. */
async function asTester(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const testing =
    (await prisma.team.findUnique({ where: { slug: "testing" }, select: { id: true } })) ??
    (await prisma.team.create({ data: { slug: "testing", name: "Testing" }, select: { id: true } }));
  const development = await prisma.team.findUnique({
    where: { slug: "development" },
    select: { id: true },
  });

  const hadTesting = await prisma.teamMember.findFirst({
    where: { teamId: testing.id, userId: user.id },
  });
  const hadDevelopment = development
    ? await prisma.teamMember.findFirst({ where: { teamId: development.id, userId: user.id } })
    : null;

  if (!hadTesting) {
    await prisma.teamMember.create({ data: { teamId: testing.id, userId: user.id } });
  }
  if (hadDevelopment) {
    await prisma.teamMember.delete({ where: { id: hadDevelopment.id } });
  }

  return async () => {
    if (!hadTesting) {
      await prisma.teamMember.deleteMany({ where: { teamId: testing.id, userId: user.id } });
    }
    if (hadDevelopment && development) {
      await prisma.teamMember.create({ data: { teamId: development.id, userId: user.id } });
    }
  };
}

async function openCreateAs(browser: Browser) {
  const context = await browser.newContext({ storageState: MEMBER_STATE });
  const page = await context.newPage();
  await page.goto("/");
  await page.locator(".prio-create__main").click();
  const dialog = page.getByRole("dialog", { name: /create/i });
  await expect(dialog).toBeVisible();
  return { context, dialog };
}

test("a QA member's Create form offers New beside Backlog, and keeps its window controls", async ({
  browser,
}) => {
  const restore = await asTester(MEMBER_EMAIL);
  try {
    const { context, dialog } = await openCreateAs(browser);
    const options = await dialog.getByLabel("Status").locator("option").allTextContents();
    expect(options).toEqual(["Backlog", "New"]);
    // Backlog is still what a tester files into by default.
    await expect(dialog.getByLabel("Status")).toHaveValue("BACKLOG");
    await expect(dialog.getByRole("button", { name: "Minimize dialog" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Maximize dialog" })).toBeVisible();
    await context.close();
  } finally {
    await restore();
  }
});
