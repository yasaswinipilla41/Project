/**
 * Whether anybody may create their own account.
 *
 * Off unless an operator turns it on. Prio is an internal system: an account
 * gives its holder every project an administrator has marked as a default one,
 * and self-registration verifies nothing about who is asking. So the safe state
 * is closed — an administrator creates accounts — and opening it is a
 * deliberate, visible act (`ALLOW_SELF_SIGNUP=true`), not the absence of a
 * setting.
 *
 * Read at call time, not import time, so a test or an operator changing the
 * environment is honoured without a rebuild.
 */
export function selfSignupEnabled(): boolean {
  return process.env.ALLOW_SELF_SIGNUP === "true";
}

/** Shown wherever sign-up is refused. */
export const SELF_SIGNUP_DISABLED_MESSAGE =
  "Self-registration is turned off. Ask an administrator to create your account.";
