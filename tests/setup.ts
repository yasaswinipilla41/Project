import "dotenv/config";
import { vi } from "vitest";

/**
 * Test harness for Prio's server actions.
 *
 * The actions are ordinary async functions that happen to read the session from
 * `next/headers` and call `revalidatePath`. Both are replaced here so an action
 * can be exercised directly against the real PostgreSQL database, with a real
 * better-auth session, outside a request.
 */

/** Headers the mocked `next/headers` will return. Set by `actAs()`. */
export const testHeaders = { current: new Headers() };

vi.mock("next/headers", () => ({
  headers: async () => testHeaders.current,
  cookies: async () => ({
    get: () => undefined,
    has: () => false,
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));

// `redirect` throws in Next; here it should surface as a clear failure rather
// than a silent pass, since a test hitting it means authorization diverged.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`Unexpected redirect to ${url}`);
  },
  notFound: () => {
    throw new Error("Unexpected notFound()");
  },
}));
