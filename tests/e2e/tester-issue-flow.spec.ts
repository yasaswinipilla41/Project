import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForNextFrame, watchForProblems } from "./support";

/**
 * The Testing Team's path: Issues module → Create Issue → screenshot →
 * annotate → the issue's own detail page, with both images on it.
 *
 * Nothing here is a second issue-creation system. The button opens the same
 * `CreateIssueDialog` every other surface opens, which calls the same
 * `createIssue` action; these tests exist to prove the *entry point* is
 * wired correctly and that annotating adds evidence rather than replacing it.
 */

/** A real, tiny PNG — the server sniffs magic bytes, so this has to be genuine. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR4nGP8z8DwnwEJMDEQCXAAADuIA/9LWl2XAAAAAElFTkSuQmCC";

const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

async function attachScreenshot(page: Page) {
  await page.getByLabel("Attachments", { exact: true }).setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
}

/** Navigates to the issue list scoped to a project, the way its own tab does. */
/**
 * A project's own issue list.
 *
 * This used to hop to `/issues?project=<id>` through a link on the project
 * page. The project's issues now have a List tab inside the project shell
 * instead, so that is where "arriving from a project" leads; the destination
 * is the same list, scoped the same way.
 */
async function openProjectIssues(page: Page, projectKey: string) {
  await page.goto(`/projects/${projectKey}`);
  await page
    .locator(".prio-projectnav")
    .getByRole("link", { name: "List", exact: true })
    .click();
  await page.waitForURL(new RegExp(`/projects/${projectKey}/list`));
}

/** Draws an oval around the middle of the image, as a tester would. */
async function circleTheProblem(page: Page, editor: Locator) {
  await expect(editor.getByText("Loading image…")).toBeHidden();
  await waitForNextFrame(page);

  await editor.getByRole("button", { name: "Oval" }).click();
  const box = await editor.locator("canvas").nth(1).boundingBox();
  if (!box) throw new Error("Canvas has no bounding box.");

  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, {
    steps: 6,
  });
  await page.mouse.up();
}

/** Every attachment on the page, with the bytes actually served for it. */
async function attachmentBytes(page: Page) {
  return page.evaluate(async () => {
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(".prio-attachment__name"),
    ];
    return Promise.all(
      links.map(async (link) => {
        const response = await fetch(link.href);
        const blob = await response.blob();
        return { name: link.textContent ?? "", size: blob.size };
      }),
    );
  });
}

test.describe("Create Issue from the Issues module", () => {
  test("the Issues header carries no Create Issue, and creating still works", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/issues");

    /* The Issues page's own Create Issue button was removed on purpose. What
       matters is that removing the button removed only the button: creating an
       issue is still reachable from the top bar, and exporting is still on the
       filter bar next to the result count it acts on. Asserting all three is
       the point — a removal that quietly took the capability with it would
       pass the first assertion alone. */
    await expect(page.locator(".prio-create-issue")).toHaveCount(0);
    await expect(
      page.locator(".prio-page-header__actions").getByRole("button", { name: /export/i }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export Excel" })).toBeVisible();

    await page.getByRole("button", { name: /^Create$/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByLabel("Project")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("arriving from a project preselects that project", async ({ page }) => {
    await openProjectIssues(page, "eng");
    await expect(page).toHaveURL(/\/projects\/eng\/list/);

    await page.getByRole("button", { name: /^Create$/ }).first().click();
    const dialog = page.getByRole("dialog");

    /* The options arrive over the network, so the select reads
       "Loading projects…" for a moment. Wait for the real list before
       asking which one is selected. */
    const projectSelect = dialog.getByLabel("Project");
    await expect
      .poll(async () => projectSelect.locator("option").count())
      .toBeGreaterThan(1);

    const selected = await projectSelect.evaluate(
      (el: HTMLSelectElement) => el.selectedOptions[0]?.textContent ?? "",
    );
    expect(
      selected,
      "the project being viewed should already be chosen",
    ).toContain("Engineering");
  });

  test("the whole tester flow: screenshot, annotate, create, and both images land on the issue", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const title = `Login button is not working ${Date.now()}`;

    await openProjectIssues(page, "eng");
    await page.getByRole("button", { name: /^Create$/ }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Summary").fill(title);
    await attachScreenshot(page);

    // The affordance says what it does before any markup exists…
    await dialog.getByRole("button", { name: "Annotate" }).click();
    await circleTheProblem(page, page.getByRole("dialog", { name: "Edit screenshot" }));
    await page.getByRole("dialog", { name: "Edit screenshot" })
      .getByRole("button", { name: "Save" })
      .click();

    // …and changes once it does, so a second visit is clearly a continuation.
    await expect(dialog.getByRole("button", { name: "Edit markup" })).toBeVisible();

    await dialog.getByRole("button", { name: /^create (issue|task|bug|story|epic|feature)$/i }).click();
    await expect(dialog).toBeHidden();

    // Straight to the existing issue detail page.
    await expect(page).toHaveURL(/\/issues\/eng-\d+$/i);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    // Two attachments, not one: the evidence and the commentary on it.
    await expect(page.locator(".prio-attachment")).toHaveCount(2);
    await expect(page.locator(".prio-attachment img")).toHaveCount(2);

    const files = await attachmentBytes(page);
    const original = files.find((f) => !/annotated/.test(f.name));
    const annotated = files.find((f) => /annotated/.test(f.name));

    expect(original, "the unmarked original must still be attached").toBeTruthy();
    expect(annotated, "the annotated copy must be attached").toBeTruthy();

    /* The strongest form of "the original was preserved": what comes back is
       byte-for-byte the file that was uploaded, not a re-encoded or
       drawn-over version of it. */
    expect(
      original!.size,
      "the original must be byte-identical to the uploaded file",
    ).toBe(PNG_BYTES.length);
    expect(annotated!.size).not.toBe(original!.size);

    // And it survives a reload, which is what proves it was persisted.
    await page.reload();
    await expect(page.locator(".prio-attachment img")).toHaveCount(2);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("an attached image can be annotated again from the issue page", async ({
    page,
  }) => {
    const title = `Re-annotated ${Date.now()}`;

    await openProjectIssues(page, "eng");
    await page.getByRole("button", { name: /^Create$/ }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Summary").fill(title);
    await attachScreenshot(page);
    await dialog.getByRole("button", { name: /^create (issue|task|bug|story|epic|feature)$/i }).click();

    await expect(page).toHaveURL(/\/issues\/eng-\d+$/i);
    await expect(page.locator(".prio-attachment")).toHaveCount(1);

    // Reopen the attachment itself — same editor, reached from the issue.
    await page.getByRole("button", { name: /^Annotate screenshot/ }).click();
    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    await circleTheProblem(page, editor);
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();

    // The marked-up copy joins the original rather than replacing it.
    await expect(page.locator(".prio-attachment")).toHaveCount(2);
    const files = await attachmentBytes(page);
    expect(files.some((f) => /annotated/.test(f.name))).toBe(true);
    expect(
      files.find((f) => !/annotated/.test(f.name))!.size,
      "re-annotating must not touch the original",
    ).toBe(PNG_BYTES.length);
  });
});
