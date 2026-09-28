import { expect, test } from "@playwright/test";

/**
 * The change-password dialog states the rules while you type, and a password
 * that breaks any of them is refused — with the one generic message, on the
 * New Password field, and not confused with a wrong current password.
 *
 * Nothing here saves a password: every attempt is a refused one, so the seeded
 * account is exactly as it was found.
 */

const RULES = [
  "At least 8 characters",
  "At least 1 uppercase letter",
  "At least 1 lowercase letter",
  "At least 1 number",
  "At least 1 special character",
];

async function openDialog(page: import("@playwright/test").Page) {
  await page.goto("/profile");
  await page.getByRole("button", { name: "Change password" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Change password", () => {
  test("lists what a new password must contain, and ticks each as it is met", async ({ page }) => {
    const dialog = await openDialog(page);

    await expect(dialog.getByText("Password must contain:")).toBeVisible();
    for (const rule of RULES) {
      await expect(dialog.getByText(rule)).toBeVisible();
    }

    const met = dialog.locator(".prio-pwreq__item[data-met]");
    await expect(met).toHaveCount(0);

    const field = dialog.getByLabel("New password", { exact: true });
    await field.fill("abcdefgh");
    await expect(met).toHaveCount(2); // length + lowercase
    await field.fill("Abcdefg1");
    await expect(met).toHaveCount(4); // everything but a special character
    await field.fill("Abcdef1!");
    await expect(met).toHaveCount(5);
  });

  test("refuses a password that breaks a rule, with the generic message on New Password", async ({ page }) => {
    const dialog = await openDialog(page);

    await dialog.getByLabel("Current password").fill("Prio@12345");
    await dialog.getByLabel("New password", { exact: true }).fill("alllowercase1");
    await dialog.getByLabel("Confirm new password").fill("alllowercase1");
    await dialog.getByRole("button", { name: "Change password" }).last().click();

    const error = dialog.locator("#password-new ~ .prio-error");
    await expect(error).toHaveText("Incorrect password");
    // It is the new-password rule that failed, not the current password.
    await expect(dialog.locator("#password-current ~ .prio-error")).toHaveCount(0);
    // The dialog stays open: nothing was saved.
    await expect(dialog).toBeVisible();
  });
});
