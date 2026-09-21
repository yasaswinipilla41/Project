import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE, setViewport } from "./support";

/**
 * The edges of the sprint surfaces: the two routes that share
 * `SprintDetailsView`, and the two timeline placements that only happen at
 * the ends of the window.
 *
 * These are the cases the ordinary fixtures cannot reach. A seeded sprint
 * sits comfortably inside its timeline, so the branch that puts a date *on*
 * a bar never runs against it; and `/sprints/[id]` is reached from the
 * Projects directory rather than from a project, so nothing that walks a
 * project's own tabs ever opens it.
 *
 * Each fixture is built to force one of those, and the assertions are about
 * what is rendered rather than about which branch was taken — a rewrite that
 * keeps the behaviour keeps these passing.
 */

test.use({ storageState: ADMIN_STATE });

const KEY = `EDGE${Date.now().toString(36).slice(-4)}`.toUpperCase().slice(0, 12);

let projectId = "";
/** Begins on the first day of the timeline's window: no room on its left. */
let firstSprintId = "";

function at(offsetDays: number, hour = 12) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, 0, 0, 0);
  return date;
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const project = await prisma.project.create({
    data: {
      key: KEY,
      name: `Timeline edge fixture ${KEY}`,
      createdById: admin.id,
      issueSequence: 1,
      members: { create: [{ userId: admin.id }] },
    },
    select: { id: true },
  });
  projectId = project.id;

  /*
   * The window the timeline draws is every date it holds, padded out to whole
   * months. To put a sprint hard against an edge of it, the sprint has to
   * *be* that edge — so the first starts on the 1st of a month with nothing
   * earlier, and the last ends on the final day of a month with nothing
   * later.
   */
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 12);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);

  const first = await prisma.sprint.create({
    data: {
      projectId: project.id,
      createdById: admin.id,
      name: `${KEY} opens the window`,
      status: "ACTIVE",
      startDate: monthStart,
      endDate: new Date(monthStart.getTime() + 6 * 86_400_000),
    },
    select: { id: true },
  });
  firstSprintId = first.id;

  /* Its id is never needed — this sprint exists to be the far edge of the
     window, which is what forces the end-edge placement on the timeline. */
  await prisma.sprint.create({
    data: {
      projectId: project.id,
      createdById: admin.id,
      name: `${KEY} closes the window`,
      status: "PLANNED",
      startDate: new Date(monthEnd.getTime() - 6 * 86_400_000),
      endDate: monthEnd,
    },
  });

  /* Dated inside the window, so the timeline draws issue rows as well and
     this fixture exercises the ordinary page rather than a special case. */
  await prisma.issue.create({
    data: {
      projectId: project.id,
      sprintId: first.id,
      key: `${KEY}-1`,
      number: 1,
      title: "Work inside the first sprint",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      dueDate: at(2),
    },
  });
});

test.afterAll(async () => {
  if (projectId) {
    await prisma.issue.deleteMany({ where: { projectId } });
    await prisma.sprint.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
  }
});

test.describe("a sprint date with no room beside its bar", () => {
  test("moves onto the bar, stays readable, and keeps both ends dated", async ({
    page,
  }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/timeline`);

    const dates = page.locator(".prio-timeline__sprintdate");
    await expect(dates).toHaveCount(4);

    /*
     * The branch under test actually ran.
     *
     * Asserted through the attribute the implementation sets rather than by
     * reading the CSS: what matters is that a date with nowhere to go on the
     * track took the other placement, and the attribute is how the two are
     * told apart at any width.
     */
    const inside = page.locator(".prio-timeline__sprintdate[data-inside]");
    await expect(inside).not.toHaveCount(0);

    /* Both edges reach it: the first sprint's start has no track to its left,
       and the last sprint's end has none to its right. */
    await expect(
      page.locator('.prio-timeline__sprintdate[data-edge="start"][data-inside]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.prio-timeline__sprintdate[data-edge="end"][data-inside]'),
    ).toHaveCount(1);

    /*
     * Readable where it landed. A date pushed onto the bar sits over a filled
     * shape, so it carries a background of its own — without it the muted
     * text would be on the accent fill and effectively gone.
     */
    const chip = inside.first();
    await expect(chip).toBeVisible();
    const painted = await chip.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        text: el.textContent?.trim() ?? "",
        width: el.getBoundingClientRect().width,
      };
    });
    expect(painted.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(painted.text).toMatch(/^\d{2} \w{3} \d{4}$/);
    expect(painted.width).toBeGreaterThan(0);

    /* And it stays on the track rather than escaping into the name column
       beside it, which is what pushed it inside in the first place. */
    const track = page.locator(".prio-timeline__track").nth(1);
    const trackBox = (await track.boundingBox())!;
    const chipBox = (await chip.boundingBox())!;
    expect(chipBox.x).toBeGreaterThanOrEqual(trackBox.x - 1);
  });

  test("still dates the bars that do have room, outside them", async ({
    page,
  }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/timeline`);

    /* The other two — the first sprint's end and the last sprint's start —
       are mid-window and keep the ordinary placement. */
    const outside = page.locator(
      ".prio-timeline__sprintdate:not([data-inside])",
    );
    await expect(outside).toHaveCount(2);
    for (const text of await outside.allInnerTexts()) {
      expect(text.trim()).toMatch(/^\d{2} \w{3} \d{4}$/);
    }
  });
});

test.describe("a timeline whose only scheduled thing is a sprint", () => {
  test("draws the sprint bars and says why there are no issue rows", async ({
    page,
  }) => {
    /* Take the due date away: the project still has sprints, which are
       scheduled by their own dates and owe nothing to issue due dates. */
    await prisma.issue.updateMany({ where: { projectId }, data: { dueDate: null } });

    try {
      await page.goto(`/projects/${KEY.toLowerCase()}/timeline`);

      /* The page used to stand down entirely here, taking the sprint bars
         with it and telling a team running a sprint that nothing was
         scheduled. */
      await expect(page.getByText("Nothing is scheduled yet")).toHaveCount(0);
      await expect(page.locator(".prio-timeline__bar--sprint")).toHaveCount(2);
      await expect(page.locator(".prio-timeline__sprintdate")).toHaveCount(4);

      /* And the missing rows are explained where they would have been. */
      const note = page.locator(".prio-timeline__empty");
      await expect(note).toBeVisible();
      await expect(note).toContainText("No work item has a due date yet");
      await expect(note.getByRole("link", { name: "Open the list" })).toBeVisible();
    } finally {
      await prisma.issue.updateMany({
        where: { projectId },
        data: { dueDate: at(2) },
      });
    }
  });

  test("still stands down when there is nothing at all", async ({ page }) => {
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    const barren = await prisma.project.create({
      data: {
        key: `${KEY}B`.slice(0, 12),
        name: `Barren ${KEY}`,
        createdById: admin.id,
        members: { create: [{ userId: admin.id }] },
      },
      select: { id: true, key: true },
    });

    try {
      await page.goto(`/projects/${barren.key.toLowerCase()}/timeline`);
      /* No sprints and no dated work is genuinely nothing to draw, and the
         empty state is still the right answer. */
      await expect(page.getByText("Nothing is scheduled yet")).toBeVisible();
      await expect(page.locator(".prio-timeline__bar--sprint")).toHaveCount(0);
    } finally {
      await prisma.project.deleteMany({ where: { id: barren.id } });
    }
  });
});

/** Everything a sprint's details page has to show, wherever it is reached. */
async function assertSprintDetails(page: Page, name: string) {
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(page.locator(".prio-sprint__range")).toBeVisible();
  await expect(page.getByText("Start Date:")).toBeVisible();
  await expect(page.locator(".prio-sprint__total")).toBeVisible();
  await expect(page.getByText("Issues by status")).toBeVisible();
  await expect(page.locator(".prio-isochart__col").first()).toBeVisible();
}

test.describe("the sprint details page, from either route", () => {
  test("renders the same details under /sprints/[id] as under a project", async ({
    page,
  }) => {
    const name = `${KEY} opens the window`;

    /* The project's own route, which the rest of the suite already walks. */
    await page.goto(`/projects/${KEY.toLowerCase()}/sprints/${firstSprintId}`);
    await assertSprintDetails(page, name);
    const fromProject = await page.locator(".prio-sprint__total").innerText();

    /*
     * And the global one, reached from the Projects directory rather than
     * from inside a project. It shares `SprintDetailsView`, so what is being
     * checked is that the route resolves, authorises and hands the component
     * the same sprint — not that the component works twice.
     */
    await page.goto(`/sprints/${firstSprintId}`);
    await assertSprintDetails(page, name);
    expect(await page.locator(".prio-sprint__total").innerText()).toBe(fromProject);

    /* It carries its own way back, and names the project it belongs to. */
    await expect(
      page.getByText(`Timeline edge fixture ${KEY}`).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to sprints/ })).toBeVisible();

    expect(await page.title()).toContain("Sprint");
  });

  test("refuses a sprint id that does not exist", async ({ page }) => {
    const response = await page.goto(`/sprints/not-a-real-sprint-id`);
    /* Prio's dynamic pages answer 200 with the not-found UI — see AGENTS.md
       on Next 16 — so the body is what says it, not the status. */
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator(".prio-sprint__total")).toHaveCount(0);
  });
});

test.describe("sprint details at every width, in both themes", () => {
  for (const width of [1440, 1024, 834, 390] as const) {
    test(`fits ${width}px without pushing the page sideways`, async ({ page }) => {
      for (const path of [
        `/projects/${KEY.toLowerCase()}/sprints/${firstSprintId}`,
        `/sprints/${firstSprintId}`,
      ]) {
        await page.goto(path);
        /* Sized after the page is on screen: the helper waits for the shell
           to settle, which needs a shell to wait for. */
        await setViewport(page, width, 900);
        await expect(page.locator(".prio-sprint__total")).toBeVisible();

        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(1);
      }
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`is readable in the ${theme} theme`, async ({ page }) => {
      /* The theme is a stored choice, not a media query — `prefers-color-scheme`
         is deliberately ignored, so emulating it would prove nothing. */
      await page.addInitScript((value) => {
        try {
          localStorage.setItem("prio-theme", value);
        } catch {
          /* A browser refusing storage falls back to light, which is fine. */
        }
      }, theme);

      /* The sprint that holds work: a sprint with none draws the chart's
         empty state instead of its columns, and the chart labels are one of
         the things being read here. */
      await page.goto(`/projects/${KEY.toLowerCase()}/sprints/${firstSprintId}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".prio-sprint__total")).toBeVisible();

      /*
       * Contrast, rather than "it has a colour". A token that resolves to the
       * wrong side of the palette still produces a colour; what it does not
       * produce is text somebody can read against what is behind it.
       */
      const readable = await page.evaluate(() => {
        const luminance = (colour: string) => {
          const [r, g, b] = (colour.match(/\d+/g) ?? ["0", "0", "0"])
            .slice(0, 3)
            .map(Number)
            .map((channel) => {
              const unit = channel / 255;
              return unit <= 0.03928
                ? unit / 12.92
                : ((unit + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };

        const measure = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          let node: Element | null = element.parentElement;
          let background = "rgba(0, 0, 0, 0)";
          while (node && background === "rgba(0, 0, 0, 0)") {
            background = getComputedStyle(node).backgroundColor;
            node = node.parentElement;
          }
          const [hi, lo] = [
            luminance(getComputedStyle(element).color),
            luminance(background),
          ].sort((a, b) => b - a);
          return (hi! + 0.05) / (lo! + 0.05);
        };

        return {
          total: measure(".prio-sprint__total"),
          heading: measure(".prio-sprint__name"),
          chart: measure(".prio-isochart__label"),
        };
      });

      /* WCAG AA for ordinary text. */
      expect(readable.total, "Total Issues").toBeGreaterThan(4.5);
      expect(readable.heading, "sprint name").toBeGreaterThan(4.5);
      expect(readable.chart, "chart labels").toBeGreaterThan(3);
    });
  }
});
