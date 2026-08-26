"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert, Button } from "@/components/ui/primitives";
import { IconEye, IconEyeOff, IconSuccess, IconWarning } from "@/components/ui/Icon";
import { signUp } from "@/server/signup";
import type { FieldErrors } from "@/server/schemas";

/**
 * The registration form.
 *
 * On success this does not sign anyone in — `signUp` never creates a session —
 * so the form's own job ends at showing the confirmation and handing the
 * person to `/sign-in` with their new address already in the field, rather
 * than making them retype it right after choosing it.
 */
export function SignUpForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setErrors({});

    // A same-field check the server also makes — catching it here saves a
    // round trip for the most common way this form is filled in wrong.
    if (password !== confirmPassword) {
      setErrors({ confirmPassword: "Passwords do not match." });
      return;
    }

    setPending(true);

    const result = await signUp({
      name: name.trim(),
      email: email.trim(),
      password,
      confirmPassword,
    });

    setPending(false);

    if (!result.ok) {
      setFormError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
    }

    setCreated(true);
  }

  if (created) {
    return (
      <div className="prio-auth__success">
        <span className="prio-auth__success-icon" aria-hidden>
          <IconSuccess size={20} />
        </span>
        <h3 className="prio-auth__success-title">Account created</h3>
        <p className="prio-auth__success-body">
          Account created successfully. Please sign in with your new password.
        </p>
        <Button
          variant="brand"
          size="lg"
          block
          onClick={() => {
            /*
             * A real navigation, not `router.push` — Chrome only credits a
             * newly typed email to its per-site autofill history after the
             * form that carried it is followed by an actual page load, the
             * same reasoning as the sign-in redirect (see SignInForm).
             * Without it, an address entered on this exact form would never
             * show up as a suggestion back on `/sign-in`.
             */
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.href = `/sign-in?email=${encodeURIComponent(email.trim())}`;
          }}
        >
          Go to Sign In
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError ? (
        <div style={{ marginBottom: "var(--prio-space-5)" }}>
          <Alert tone="danger" icon={<IconWarning />}>
            {formError}
          </Alert>
        </div>
      ) : null}

      <div className="prio-field">
        <label className="prio-label" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          className="prio-input"
          autoComplete="name"
          required
          autoFocus
          placeholder="Your full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name ? true : undefined}
        />
        {errors.name ? (
          <span className="prio-error" role="alert">
            {errors.name}
          </span>
        ) : null}
      </div>

      <div className="prio-field">
        <label className="prio-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="prio-input"
          autoComplete="email"
          required
          placeholder="you@symbiosystech.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errors.email ? true : undefined}
        />
        {errors.email ? (
          <span className="prio-error" role="alert">
            {errors.email}
          </span>
        ) : null}
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={errors.password ? true : undefined}
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
        {errors.password ? (
          <span className="prio-error" role="alert">
            {errors.password}
          </span>
        ) : (
          <span className="prio-hint">At least 8 characters.</span>
        )}
      </div>

      <div className="prio-field">
        <label className="prio-label" htmlFor="confirmPassword">
          Confirm password
        </label>
        <div className="prio-auth__password-wrap">
          <input
            id="confirmPassword"
            name="confirmPassword"
            type={showConfirm ? "text" : "password"}
            className="prio-input"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-invalid={errors.confirmPassword ? true : undefined}
            style={{ paddingRight: "var(--prio-space-9)" }}
          />
          <button
            type="button"
            className="prio-auth__password-toggle"
            onClick={() => setShowConfirm((v) => !v)}
            aria-label={showConfirm ? "Hide password" : "Show password"}
          >
            {showConfirm ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
        {errors.confirmPassword ? (
          <span className="prio-error" role="alert">
            {errors.confirmPassword}
          </span>
        ) : null}
      </div>

      <Button
        type="submit"
        variant="brand"
        size="lg"
        block
        loading={pending}
        className="prio-auth__submit"
      >
        {pending ? "Creating account…" : "Create Account"}
      </Button>

      <p className="prio-auth__note">
        Already have an account? <Link href="/sign-in">Sign In</Link>
      </p>
    </form>
  );
}
