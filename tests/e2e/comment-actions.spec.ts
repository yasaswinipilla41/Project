import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/** An issue that already has a comment, so the menu has something to act on. */
async function anIssueWithAComment() {
  const comment = await prisma.comment.findFirstOrThrow({
    where: { parentId: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true, issue: { select: { key: true } } },
  });
  return comment;
}

test("Reply, Like and Add reaction are in the menu, not standing under the comment", async ({
  page,
}) => {
  const comment = await anIssueWithAComment();
  await page.goto(`/issues/${comment.issue.key.toLowerCase()}`);

  const card = page.locator(`#comment-${comment.id}`);
  await expect(card).toBeVisible();

  // No standalone Reply / Like / Add reaction buttons under the comment.
  await expect(
    card.locator(".prio-comment__action", { hasText: /^Reply$/ }),
  ).toHaveCount(0);
  await expect(
    card.locator(".prio-comment__action", { hasText: /Add reaction/ }),
  ).toHaveCount(0);

  // They are in the menu, and the menu opens for this reader.
  await /* This comment's own ⋯, not its replies'. Replies are nested inside the
     same <li> and each carry a menu, so the first in DOM order is the
     parent's. */
  card.locator(".prio-comment__menu").first().click();
  const menu = page.getByRole("menu", { name: "Comment actions" });
  const items = (await menu.getByRole("menuitem").allInnerTexts()).map((t) =>
    t.replace(/\s+/g, " ").trim(),
  );
  const shown = JSON.stringify(items);
  expect(items.some((i) => /Reply/.test(i)), `Reply in ${shown}`).toBe(true);
  expect(items.some((i) => /Like/.test(i)), `Like in ${shown}`).toBe(true);
  expect(
    items.some((i) => /Add reaction/i.test(i)),
    `Add reaction in ${shown}`,
  ).toBe(true);
});

test("Reply quotes the comment it answers, and the quote can be dismissed", async ({
  page,
}) => {
  const comment = await anIssueWithAComment();
  await page.goto(`/issues/${comment.issue.key.toLowerCase()}`);

  const card = page.locator(`#comment-${comment.id}`);
  await /* This comment's own ⋯, not its replies'. Replies are nested inside the
     same <li> and each carry a menu, so the first in DOM order is the
     parent's. */
  card.locator(".prio-comment__menu").first().click();
  await page.getByRole("menuitem", { name: "Reply" }).click();

  const quote = card.locator(".prio-comment__quote").first();
  await expect(quote).toBeVisible();
  await expect(quote.locator(".prio-comment__replyto")).toContainText(
    /Replying to/i,
  );

  // The quote carries the comment's own words, compactly.
  const quoted = (
    await quote.locator(".prio-comment__quote-body").innerText()
  ).trim();
  expect(quoted.length).toBeGreaterThan(0);
  expect(quoted.length).toBeLessThanOrEqual(200);

  // Two lines at most, and inside the composer rather than past it.
  const quoteBox = (await quote.boundingBox())!;
  const cardBox = (await card.locator(".prio-comment__card").boundingBox())!;
  expect(quoteBox.height).toBeLessThan(90);
  expect(quoteBox.x + quoteBox.width).toBeLessThanOrEqual(
    cardBox.x + cardBox.width + 1,
  );

  // And it can be removed before submitting.
  await quote.locator(".prio-comment__quote-remove").click();
  await expect(card.locator(".prio-comment__quote")).toHaveCount(0);
});

test("a reply posted from the quote is attached to that comment", async ({
  page,
}) => {
  const comment = await anIssueWithAComment();
  const body = `parent check ${Math.random().toString(36).slice(2, 8)}`;

  await page.goto(`/issues/${comment.issue.key.toLowerCase()}`);
  const card = page.locator(`#comment-${comment.id}`);
  await /* This comment's own ⋯, not its replies'. Replies are nested inside the
     same <li> and each carry a menu, so the first in DOM order is the
     parent's. */
  card.locator(".prio-comment__menu").first().click();
  await page.getByRole("menuitem", { name: "Reply" }).click();

  /* The composer is a contentEditable MarkdownEditor, not a textarea. */
  const editor = card.locator(".prio-comment__reply [contenteditable]").first();
  await editor.click();
  await editor.fill(body);
  await card
    .locator(".prio-comment__reply")
    .getByRole("button", { name: "Save" })
    .click();

  await expect
    .poll(async () => {
      const saved = await prisma.comment.findFirst({
        where: { body: { contains: body } },
        select: { parentId: true },
      });
      return saved?.parentId ?? null;
    }, { timeout: 15_000 })
    .toBe(comment.id);

  // Left as it was found.
  await prisma.comment.deleteMany({ where: { body: { contains: body } } });
});
