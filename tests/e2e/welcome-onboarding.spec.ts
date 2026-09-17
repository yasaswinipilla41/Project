import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Onboarding, end to end, including the message that actually left the server.
 *
 * The integration suite covers the rules; this covers the path a person walks:
 * an administrator fills in the real dialog, the running application sends a
 * real message to the real Mailpit beside it, and the account that arrives is
 * stopped at a password screen until it chooses its own.
 *
 * Mailpit is read over its own HTTP API rather than by opening its interface —
 * what is being verified is that a message arrived and what it said, not how
 * Mailpit renders it.
 */

const MAILPIT = "http://localhost:8025";

/** Accounts made here, removed afterwards. */
const created: string[] = [];

function stamp(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/** The most recent message Mailpit holds for an address, with its body. */
async function messageFor(
  page: Page,
  address: string,
): Promise<{ subject: string; text: string } | null> {
  const list = await page.request.get(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=5`,
  );
  if (!list.ok()) return null;

  const found = (await list.json()) as { messages?: { ID: string }[] };
  const id = found.messages?.[0]?.ID;
  if (!id) return null;

  const detail = await page.request.get(`${MAILPIT}/api/v1/message/${id}`);
  if (!detail.ok()) return null;

  const body = (await detail.json()) as { Subject?: string; Text?: string };
  return { subject: body.Subject ?? "", text: body.Text ?? "" };
}

test.describe("Admin creates an account", () => {
  test.use({ storageState: ADMIN_STATE });

  test.afterAll(async () => {
    if (created.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: created } } });
    }
  });

  test("emails the person their own credentials, and Mailpit receives it", async ({
    page,
  }) => {
    const email = `onboarded.${stamp()}@symbiosystech.com`;
    const temporary = `Temp@${stamp()}`;
    created.push(email);

    await page.goto("/admin");
    await page.getByRole("button", { name: "New user" }).click();

    const dialog = page.getByRole("dialog", { name: "Create user account" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/full name/i).fill("Onboarded Person");
    await dialog.getByLabel(/work email/i).fill(email);
    await dialog.getByLabel(/initial password/i).fill(temporary);

    await dialog.getByRole("button", { name: /create/i }).click();
    await expect(dialog).toBeHidden();

    // The account is real.
    await expect
      .poll(async () => prisma.user.count({ where: { email } }))
      .toBe(1);

    /*
     * And the message really left the application. Polled because sending
     * happens while the request finishes — this is the one assertion that
     * proves the whole path rather than the code around it.
     */
    await expect
      .poll(async () => (await messageFor(page, email))?.subject ?? "", {
        timeout: 15_000,
      })
      .toMatch(/welcome to prio/i);

    const message = await messageFor(page, email);
    expect(message).not.toBeNull();
    expect(message!.text).toContain(email);
    expect(message!.text).toContain(temporary);
    expect(message!.text).toMatch(/new password the first time/i);
  });

  test("stops that account at a password screen until it chooses its own", async ({
    browser,
  }) => {
    const email = `firstlogin.${stamp()}@symbiosystech.com`;
    const temporary = `Temp@${stamp()}`;
    const chosen = `Chosen@${stamp()}`;
    created.push(email);

    /* Made through the dialog, so the flag is set by the same path a person
       would use rather than written directly. */
    const admin = await browser.newContext({ storageState: ADMIN_STATE });
    const adminPage = await admin.newPage();
    await adminPage.goto("/admin");
    await adminPage.getByRole("button", { name: "New user" }).click();
    const dialog = adminPage.getByRole("dialog", { name: "Create user account" });
    await dialog.getByLabel(/full name/i).fill("First Login Person");
    await dialog.getByLabel(/work email/i).fill(email);
    await dialog.getByLabel(/initial password/i).fill(temporary);
    await dialog.getByRole("button", { name: /create/i }).click();
    await expect(dialog).toBeHidden();
    await admin.close();

    /*
     * Signed in as nobody, said explicitly.
     *
     * This describe runs with the administrator's stored session, and a context
     * made without overriding it inherits that — so `/sign-in` sees somebody
     * already signed in, redirects to the dashboard, and the wait for an email
     * field that will never render is what burns the timeout. The new account
     * has to arrive as a stranger, which is what `storageState: undefined`
     * says.
     */
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    try {
      await page.goto("/sign-in");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(temporary);
      await page.getByRole("button", { name: /sign in to prio/i }).click();

      // The temporary password works, and gets them exactly this far.
      await expect(page).toHaveURL(/\/change-password/);
      await expect(
        page.getByRole("heading", { name: "Choose a password" }),
      ).toBeVisible();

      /*
       * And no further. The dashboard is where they were trying to go, and
       * asking for it directly puts them straight back — the gate is in the
       * layout every authenticated page renders inside, so a URL is not a way
       * around it.
       */
      await page.goto("/");
      await expect(page).toHaveURL(/\/change-password/);
      await page.goto("/issues");
      await expect(page).toHaveURL(/\/change-password/);

      // Choosing one lets them in.
      await page.getByLabel(/temporary password/i).fill(temporary);
      await page.getByLabel("New password", { exact: true }).fill(chosen);
      await page.getByLabel(/new password again/i).fill(chosen);
      await page.getByRole("button", { name: /save and continue/i }).click();

      /* Not "a URL containing a slash that is not change-password" — the
         double slash in "http://" satisfies that on every page, including the
         one this is meant to rule out. */
      await expect(page).not.toHaveURL(/change-password/);
      await expect(page.locator(".prio-sidebar")).toBeVisible();

      // And the screen does not come back.
      await page.goto("/");
      await expect(page).not.toHaveURL(/\/change-password/);
    } finally {
      await context.close();
    }
  });
});

test.describe("Everybody who was already here", () => {
  test.use({ storageState: ADMIN_STATE });

  test("signs in with nothing in the way", async ({ page }) => {
    /* The seeded administrator predates all of this and must reach the
       dashboard directly — a migration defaulting the flag the other way would
       have stopped the whole organisation at a password screen. */
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/change-password/);
    await expect(page.locator(".prio-sidebar")).toBeVisible();
  });
});
