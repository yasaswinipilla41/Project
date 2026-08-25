"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { signIn } from "@/lib/auth-client";
import { Alert, Button } from "@/components/ui/primitives";
import { IconEye, IconEyeOff, IconWarning } from "@/components/ui/Icon";

/**
 * Turns a sign-in failure into something the person can act on.
 *
 * Bad credentials stay deliberately vague — the wording must be identical
 * whether or not the address exists, or the form becomes an account-enumeration
 * oracle. Throttling is different: it is not a credential problem at all, and
 * telling someone their password is wrong when it is merely rate limited sends
 * them off to reset a password that was fine.
 */
export function describeSignInError(
  error: { status?: number; message?: string },
  password: string,
): string {
  if (error.status === 429) {
    return "Too many sign-in attempts. Wait about 10 seconds, then try again.";
  }

  if (error.status && error.status >= 500) {
    return "Prio could not reach the sign-in service. Please try again.";
  }

  /*
   * better-auth's origin check (403) fires when the request's Origin header
   * doesn't match the server's configured BASE_URL — a deployment/config
   * mismatch (wrong port, a proxy rewriting the host, BASE_URL out of date),
   * never a wrong password. Folding it into the generic "not recognised"
   * message below would send someone off to reset a password that was never
   * checked, which is exactly what happened when a second instance briefly
   * ran on a different port than BASE_URL pointed at.
   */
  if (error.status === 403) {
    return "Prio could not verify this request's origin. If you're reaching Prio through a different address than usual, reload the page from the correct one, or contact an administrator.";
  }

  /*
   * A password pasted from a document or a chat message often carries a space
   * at one end. The password itself is never trimmed — a space can legitimately
   * be part of one — but silently failing on invisible whitespace sends people
   * off to reset a password that was correct.
   *
   * This says nothing about whether the account exists or whether the rest of
   * the password matched, so it does not weaken the deliberate vagueness below.
   */
  if (password !== password.trim()) {
    return "That email and password combination is not recognised. The password you entered starts or ends with a space — check for a stray character if you pasted it.";
  }

  // Same message for unknown address and wrong password, by design.
  return "That email and password combination is not recognised.";
}

export function SignInForm({
  next,
  initialEmail = "",
}: {
  next: string;
  /** Prefilled after registering, so a new account is not retyping its own address. */
  initialEmail?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const { error: signInError } = await signIn.email({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError(describeSignInError(signInError, password));
      setPending(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {error ? (
        <div style={{ marginBottom: "var(--prio-space-5)" }}>
          <Alert tone="danger" icon={<IconWarning />}>
            {error}
          </Alert>
        </div>
      ) : null}

      <div className="prio-field">
        <label className="prio-label" htmlFor="email">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="prio-input"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@symbiosystech.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>

      <div className="prio-field">
        <label className="prio-label" htmlFor="password">
          Password
        </label>
        <div className="prio-auth__password-wrap">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            className="prio-input"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            style={{ paddingRight: "var(--prio-space-9)" }}
          />
          <button
            type="button"
            className="prio-auth__password-toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
      </div>

      <Button
        type="submit"
        variant="brand"
        size="lg"
        block
        loading={pending}
        className="prio-auth__submit"
      >
        {pending ? "Signing in…" : "Sign in to Prio"}
      </Button>

      <p className="prio-auth__note">
        Don&rsquo;t have an account? <Link href="/sign-up">Create Account</Link>
      </p>
    </form>
  );
}
