/**
 * The one definition of what a *new* password must contain.
 *
 * Pure and dependency-free so the same rules drive both places that need them:
 * the checklist shown while somebody types (a convenience), and the server
 * validation behind every path that sets a password (the boundary). The UI is
 * never the source of truth — it renders this list, and the server calls
 * `meetsPasswordPolicy` on whatever arrives.
 *
 * This is about choosing a password, not proving you know one. Checking the
 * current password on a change stays a separate step with its own error.
 */

/** Upper bound better-auth also enforces (`maxPasswordLength`). */
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_MIN_LENGTH = 8;

/**
 * What every rejected new password is told, whichever rule it broke.
 *
 * Deliberately generic: the form already lists the rules, and a response that
 * named the failing one would tell a guesser which part of their attempt was
 * right. Not to be confused with the wrong-current-password error, which lives
 * on the current-password field.
 */
export const WEAK_PASSWORD_MESSAGE = "Incorrect password";

export type PasswordRule = {
  id: "length" | "upper" | "lower" | "number" | "special";
  label: string;
  test: (password: string) => boolean;
};

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: "length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: "upper",
    label: "At least 1 uppercase letter",
    test: (p) => /[A-Z]/.test(p),
  },
  {
    id: "lower",
    label: "At least 1 lowercase letter",
    test: (p) => /[a-z]/.test(p),
  },
  {
    id: "number",
    label: "At least 1 number",
    test: (p) => /[0-9]/.test(p),
  },
  {
    /* Anything that is not a letter, a digit or whitespace. A space is a
       legal password character but not a "special character" for this rule. */
    id: "special",
    label: "At least 1 special character",
    test: (p) => /[^\p{L}\p{N}\s]/u.test(p),
  },
];

/** True when the password satisfies every rule and fits the length ceiling. */
export function meetsPasswordPolicy(password: unknown): boolean {
  return (
    typeof password === "string" &&
    password.length <= PASSWORD_MAX_LENGTH &&
    PASSWORD_RULES.every((rule) => rule.test(password))
  );
}
