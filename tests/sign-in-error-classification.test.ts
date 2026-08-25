import { describe, expect, it } from "vitest";
import { describeSignInError } from "@/app/(auth)/sign-in/SignInForm";

/**
 * How a failed sign-in attempt is worded (§ SignInForm.tsx).
 *
 * The root cause of "existing credentials get rejected" turned out to have
 * nothing to do with password verification: a request whose Origin header
 * does not match the server's configured BASE_URL is refused by better-auth's
 * origin check with a 403, before the credential is ever looked at — and this
 * function used to fold that into the same "not recognised" wording as an
 * actual wrong password, sending someone off to reset a password that was
 * never checked. This pins the classification down so a real credential
 * failure, throttling, a server error and an origin mismatch each say what
 * actually happened.
 */
describe("describeSignInError", () => {
  it("labels an origin mismatch as a connectivity problem, not a credential one", () => {
    const message = describeSignInError({ status: 403 }, "correct-password");
    expect(message).not.toContain("not recognised");
    expect(message.toLowerCase()).toContain("origin");
  });

  it("still gives the deliberately vague message for an actual bad credential", () => {
    // No status at all is what a real 401 from the credential check produces —
    // the message must stay identical whether the email or the password was
    // wrong, so it must not name either.
    const message = describeSignInError({}, "wrong-password");
    expect(message).toBe("That email and password combination is not recognised.");
  });

  it("still catches throttling before it reaches the generic message", () => {
    const message = describeSignInError({ status: 429 }, "any-password");
    expect(message).toContain("Too many sign-in attempts");
  });

  it("still catches a server error before it reaches the generic message", () => {
    const message = describeSignInError({ status: 503 }, "any-password");
    expect(message).toContain("could not reach the sign-in service");
  });

  it("still flags a leading/trailing space on the password itself", () => {
    const message = describeSignInError({}, " padded-password ");
    expect(message).toContain("starts or ends with a space");
  });
});
