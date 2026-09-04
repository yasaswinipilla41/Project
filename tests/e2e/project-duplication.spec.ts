import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Duplicating a project, driven through the interface.
 *
 * The database-level guarantees are pinned in `tests/project-duplication.test.ts`.
 * What this file adds is the half that only the real application can answer:
 * that the copy *opens*, that its issues, threads and files are actually on the
 * page, and — the point of the whole feature — that working in the copy the way
 * anybody would work in a project leaves the original exactly where it was.
 *
 * Every edit below is made by clicking Prio's own controls, not by writing
 * rows, because "a copied issue behaves like any other issue" is a claim about
 * the interface.
 */

const stamp = () => Math.random().toString(36).slice(2, 7).toUpperCase();

interface Source {
  projectId: string;
  key: string;
  name: string;
  parentKey: string;
  childKey: string;
  parentId: string;
}

/**
 * A representative project, seeded directly.
 *
 * Building it through the interface would spend the run's time re-testing the
 * Create flow, which has its own specs. What matters here is that the project
 * being duplicated has one of everything.
 */
async function seedSource(): Promise<Source> {
  const tag = stamp();
  const key = `DUP${tag}`.slice(0, 10);

  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const member = await prisma.user.findFirstOrThrow({
    where: { role: "MEMBER", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const project = await prisma.project.create({
    data: {
      name: `Dup source ${tag}`,
      key,
      description: "The project under duplication.",
      createdById: admin.id,
      issueSequence: 2,
      members: {
        createMany: { data: [{ userId: admin.id }, { userId: member.id }] },
      },
      labels: {
        createMany: {
          data: [{ name: "Regression sweep", color: "#AA33CC" }],
        },
      },
    },
    select: { id: true, key: true, name: true, labels: { select: { id: true } } },
  });

  const parent = await prisma.issue.create({
    data: {
      projectId: project.id,
      number: 1,
      key: `${project.key}-1`,
      type: "STORY",
      title: "Fix login issue",
      description: "The parent story.",
      status: "IN_PROGRESS",
      priority: "HIGH",
      assigneeId: admin.id,
      reporterId: admin.id,
      labels: { createMany: { data: [{ labelId: project.labels[0]!.id }] } },
    },
    select: { id: true, key: true },
  });

  const child = await prisma.issue.create({
    data: {
      projectId: project.id,
      number: 2,
      key: `${project.key}-2`,
      type: "BUG",
      title: "Child bug",
      status: "TODO",
      priority: "LOW",
      severity: "MAJOR",
      assigneeId: member.id,
      reporterId: admin.id,
      parentId: parent.id,
    },
    select: { id: true, key: true },
  });

  await prisma.issueLink.create({
    data: {
      sourceId: parent.id,
      targetId: child.id,
      type: "RELATES_TO",
      createdById: admin.id,
    },
  });

  const root = await prisma.comment.create({
    data: {
      issueId: parent.id,
      authorId: admin.id,
      body: "Newly created video is not displaying in History.",
      createdAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
  await prisma.comment.create({
    data: {
      issueId: parent.id,
      authorId: member.id,
      body: "yes",
      parentId: root.id,
      createdAt: new Date(Date.now() - 30_000),
    },
  });

  return {
    projectId: project.id,
    key: project.key,
    name: project.name,
    parentKey: parent.key,
    childKey: child.key,
    parentId: parent.id,
  };
}

/** Everything this run created, removed however the run ends. */
const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: created } } });
  }
  /* Belt and braces: a run that fails partway can create a copy before it can
     record one, and every project this spec makes is named distinctively so it
     can be swept without touching anything else. */
  await prisma.project.deleteMany({
    where: {
      OR: [
        { name: { startsWith: "Dup source " } },
        { name: { startsWith: "Renamed copy " } },
      ],
    },
  });
});

/**
 * Duplicates through the board's own "..." menu, with both choices as the
 * dialog offers them, and returns the copy's key from the URL it lands on.
 */
async function duplicateThroughUi(
  page: Page,
  source: Source,
  choices: { links?: boolean; attachments?: boolean } = {},
): Promise<string> {
  await page.goto(`/projects/${source.key.toLowerCase()}/board`);
  await page.getByRole("button", { name: "More board actions" }).click();
  await page.getByRole("menuitem", { name: "Clone project" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const links = dialog.getByRole("checkbox").first();
  const attachments = dialog.getByRole("checkbox").last();

  // Both start ticked: a duplicated project is expected to be a complete one.
  await expect(links).toBeChecked();
  await expect(attachments).toBeChecked();

  if (choices.links === false) await links.uncheck();
  if (choices.attachments === false) await attachments.uncheck();

  await dialog.getByRole("button", { name: "Clone", exact: true }).click();

  /* The clone opens on its *own* board. The source's board matches the same
     shape, and we are standing on it — so the wait has to be for a board that
     is not this one, not merely for a board. */
  const sourceBoard = `/projects/${source.key.toLowerCase()}/board`;
  await page.waitForURL(
    (url) =>
      /^\/projects\/[^/]+\/board$/.test(url.pathname) &&
      url.pathname !== sourceBoard,
    { timeout: 60_000 },
  );

  const copyKey = /\/projects\/([^/]+)\/board$/
    .exec(page.url())![1]!
    .toUpperCase();
  expect(copyKey).not.toBe(source.key);

  const row = await prisma.project.findUniqueOrThrow({
    where: { key: copyKey },
    select: { id: true },
  });
  created.push(row.id);

  return copyKey;
}

/**
 * Renames the open issue through its own inline editor: the pencil beside the
 * title, the field it reveals, and Save.
 */
async function retitle(page: Page, title: string) {
  await page.getByRole("button", { name: "Edit title" }).click();
  const field = page.getByLabel("Issue title");
  await expect(field).toBeVisible();
  await field.fill(title);
  await page.locator(".prio-editable__form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
}

/** Opens an issue by its key and waits for the detail page. */
async function openIssue(page: Page, issueKey: string) {
  await page.goto(`/issues/${issueKey.toLowerCase()}`);
  await expect(page.locator(".prio-issue__title, h1").first()).toBeVisible();
}

test.describe("Duplicating a project through the interface", () => {
  test("the copy opens with its issues, thread and relationships in place", async ({
    page,
  }) => {
    const source = await seedSource();
    created.push(source.projectId);

    const copyKey = await duplicateThroughUi(page, source);

    // The board shows the copied work, under the copy's own keys.
    await expect(page.locator(".prio-board__card")).toHaveCount(2);
    const keys = await page.locator(".prio-board__card .prio-key").allInnerTexts();
    for (const key of keys) {
      expect(key.trim().startsWith(`${copyKey}-`)).toBe(true);
    }
    await expect(
      page.locator(".prio-board__card", { hasText: "Fix login issue" }),
    ).toBeVisible();
    await expect(
      page.locator(".prio-board__card", { hasText: "Child bug" }),
    ).toBeVisible();

    // The copied parent issue: its fields, its label, its thread.
    const copiedParent = await prisma.issue.findFirstOrThrow({
      where: { project: { key: copyKey }, title: "Fix login issue" },
      select: { key: true },
    });
    await openIssue(page, copiedParent.key);

    await expect(page.getByText("Fix login issue").first()).toBeVisible();
    await expect(page.getByText("Regression sweep").first()).toBeVisible();

    // The conversation arrived, and the reply is nested under its parent.
    const root = page
      .locator(".prio-conversation__timeline > .prio-comment")
      .filter({ hasText: "Newly created video" })
      .first();
    await expect(root).toBeVisible();
    await expect(
      root.locator(".prio-comment__replies .prio-comment").filter({ hasText: "yes" }),
    ).toHaveCount(1);

    // The related issue points at the copy's own issue, not the original's.
    const related = page.locator(".prio-issue__section, section", {
      hasText: /related/i,
    });
    if ((await related.count()) > 0) {
      const linked = await related.first().locator(".prio-key").allInnerTexts();
      for (const key of linked) {
        expect(key.trim().startsWith(`${copyKey}-`)).toBe(true);
      }
    }

    // And the child answers the copied parent.
    const copiedChild = await prisma.issue.findFirstOrThrow({
      where: { project: { key: copyKey }, title: "Child bug" },
      select: { parentId: true },
    });
    const copiedParentRow = await prisma.issue.findFirstOrThrow({
      where: { project: { key: copyKey }, title: "Fix login issue" },
      select: { id: true },
    });
    expect(copiedChild.parentId).toBe(copiedParentRow.id);
  });

  test("editing the copied issue leaves the original issue untouched", async ({
    page,
  }) => {
    const source = await seedSource();
    created.push(source.projectId);

    const copyKey = await duplicateThroughUi(page, source, { attachments: false });
    const copied = await prisma.issue.findFirstOrThrow({
      where: { project: { key: copyKey }, title: "Fix login issue" },
      select: { key: true },
    });

    await openIssue(page, copied.key);

    // Retitle it the way anybody would: click the pencil, type, Save.
    await retitle(page, "Fix payment issue");

    // Move it through the status control the issue page actually offers.
    await page.locator(".prio-fieldtrigger").first().click();
    await page
      .getByRole("menu", { name: "Change status" })
      .getByRole("menuitemradio", { name: "Done" })
      .click();

    await expect
      .poll(
        async () =>
          (
            await prisma.issue.findFirstOrThrow({
              where: { key: copied.key },
              select: { status: true },
            })
          ).status,
        { timeout: 20_000 },
      )
      .toBe("DONE");

    // The original, re-read from its own page, is exactly as it was.
    await openIssue(page, source.parentKey);
    await expect(page.getByText("Fix login issue").first()).toBeVisible();
    await expect(page.getByText("Fix payment issue")).toHaveCount(0);

    const original = await prisma.issue.findUniqueOrThrow({
      where: { key: source.parentKey },
      select: { title: true, status: true, priority: true },
    });
    expect(original.title).toBe("Fix login issue");
    expect(original.status).toBe("IN_PROGRESS");
    expect(original.priority).toBe("HIGH");
  });

  test("commenting and replying on the copy leaves the original thread alone", async ({
    page,
  }) => {
    const source = await seedSource();
    created.push(source.projectId);

    const copyKey = await duplicateThroughUi(page, source, { attachments: false });
    const copied = await prisma.issue.findFirstOrThrow({
      where: { project: { key: copyKey }, title: "Fix login issue" },
      select: { key: true },
    });

    await openIssue(page, copied.key);

    const note = `only-on-the-copy-${stamp()}`;
    const answer = `answering-the-copy-${stamp()}`;

    // A new top-level comment.
    const composer = page.locator(".prio-conversation__composer .prio-composer");
    await composer.getByRole("textbox").first().click();
    await page.keyboard.type(note);
    await composer.getByRole("button", { name: /^Post|^Comment/ }).first().click();
    await expect(
      page.locator(".prio-comment").filter({ hasText: note }),
    ).toBeVisible({ timeout: 20_000 });

    // A reply to a *copied* comment, which must land inside that thread.
    const root = page
      .locator(".prio-conversation__timeline > .prio-comment")
      .filter({ hasText: "Newly created video" })
      .first();
    await root.getByRole("button", { name: /^Reply$/ }).first().click();
    const replyComposer = root.locator(".prio-composer").last();
    await replyComposer.getByRole("textbox").first().click();
    await page.keyboard.type(answer);
    // The inline reply editor posts with Save, beside Cancel.
    await replyComposer.getByRole("button", { name: /^Save$/ }).click();

    await expect(
      root.locator(".prio-comment__replies .prio-comment").filter({ hasText: answer }),
    ).toHaveCount(1, { timeout: 20_000 });

    // The original issue's thread is the two comments it always had.
    await openIssue(page, source.parentKey);
    await expect(page.getByText(note)).toHaveCount(0);
    await expect(page.getByText(answer)).toHaveCount(0);

    expect(
      await prisma.comment.count({ where: { issueId: source.parentId } }),
    ).toBe(2);
  });

  test("renaming the copied project leaves the original project alone", async ({
    page,
  }) => {
    const source = await seedSource();
    created.push(source.projectId);

    const copyKey = await duplicateThroughUi(page, source, { attachments: false });
    const renamed = `Renamed copy ${stamp()}`;

    await page.goto(`/projects/${copyKey.toLowerCase()}/board`);
    await page.getByRole("button", { name: "More board actions" }).click();
    await page.getByRole("menuitem", { name: "Rename board" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/name/i).first().fill(renamed);
    await dialog.getByRole("button", { name: /save|rename|update/i }).last().click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    await expect
      .poll(async () =>
        (
          await prisma.project.findUniqueOrThrow({
            where: { key: copyKey },
            select: { name: true },
          })
        ).name,
      )
      .toBe(renamed);

    // The original project still carries its own name, on its own page.
    await page.goto(`/projects/${source.key.toLowerCase()}`);
    await expect(page.getByText(source.name).first()).toBeVisible();

    const original = await prisma.project.findUniqueOrThrow({
      where: { id: source.projectId },
      select: { name: true },
    });
    expect(original.name).toBe(source.name);
  });

  test("attachments follow the choice, and open on the copy", async ({ page }) => {
    const source = await seedSource();
    created.push(source.projectId);

    // A real upload on the original issue, through the real endpoint.
    await openIssue(page, source.parentKey);
    const filename = `evidence-${stamp()}.txt`;
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles({
        name: filename,
        mimeType: "text/plain",
        buffer: Buffer.from("original bytes"),
      });
    await expect(
      page.locator(".prio-attachment").filter({ hasText: filename }),
    ).toBeVisible({ timeout: 30_000 });

    // Copy attachments OFF: the copy has none.
    const withoutFiles = await duplicateThroughUi(page, source, {
      attachments: false,
    });
    expect(
      await prisma.attachment.count({
        where: { issue: { project: { key: withoutFiles } } },
      }),
    ).toBe(0);

    // Copy attachments ON: the copy has its own.
    const withFiles = await duplicateThroughUi(page, source);
    const copied = await prisma.issue.findFirstOrThrow({
      where: { project: { key: withFiles }, title: "Fix login issue" },
      select: { key: true, id: true },
    });

    await openIssue(page, copied.key);
    const card = page.locator(".prio-attachment").filter({ hasText: filename });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // It downloads: the copy's own row, serving the copy's own bytes.
    const copiedRow = await prisma.attachment.findFirstOrThrow({
      where: { issueId: copied.id },
      select: { id: true, storageKey: true },
    });
    const originalRow = await prisma.attachment.findFirstOrThrow({
      where: { issue: { key: source.parentKey } },
      select: { id: true, storageKey: true },
    });
    expect(copiedRow.id).not.toBe(originalRow.id);
    expect(copiedRow.storageKey).not.toBe(originalRow.storageKey);

    const response = await page.request.get(`/api/attachments/${copiedRow.id}`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("original bytes");

    // Deleting the copy's file leaves the original's readable.
    await card.getByRole("button", { name: `Remove ${filename}` }).click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });

    const stillThere = await page.request.get(
      `/api/attachments/${originalRow.id}`,
    );
    expect(stillThere.status()).toBe(200);
    expect(await stillThere.text()).toBe("original bytes");

    // And a new upload onto the copied issue behaves normally.
    const added = `added-${stamp()}.txt`;
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles({
        name: added,
        mimeType: "text/plain",
        buffer: Buffer.from("added on the copy"),
      });
    await expect(
      page.locator(".prio-attachment").filter({ hasText: added }),
    ).toBeVisible({ timeout: 30_000 });

    // The original issue still has exactly its one file.
    expect(
      await prisma.attachment.count({ where: { issue: { key: source.parentKey } } }),
    ).toBe(1);
  });

  test("a second copy is independent of the first and of the original", async ({
    page,
  }) => {
    const source = await seedSource();
    created.push(source.projectId);

    const a = await duplicateThroughUi(page, source, { attachments: false });
    const b = await duplicateThroughUi(page, source, { attachments: false });
    expect(a).not.toBe(b);

    const copyA = await prisma.issue.findFirstOrThrow({
      where: { project: { key: a }, title: "Fix login issue" },
      select: { key: true },
    });

    await openIssue(page, copyA.key);
    await retitle(page, "Only in copy A");

    // Copy B's board still shows the title it was cloned with.
    await page.goto(`/projects/${b.toLowerCase()}/board`);
    await expect(
      page.locator(".prio-board__card", { hasText: "Fix login issue" }),
    ).toBeVisible();
    await expect(
      page.locator(".prio-board__card", { hasText: "Only in copy A" }),
    ).toHaveCount(0);

    // So does the original's.
    await page.goto(`/projects/${source.key.toLowerCase()}/board`);
    await expect(
      page.locator(".prio-board__card", { hasText: "Fix login issue" }),
    ).toBeVisible();
    await expect(
      page.locator(".prio-board__card", { hasText: "Only in copy A" }),
    ).toHaveCount(0);
  });
});
