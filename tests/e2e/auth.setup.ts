import { test as setup } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_STATE,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  MEMBER_STATE,
  signIn,
} from "./support";

/**
 * Signs in once per role and stores the session.
 *
 * Every spec reuses these states instead of signing in again, which keeps the
 * suite fast and avoids tripping better-auth's rate limiting on the sign-in
 * endpoint when many tests run back to back.
 */

setup("authenticate as admin", async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.context().storageState({ path: ADMIN_STATE });
});

setup("authenticate as member", async ({ page }) => {
  await signIn(page, MEMBER_EMAIL, MEMBER_PASSWORD);
  await page.context().storageState({ path: MEMBER_STATE });
});
