import { expect, test } from "@playwright/test";
import { MEMBER_STATE } from "./support";

/**
 * Regressions for defects found earlier in the build, exercised through the UI.
 *
 * The headline one: `updateIssue` derived its schema from the create schema, so
 * Zod's defaults filled in every omitted field. Changing a bug's priority
 * silently cleared its severity and reset its status. These tests change one
 * field at a time and assert the others are untouched.
 */

test.describe("update regressions", () => {
  test("changing only priority leaves severity and status untouched", async ({
    page,
  }) => {
    // ENG-1 is a seeded bug: In Progress / High / Major.
    await page.goto("/issues/eng-1");

    const severity = page.locator(".prio-severity").first();
    const status = page.locator(".prio-status").first();

    const severityBefore = await severity.getAttribute("data-severity");
    const statusBefore = await status.getAttribute("data-status");
    expect(severityBefore).toBe("MAJOR");
    expect(statusBefore).toBe("IN_PROGRESS");

    const title = await page.locator(".prio-issue__title").innerText();
    const reporter = await page.locator(".prio-issue__aside").innerText();

    // Change ONLY the priority, through the inline control.
    await page.locator(".prio-issue__headmeta .prio-priority").first().click();
    await page.getByRole("menuitemradio", { name: /Urgent/ }).click();
    await expect(page.locator(".prio-toast")).toContainText("Priority set to");

    await page.reload();

    // Priority changed…
    await expect(page.locator(".prio-priority").first()).toHaveAttribute(
      "data-priority",
      "URGENT",
    );
    // …and nothing else did.
    await expect(page.locator(".prio-severity").first()).toHaveAttribute(
      "data-severity",
      severityBefore!,
    );
    await expect(page.locator(".prio-status").first()).toHaveAttribute(
      "data-status",
      statusBefore!,
    );
    await expect(page.locator(".prio-issue__title")).toHaveText(title);
    await expect(page.locator(".prio-issue__aside")).toContainText(
      "Sneha Iyer",
    );
    expect(reporter).toContain("Sneha Iyer");

    // The trail records exactly one field change, naming priority only.
    const activity = await page.locator(".prio-activity").innerText();
    expect(activity).toContain("changed the priority");
    expect(activity).not.toContain("changed the severity");

    // Restore the seeded value so the suite is re-runnable.
    await page.locator(".prio-issue__headmeta .prio-priority").first().click();
    await page.getByRole("menuitemradio", { name: /High/ }).click();
    await expect(page.locator(".prio-toast")).toContainText("Priority set to");
  });

  test("changing only status leaves severity and priority untouched", async ({
    page,
  }) => {
    await page.goto("/issues/eng-2");

    const severityBefore = await page
      .locator(".prio-severity")
      .first()
      .getAttribute("data-severity");
    const priorityBefore = await page
      .locator(".prio-priority")
      .first()
      .getAttribute("data-priority");

    await page.locator(".prio-issue__headmeta .prio-status").first().click();
    await page.getByRole("menuitemradio", { name: "In Progress" }).click();
    await expect(page.locator(".prio-toast")).toContainText("Moved to");

    await page.reload();

    await expect(page.locator(".prio-status").first()).toHaveAttribute(
      "data-status",
      "IN_PROGRESS",
    );
    await expect(page.locator(".prio-severity").first()).toHaveAttribute(
      "data-severity",
      severityBefore!,
    );
    await expect(page.locator(".prio-priority").first()).toHaveAttribute(
      "data-priority",
      priorityBefore!,
    );

    // Restore.
    await page.locator(".prio-issue__headmeta .prio-status").first().click();
    await page.getByRole("menuitemradio", { name: "Todo" }).click();
    await expect(page.locator(".prio-toast")).toContainText("Moved to");
  });

  test("activity history is append-only and reads honestly", async ({ page }) => {
    await page.goto("/issues/eng-3");

    /* Older events collapse behind a toggle so the comment composer stays
       within reach. This test is about the whole trail, so it opens it. */
    const expand = async () => {
      const more = page.locator(".prio-conversation__more");
      if (await more.count()) await more.click();
    };
    await expand();

    const entries = page.locator(".prio-activity__item");
    const before = await entries.count();
    expect(before).toBeGreaterThan(0);

    // The seeded bug walked Backlog -> Todo -> In Progress -> In Review.
    const text = await page.locator(".prio-activity").innerText();
    expect(text).toContain("reported this bug");
    expect(text).toContain("changed status");

    // Making a change appends rather than rewrites.
    await page.locator(".prio-issue__headmeta .prio-priority").first().click();
    await page.getByRole("menuitemradio", { name: /Medium/ }).click();
    await expect(page.locator(".prio-toast")).toContainText("Priority set to");
    await page.reload();
    await expand();

    expect(await entries.count()).toBeGreaterThan(before);
    // The original entries are still present, unmodified.
    const after = await page.locator(".prio-activity").innerText();
    expect(after).toContain("reported this bug");

    await page.locator(".prio-issue__headmeta .prio-priority").first().click();
    await page.getByRole("menuitemradio", { name: /Urgent/ }).click();
    await expect(page.locator(".prio-toast")).toContainText("Priority set to");
  });
});

test.describe("inline editing", () => {
  test("editing one field leaves every other field untouched", async ({ page }) => {
    await page.goto("/issues/eng-2");

    const before = {
      status: await page.locator(".prio-status").first().getAttribute("data-status"),
      priority: await page
        .locator(".prio-priority")
        .first()
        .getAttribute("data-priority"),
      severity: await page
        .locator(".prio-severity")
        .first()
        .getAttribute("data-severity"),
      title: await page.locator(".prio-issue__title").innerText(),
    };

    // Edit only the description.
    const marker = `Verified inline edit ${Date.now().toString(36)}`;
    await page.getByRole("button", { name: "Edit description" }).click();
    const editor = page.getByLabel("Description", { exact: true });
    const original = await editor.inputValue();
    await editor.fill(`${original}
${marker}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".prio-toast")).toContainText("Description updated");

    await page.reload();
    await expect(page.getByText(marker)).toBeVisible();

    // Everything else is exactly as it was.
    await expect(page.locator(".prio-status").first()).toHaveAttribute(
      "data-status",
      before.status!,
    );
    await expect(page.locator(".prio-priority").first()).toHaveAttribute(
      "data-priority",
      before.priority!,
    );
    await expect(page.locator(".prio-severity").first()).toHaveAttribute(
      "data-severity",
      before.severity!,
    );
    expect(await page.locator(".prio-issue__title").innerText()).toContain(
      before.title.trim(),
    );

    // The trail records the description change and nothing else.
    const activity = await page.locator(".prio-activity").innerText();
    expect(activity).toContain("updated the description");

    // Restore.
    await page.getByRole("button", { name: "Edit description" }).click();
    await page.getByLabel("Description", { exact: true }).fill(original);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".prio-toast")).toContainText("Description updated");
  });
});

test.describe("authorization in the browser", () => {
  test.use({ storageState: MEMBER_STATE });

  test("a member sees no admin entry point and cannot reach admin content", async ({
    page,
  }) => {
    await page.goto("/");

    // The sidebar's Administration link is admin-only.
    await expect(
      page.locator(".prio-sidebar").getByRole("link", { name: "Administration" }),
    ).toHaveCount(0);

    // Navigating there directly yields no admin content.
    await page.goto("/admin");
    await expect(page.getByText("Deactivate users")).toHaveCount(0);
  });

  test("a member cannot create a project", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("button", { name: "New project" })).toHaveCount(
      0,
    );
  });
});
