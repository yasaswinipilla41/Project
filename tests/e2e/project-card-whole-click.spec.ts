import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * The whole project card opens the project, on All Projects.
 *
 * The card only ever opened from the project's name, which is a small target on
 * a large tile that already looks and hovers like one thing. Every other part of
 * it — the key, the description, the figures, the avatars, the padding — did
 * nothing at all.
 *
 * It is still one real anchor: the name's own link, stretched over the card with
 * a transparent overlay. That is what this file is really asserting — the parts
 * a CSS change can silently get wrong. That every region of the card navigates,
 * that there is exactly one tab stop and Enter follows it, that the card is not
 * a `div` pretending to be a link, and that a control placed on the card would
 * still get its own click rather than opening the project underneath it.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.projectMember.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/** A project with a description, members and issues, so the card is full. */
async function seedProject() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const stamp = Date.now().toString(36).toUpperCase();
  const project = await prisma.project.create({
    data: {
      key: `PCC${stamp}`.slice(0, 10),
      name: `Whole-card project ${stamp}`,
      description:
        "A fixture with a description long enough to occupy the middle of its card.",
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true, name: true },
  });
  createdProjects.push(project.id);

  await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Something to count",
      type: "TASK",
      status: "BACKLOG",
      reporterId: admin.id,
    },
  });

  return project;
}

function cardFor(page: Page, name: string) {
  return page.locator(".prio-projectcard").filter({ hasText: name });
}

/**
 * Clicks the middle of an element by pointer coordinates rather than by
 * element.
 *
 * `locator.click()` refuses when something else would receive the click, which
 * is precisely what a stretched link does on purpose — the overlay is the link,
 * and every press on the card is meant to reach it. Pressing the point is what
 * a reader actually does, and it is the only way to assert that pressing the
 * description or the avatars opens the project.
 */
async function clickPoint(page: Page, target: Locator): Promise<void> {
  /* Scrolled into view first: these are viewport coordinates, and this page
     lists every project the reader can see — the fixture's card is often below
     the fold, where a measured point would be off screen and the press would
     land on whatever happens to be at those coordinates instead. */
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * What the browser says is on top at the middle of an element.
 *
 * The question a stretched link has to be asked: not "does this element exist"
 * but "what would a press here actually hit". `elementFromPoint` answers for a
 * pseudo-element with the element it belongs to, so a press landing on the
 * overlay reports the project's own anchor.
 */
async function topmostAt(page: Page, target: Locator): Promise<string> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return "";
  return page.evaluate(
    ([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      if (!node) return "";
      return [
        node.tagName.toLowerCase(),
        ...node.classList,
        ...Object.values((node as HTMLElement).dataset ?? {}).filter(
          (value): value is string => typeof value === "string",
        ),
      ].join(" ");
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );
}

test.describe("An All Projects card", () => {
  /*
   * Each region of the card, named by what somebody would actually press. The
   * key, the description, the figures and the avatars are all content that did
   * nothing before; the padding is the part of a card that most obviously looks
   * like it should work and never did.
   */
  const regions = [
    { label: "the project key", selector: ".prio-key" },
    { label: "the description", selector: ".prio-projectcard__description" },
    { label: "the figures", selector: ".prio-projectcard__stats" },
    { label: "the progress bar", selector: ".prio-projectcard__progress" },
    { label: "the member avatars", selector: ".prio-projectcard__members" },
  ] as const;

  for (const region of regions) {
    test(`opens the project from ${region.label}`, async ({ page }) => {
      const project = await seedProject();
      await page.goto("/projects");

      const card = cardFor(page, project.name);
      await expect(card).toBeVisible();

      /* The overlay is what receives this press — and it belongs to the
         project's own link, so what is on top here is that anchor. */
      expect(await topmostAt(page, card.locator(region.selector))).toContain(
        "prio-projectcard__link",
      );
      await clickPoint(page, card.locator(region.selector));

      await expect(page).toHaveURL(
        new RegExp(`/projects/${project.key.toLowerCase()}/welcome$`),
      );
    });
  }

  test("opens the project from the card's own padding", async ({ page }) => {
    const project = await seedProject();
    await page.goto("/projects");

    const card = cardFor(page, project.name);
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    /* Four pixels in from the bottom-left corner: inside the card, inside its
       padding, and outside every piece of content on it. */
    await page.mouse.click(box.x + 4, box.y + box.height - 4);

    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}/welcome$`),
    );
  });

  test("still opens from the project name, exactly as it always did", async ({
    page,
  }) => {
    const project = await seedProject();
    await page.goto("/projects");

    await cardFor(page, project.name)
      .getByRole("link", { name: project.name })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}/welcome$`),
    );
  });

  test("is one anchor with one tab stop, and Enter follows it", async ({
    page,
  }) => {
    const project = await seedProject();
    await page.goto("/projects");

    const card = cardFor(page, project.name);

    /*
     * One link, not a link inside a clickable div and not two overlapping
     * targets. A card that navigated from a `role="link"` wrapper would put the
     * name's own anchor inside an interactive element, which is invalid and
     * reads twice to a screen reader.
     */
    await expect(card.getByRole("link")).toHaveCount(1);
    await expect(card.locator('[role="link"]')).toHaveCount(0);
    await expect(card.locator("[tabindex]")).toHaveCount(0);

    const link = card.getByRole("link", { name: project.name });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}/welcome$`),
    );
  });

  test("keeps any control on the card above the overlay, so it gets its own click", async ({
    page,
  }) => {
    /*
     * There is no menu or action button on a project card today. The rule that
     * keeps one working is a stylesheet rule over the card rather than a class
     * each control has to remember, so it is asserted directly: a button
     * injected into the card must sit above the stretched link and receive the
     * click itself.
     *
     * Testing it this way rather than waiting for a control to be added is the
     * point — the failure it prevents is silent, and by the time somebody adds
     * an Archive button to this card, pressing it navigating away instead is
     * exactly the bug that would ship.
     */
    const project = await seedProject();
    await page.goto("/projects");

    const card = cardFor(page, project.name);
    await card.scrollIntoViewIfNeeded();

    /*
     * Injected and measured in one pass.
     *
     * The browser's own answer to "what would a press here hit", read with
     * `elementFromPoint` rather than by clicking and watching for a side
     * effect — the side effect of getting this wrong is a navigation, which
     * unmounts the very thing being measured. Both points are read in the same
     * evaluation as the injection, so nothing can re-render the card in
     * between and detach the probe.
     */
    const hit = await card.evaluate((node) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Probe";
      button.dataset.probe = "overlay-probe";
      node.querySelector(".prio-projectcard__stats")?.append(button);

      const at = (target: Element | null) => {
        if (!target) return "missing";
        const box = target.getBoundingClientRect();
        const top = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        if (!top) return "nothing";
        return [
          top.tagName.toLowerCase(),
          ...top.classList,
          ...Object.values((top as HTMLElement).dataset ?? {}),
        ].join(" ");
      };

      return {
        onControl: at(button),
        onContent: at(node.querySelector(".prio-projectcard__description")),
      };
    });

    // The control receives its own press…
    expect(hit.onControl).toContain("overlay-probe");
    // …and the card's own content is still the project's link.
    expect(hit.onContent).toContain("prio-projectcard__link");
  });

  test("hovers as one card, and says where it leads", async ({ page }) => {
    const project = await seedProject();
    await page.goto("/projects");

    const card = cardFor(page, project.name);
    /* The affordance the whole surface now has to carry: the link's own title,
       reachable from anywhere on the card because the overlay belongs to it. */
    await expect(card.getByRole("link", { name: project.name })).toHaveAttribute(
      "title",
      `Open ${project.name}`,
    );

    const before = await card
      .locator(".prio-projectcard__name a")
      .evaluate((node) => getComputedStyle(node).color);
    const description = card.locator(".prio-projectcard__description");
    await description.scrollIntoViewIfNeeded();
    const box = await description.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(async () => {
      const after = await card
        .locator(".prio-projectcard__name a")
        .evaluate((node) => getComputedStyle(node).color);
      expect(after).not.toBe(before);
    }).toPass({ timeout: 3_000 });
  });
});
