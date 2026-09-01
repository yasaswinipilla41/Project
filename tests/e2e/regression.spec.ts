import { expect, test, type Page } from "@playwright/test";
import { MEMBER_STATE } from "./support";

/**
 * Regressions for defects found earlier in the build, exercised through the UI.
 *
 * The headline one: `updateIssue` derived its schema from the create schema, so
 * Zod's defaults filled in every omitted field. Changing a bug's priority
 * silently cleared its severity and reset its status. These tests change one
 * field at a time and assert the others are untouched.
 */

/**
 * Open the Activity tab.
 *
 * Comments and system events used to share one list; they are separate tabs
 * now, and Comments opens first. The audit trail is unchanged and complete —
 * it is one click away, which is what these assertions take.
 */
async function openActivity(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: /^Activity/ });
  /* Waited for, not skipped when absent: called straight after a navigation
     the tabs have not rendered yet, and returning early would leave Comments
     showing and every assertion below looking at the wrong list. */
  await tab.waitFor({ timeout: 15_000 });
  await tab.click();
  /* Both tabs render the same `<ol class="prio-activity">`, so waiting for
     that element proves nothing — it is already on screen under Comments.
     The tab reporting itself selected is the signal that the swap happened. */
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

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
    await openActivity(page);
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
      await openActivity(page);
      /* The trail collapses older events behind a toggle. Both counts below
         must be of the whole list, or a list capped at the same number twice
         would read as "nothing was appended". */
      const more = page.locator(".prio-conversation__more");
      if (await more.count()) {
        await more.click();
        await expect(more).toHaveCount(0);
      }
    };
    await expand();

    const entries = page.locator(".prio-activity__item");
    const before = await entries.count();
    expect(before).toBeGreaterThan(0);

    // The seeded bug walked Backlog -> Todo -> In Progress -> In Review.
    const text = await page.locator(".prio-activity").innerText();
    expect(text).toContain("reported this bug");
    expect(text).toContain("changed status");

    /* Making a change appends rather than rewrites.
     *
     * The new priority is chosen against the current one rather than being
     * hard-coded: setting a value the issue already holds is a no-op that
     * writes no activity and raises no toast, so a fixed choice made this test
     * pass once and fail on every later run against the same database. */
    const priorityNow = await page
      .locator(".prio-issue__headmeta .prio-priority")
      .first()
      .getAttribute("data-priority");
    const nextPriority = priorityNow === "MEDIUM" ? /High/ : /Medium/;

    await page.locator(".prio-issue__headmeta .prio-priority").first().click();
    await page.getByRole("menuitemradio", { name: nextPriority }).click();
    await expect(page.locator(".prio-toast")).toContainText("Priority set to");
    await page.reload();
    await expand();

    expect(await entries.count()).toBeGreaterThan(before);
    // The original entries are still present, unmodified.
    const after = await page.locator(".prio-activity").innerText();
    expect(after).toContain("reported this bug");

    /* Put it back where it started, so the issue is as it was found and the
       next run of this test begins from the same place. */
    const PRIORITY_LABEL: Record<string, RegExp> = {
      URGENT: /Urgent/,
      HIGH: /High/,
      MEDIUM: /Medium/,
      LOW: /Low/,
      NONE: /None/,
    };
    const restoreTo = PRIORITY_LABEL[priorityNow ?? "MEDIUM"] ?? /Medium/;
    await page.locator(".prio-issue__headmeta .prio-priority").first().click();
    await page.getByRole("menuitemradio", { name: restoreTo }).click();
    await expect(page.locator(".prio-toast")).toContainText("Priority set to");
  });
});

test.describe("inline editing", () => {
  test("editing one field leaves every other field untouched", async ({ page }) => {
    await page.goto("/issues/eng-2");

    const before = {
      status: await page.locator(".prio-status").first().getAttribute("data-status"),
      severity: await page
        .locator(".prio-severity")
        .first()
        .getAttribute("data-severity"),
      title: await page.locator(".prio-issue__title").innerText(),
    };

    /*
     * Edits the title. This used to edit the description, which is no longer
     * inline-editable anywhere in Prio — the property being pinned down is
     * unchanged: one edit must not disturb its neighbours.
     */
    const marker = `Verified inline edit ${Date.now().toString(36)}`;
    /*
     * Strip any marker a previous interrupted run left behind, so the title
     * cannot compound across runs — the earlier version restored whatever it
     * found, which meant one failure permanently lengthened the seeded title.
     */
    const restored = before.title.replace(/\s*Verified inline edit \w+/g, "").trim();

    await page.getByRole("button", { name: "Edit title" }).click();
    const editor = page.locator(".prio-editable__form");
    await editor.getByLabel("Issue title", { exact: true }).fill(`${restored} ${marker}`);
    await editor.getByRole("button", { name: "Save" }).click();
    // Wait for the write to be acknowledged before reloading, or the reload
    // can race the save and read back the previous title.
    await expect(page.locator(".prio-toast")).toContainText("Title updated");

    await page.reload();
    await expect(page.locator(".prio-issue__title")).toContainText(marker);

    // Everything else is exactly as it was.
    await expect(page.locator(".prio-status").first()).toHaveAttribute(
      "data-status",
      before.status!,
    );
    await expect(page.locator(".prio-severity").first()).toHaveAttribute(
      "data-severity",
      before.severity!,
    );

    // The trail records the rename.
    await openActivity(page);
    const activity = await page.locator(".prio-activity").innerText();
    expect(activity).toContain("changed the title");

    // Restore.
    await page.getByRole("button", { name: "Edit title" }).click();
    const restoreEditor = page.locator(".prio-editable__form");
    await restoreEditor.getByLabel("Issue title", { exact: true }).fill(restored);
    await restoreEditor.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".prio-toast").last()).toContainText("Title updated");

    await page.reload();
    await expect(page.locator(".prio-issue__title")).toHaveText(restored);
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
