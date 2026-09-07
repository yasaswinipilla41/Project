import { expect, test, type Page } from "@playwright/test";
import { MEMBER_STATE, setViewport, watchForProblems } from "./support";

/**
 * Comments, mentions and attachments in the browser.
 *
 * The requirement these exist for is that the comment box is *findable*: a
 * person opening an issue should not have to look for it, open a tab, or leave
 * the page. So the tests assert where it is, not merely that it exists.
 */

/** A stamp that makes each run's content identifiable in the database. */
const stamp = () => Math.random().toString(36).slice(2, 8);

async function openIssue(page: Page, key = "eng-1") {
  await page.goto(`/issues/${key}`);
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
}

test.describe("The comment composer", () => {
  test("is visible on the issue page without any navigation", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await openIssue(page);

    // Present, on the page, with no tab to open and no dialog to summon.
    const composer = page.locator(".prio-composer");
    await expect(composer).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Add a comment" }),
    ).toBeVisible();
    await expect(composer.getByRole("textbox", { name: "Write a comment…" })).toBeVisible();

    // …and it sits inside the Activity section, not somewhere else entirely.
    const activityCard = page
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: "Comments" }) });
    await expect(activityCard.locator(".prio-composer")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("posts a comment, which appears in the timeline", async ({ page }) => {
    await openIssue(page);

    const body = `Reproduced on the latest build ${stamp()}`;
    await page.getByRole("textbox", { name: "Write a comment…" }).fill(body);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    // It lands in the conversation, attributed and timestamped.
    const comment = page.locator(".prio-comment").filter({ hasText: body });
    await expect(comment).toBeVisible({ timeout: 15_000 });
    await expect(comment.locator(".prio-comment__author")).not.toBeEmpty();

    /* The composer is emptied and ready for the next one. It is a rich text
       region rather than an input now, so this reads its text, not a value. */
    await expect(
      page.getByRole("textbox", { name: "Write a comment…" }),
    ).toHaveText("");
  });

  test("renders formatting, and renders markup as text", async ({ page }) => {
    await openIssue(page);

    const marker = stamp();
    await page
      .getByRole("textbox", { name: "Write a comment…" })
      .fill(`**bold ${marker}** and <script>alert(1)</script>`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    const comment = page.locator(".prio-comment").filter({ hasText: marker });
    await expect(comment).toBeVisible({ timeout: 15_000 });

    // The formatting was applied. Scoped to the rendered body: the author's
    // name is also a <strong>, and matching that would prove nothing.
    await expect(comment.locator(".prio-rt strong")).toContainText(
      `bold ${marker}`,
    );

    // …and the script tag is text on the page, not an element in the document.
    await expect(comment).toContainText("<script>alert(1)</script>");
    expect(await comment.locator("script").count()).toBe(0);
  });

  test("previews exactly what will be posted", async ({ page }) => {
    await openIssue(page);

    await page.getByRole("textbox", { name: "Write a comment…" }).fill("# Heading\n\n- one");
    await page.getByRole("tab", { name: "Preview" }).click();

    const preview = page.locator(".prio-composer__preview");
    await expect(preview.locator(".prio-rt__h")).toContainText("Heading");
    await expect(preview.locator("li")).toContainText("one");

    await page.getByRole("tab", { name: "Write" }).click();
    /* Back in the editor the same content is shown formatted rather than
       as markers — that is the point of a visual editor — so this asserts
       nothing was lost, not that the syntax is on screen. */
    const back = page.getByRole("textbox", { name: "Write a comment…" });
    await expect(back).toContainText("Heading");
    await expect(back).toContainText("one");
    await expect(back).not.toContainText("#");
  });

  test("formats through the toolbar and posts with Ctrl+Enter", async ({
    page,
  }) => {
    await openIssue(page);

    const marker = stamp();
    const field = page.getByRole("textbox", { name: "Write a comment…" });
    await field.click();
    await field.fill(`keyboard ${marker}`);

    /*
     * Bold applies to the selection now, rather than inserting a `**bold**`
     * sample to type over. The two things worth asserting about a visual
     * editor are that the formatting shows and the syntax does not.
     */
    await field.press("Control+a");
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(field.locator("b, strong")).toHaveCount(1);
    await expect(field).not.toContainText("**");

    await field.press("Control+Enter");

    await expect(
      page.locator(".prio-comment").filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("refuses to post nothing", async ({ page }) => {
    await openIssue(page);

    const post = page.getByRole("button", { name: "Comment", exact: true });
    await expect(post).toBeDisabled();

    await page.getByRole("textbox", { name: "Write a comment…" }).fill("   ");
    await expect(post).toBeDisabled();
  });
});

test.describe("Mentions", () => {
  test("offers people on the project and stores the mention", async ({
    page,
  }) => {
    await openIssue(page);

    const field = page.getByRole("textbox", { name: "Write a comment…" });
    await field.click();
    await field.type("Hello @");

    // The picker appears with real people from this project.
    const picker = page.getByRole("listbox", { name: "People" });
    await expect(picker).toBeVisible();
    const options = picker.getByRole("option");
    expect(await options.count()).toBeGreaterThan(0);

    /* The row renders an avatar (its initials, plus the name again for screen
       readers) before the visible name, so `innerText` carries all three. The
       name is the last line. */
    const chosen = (await options.first().innerText())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) as string;

    // Keyboard: arrow to move, Enter to choose.
    await field.press("ArrowDown");
    await field.press("ArrowUp");
    await field.press("Enter");

    await expect(picker).toBeHidden();
    await expect(field).toContainText(`@${chosen}`);

    const marker = stamp();
    await field.press("End");
    await field.type(`please look ${marker}`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    const comment = page.locator(".prio-comment").filter({ hasText: marker });
    await expect(comment).toBeVisible({ timeout: 15_000 });

    // The mention renders as a resolved person, not as plain text.
    await expect(comment.locator(".prio-rt__mention")).toContainText(chosen);
  });

  test("closes the picker on Escape without choosing anyone", async ({
    page,
  }) => {
    await openIssue(page);

    const field = page.getByRole("textbox", { name: "Write a comment…" });
    await field.click();
    await field.type("ping @");

    await expect(page.getByRole("listbox", { name: "People" })).toBeVisible();
    await field.press("Escape");
    await expect(page.getByRole("listbox", { name: "People" })).toBeHidden();

    await expect(field).toHaveText("ping @");
  });

  test("says so when nobody matches", async ({ page }) => {
    await openIssue(page);

    const field = page.getByRole("textbox", { name: "Write a comment…" });
    await field.click();
    await field.type("hi @Zzzqqq");

    await expect(page.locator(".prio-mentions__empty")).toBeVisible();
  });
});

test.describe("Editing and deleting a comment", () => {
  test("the author can edit their own, and the edit is marked", async ({
    page,
  }) => {
    await openIssue(page);

    const marker = stamp();
    await page.getByRole("textbox", { name: "Write a comment…" }).fill(`before ${marker}`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    const comment = page.locator(".prio-comment").filter({ hasText: marker });
    await expect(comment).toBeVisible({ timeout: 15_000 });

    await comment.getByRole("button", { name: "Comment actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    /* The edit form is the same visual editor, so it is found by role
       rather than by tag. */
    const editor = comment.getByRole("textbox", { name: "Write a comment…" });
    await editor.fill(`after ${marker}`);
    await comment.getByRole("button", { name: "Save changes" }).click();

    const edited = page.locator(".prio-comment").filter({ hasText: `after ${marker}` });
    await expect(edited).toBeVisible({ timeout: 15_000 });
    await expect(edited.locator(".prio-comment__edited")).toBeVisible();
  });

  test("the author can delete their own", async ({ page }) => {
    await openIssue(page);

    const marker = stamp();
    await page.getByRole("textbox", { name: "Write a comment…" }).fill(`temporary ${marker}`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    const comment = page.locator(".prio-comment").filter({ hasText: marker });
    await expect(comment).toBeVisible({ timeout: 15_000 });

    await comment.getByRole("button", { name: "Comment actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    await expect(
      page.locator(".prio-comment").filter({ hasText: marker }),
    ).toHaveCount(0, { timeout: 15_000 });
  });

  test("a member gets no edit control on somebody else's comment", async ({
    browser,
  }) => {
    /* Posted by the administrator, then read as a member. The member may
       delete nothing here and edit nothing here. */
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await openIssue(adminPage);

    const marker = stamp();
    await adminPage
      .getByRole("textbox", { name: "Write a comment…" })
      .fill(`written by the admin ${marker}`);
    await adminPage
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    await expect(
      adminPage.locator(".prio-comment").filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });
    await adminContext.close();

    const memberContext = await browser.newContext({
      storageState: MEMBER_STATE,
    });
    const memberPage = await memberContext.newPage();
    await openIssue(memberPage);

    const comment = memberPage
      .locator(".prio-comment")
      .filter({ hasText: marker });
    await expect(comment).toBeVisible();

    /*
     * The menu itself is theirs now -- Reply, Like and Add reaction live in it
     * and are everyone's, so it opens for any reader. What a member must not
     * be offered on somebody else's comment is Edit or Delete, so that is what
     * is asserted: the contents, not the existence of the control.
     */
    await comment.getByRole("button", { name: "Comment actions" }).click();
    const menu = memberPage.getByRole("menu", { name: "Comment actions" });
    const offered = await menu.getByRole("menuitem").allInnerTexts();
    const labels = offered.map((t) => t.replace(/\s+/g, " ").trim());

    expect(labels.some((l) => /Reply/.test(l))).toBe(true);
    expect(labels.some((l) => /Edit/.test(l))).toBe(false);
    expect(labels.some((l) => /Delete/.test(l))).toBe(false);

    await memberContext.close();
  });
});

test.describe("Attachments and related issues", () => {
  test("shows an attachment panel that accepts files", async ({ page }) => {
    await openIssue(page);

    await expect(
      page.getByRole("heading", { name: "Attachments" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add files" })).toBeVisible();
  });

  test("uploads a real image and previews it", async ({ page }) => {
    await openIssue(page);

    // A genuine 1×1 PNG: the server identifies uploads by their bytes, so a
    // fake buffer with an image name would be refused — correctly.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const name = `probe-${stamp()}.png`;

    await page.locator('input[aria-label="Attach files to this issue"]').setInputFiles({
      name,
      mimeType: "image/png",
      buffer: png,
    });

    const attachment = page
      .locator(".prio-attachment")
      .filter({ hasText: name });
    await expect(attachment).toBeVisible({ timeout: 20_000 });
    await expect(attachment.locator("img")).toBeVisible();

    // Opening it enlarges it in place rather than leaving the page.
    await attachment.locator(".prio-attachment__preview").click();
    await expect(page.locator(".prio-lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".prio-lightbox")).toBeHidden();

    // Clean up after ourselves so the fixture issue does not accumulate files.
    await attachment.locator(".prio-attachment__remove").click();
    await expect(
      page.locator(".prio-attachment").filter({ hasText: name }),
    ).toHaveCount(0, { timeout: 15_000 });
  });

  test("refuses a file whose bytes are not what its name claims", async ({
    page,
  }) => {
    await openIssue(page);

    // "MZ…" — a Windows executable, offered as a PNG.
    const executable = Buffer.from([
      0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);

    await page.locator('input[aria-label="Attach files to this issue"]').setInputFiles({
      name: "totally-a-screenshot.png",
      mimeType: "image/png",
      buffer: executable,
    });

    await expect(page.locator(".prio-composer__error")).toContainText(
      /not supported/i,
      { timeout: 20_000 },
    );
    await expect(
      page.locator(".prio-attachment").filter({ hasText: "totally-a-screenshot" }),
    ).toHaveCount(0);
  });

  test("links an issue and shows the relationship", async ({ page }) => {
    await openIssue(page, "eng-2");

    await expect(
      page.getByRole("heading", { name: "Related issues" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Link issue" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("This issue").selectOption("BLOCKS");
    await dialog.getByLabel("Which issue?").fill("ENG-3");

    // Scoped to the results list: the relationship <select> above it also
    // contains elements with the "option" role, and those are never visible.
    const option = dialog.locator(".prio-linkresults__item").first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    const targetKey = (await option.innerText()).trim().split(/\s+/)[0] ?? "";
    await option.click();

    await dialog.getByRole("button", { name: "Link issue" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const related = page.locator(".prio-related");
    await expect(related).toContainText("blocks");
    await expect(related).toContainText(targetKey);

    // The inverse is written too, so the other issue knows about it.
    await page.goto(`/issues/${targetKey.toLowerCase()}`);
    await expect(page.locator(".prio-related")).toContainText("is blocked by");

    // Undo, so the fixture issues stay as they were.
    await page.locator(".prio-related__remove").first().click();
    await expect(page.locator(".prio-related__item")).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});

test.describe("Presentation", () => {
  test("the composer works at phone width without sideways scrolling", async ({
    page,
  }) => {
    await openIssue(page);
    await setViewport(page, 390, 844);

    await expect(page.locator(".prio-composer")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Write a comment…" })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "horizontal overflow at 390px").toBeLessThanOrEqual(1);
  });

  test("repaints in dark mode", async ({ page }) => {
    await openIssue(page);

    const read = () =>
      page
        .locator(".prio-composer__main")
        .evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    const light = await read();

    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    const dark = await read();

    expect(dark).not.toBe(light);
  });
});


test.describe("Threading", () => {
  /**
   * A reply belongs to the conversation it answers, however it was aimed.
   *
   * Every comment carries a Reply control, replies included, and a thread is
   * drawn one level deep. Answering a reply therefore produces a comment two
   * deep — and grouping those by their immediate parent put them under a card
   * that renders no replies of its own, so they were saved and then shown
   * nowhere: not in the top-level stream, which is parentless comments only,
   * and not under anything. Somebody wrote an answer, it was accepted, and it
   * vanished on the next load.
   *
   * This walks the full path — comment, reply, reply to that reply — and
   * reloads, because the bug only showed after a round trip.
   */
  test("an answer to a reply stays in the conversation", async ({ page }) => {
    const tag = stamp();
    const root = `root-${tag}`;
    const reply = `reply-${tag}`;
    const answer = `answer-${tag}`;

    await openIssue(page, "eng-6");

    // A root comment.
    await page.getByRole("textbox", { name: /Write a comment/i }).first().click();
    await page.keyboard.type(root);
    await page.getByRole("button", { name: /^Comment$/ }).first().click();
    const rootCard = page.locator(".prio-comment").filter({ hasText: root }).first();
    await expect(rootCard).toBeVisible({ timeout: 20000 });

    /* A reply to it. "Reply" is an item in the comment's ⋯ menu now rather than
       a button standing under it; the editor it opens is unchanged, and the
       button that posts it is still "Save", beside Cancel, under the quoted
       comment being answered. */
    await rootCard
      .getByRole("button", { name: "Comment actions" })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Reply" }).click();
    await expect(rootCard.locator(".prio-comment__replyto").first()).toBeVisible();
    const rootComposer = rootCard.locator(".prio-composer").last();
    await rootComposer.getByRole("textbox").first().click();
    await page.keyboard.type(reply);
    await rootComposer.getByRole("button", { name: /^Save$/ }).click();

    const replyCard = page
      .locator(".prio-comment__replies .prio-comment")
      .filter({ hasText: reply })
      .first();
    await expect(replyCard).toBeVisible({ timeout: 20000 });

    // And an answer to that reply — the case that used to disappear.
    await replyCard
      .getByRole("button", { name: "Comment actions" })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Reply" }).click();
    const replyComposer = replyCard.locator(".prio-composer").last();
    await replyComposer.getByRole("textbox").first().click();
    await page.keyboard.type(answer);
    await replyComposer.getByRole("button", { name: /^Save$/ }).click();
    await expect(
      page.locator(".prio-comment").filter({ hasText: answer }).first(),
    ).toBeVisible({ timeout: 20000 });

    /* The card appears as soon as the refreshed tree arrives, which can be a
       moment before the write has settled everywhere it is read from. A person
       does not reload in the same instant they press Reply; reloading here
       without letting it settle tests the race rather than the threading. */
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

    /* All three survive, and both answers sit inside the thread they belong
       to rather than beside it. Asserted through the DOM's own containment:
       the root's replies list is what "in the thread" means here. */
    const rootAfter = page
      .locator(".prio-conversation__timeline > .prio-comment")
      .filter({ hasText: root })
      .first();
    await expect(rootAfter).toBeVisible();

    const thread = rootAfter.locator(".prio-comment__replies .prio-comment");
    await expect(
      thread.filter({ hasText: reply }),
      "the reply belongs to the thread",
    ).toHaveCount(1);
    await expect(
      thread.filter({ hasText: answer }),
      "and so does the answer to it, which used to vanish",
    ).toHaveCount(1);

    // Neither may surface as a conversation of its own.
    const topLevel = page.locator(".prio-conversation__timeline > .prio-comment");
    await expect(topLevel.filter({ hasText: answer })).toHaveCount(1); // only the root, which contains it
    await expect(
      topLevel.filter({ hasText: answer }).filter({ hasText: root }),
      "the only top-level card carrying the answer is the root it belongs to",
    ).toHaveCount(1);
  });
});
