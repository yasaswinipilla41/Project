"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button } from "@/components/ui/primitives";
import { IconWarning } from "@/components/ui/Icon";
import { changeOwnPassword } from "@/server/users";
import type { FieldErrors } from "@/server/schemas";

/**
 * The first-login password form.
 *
 * It saves through `changeOwnPassword` — the same action the profile's own
 * password dialog uses — rather than an action of its own. That action already
 * asks for the current password, hashes with the one hashing path this
 * application has, and now clears `mustChangePassword` in the same
 * transaction, so there is nothing for this form to add beyond collecting
 * three fields.
 *
 * On success it navigates with `window.location` rather than a router push:
 * the gate that sent the person here lives in a server layout, and only a real
 * navigation re-runs it with the flag now cleared.
 */
export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);

    const result = await changeOwnPassword({
      currentPassword,
      newPassword,
      confirmPassword,
    });

    if (!result.ok) {
      setSaving(false);
      setErrors(result.fieldErrors ?? {});
      setFormError(result.error);
      return;
    }

    /*
     * A full document load, not a router push.
     *
     * What sent this person here is a redirect in the authenticated layout,
     * and that layout has to run again — against a user row whose flag is now
     * cleared — before the application will let them in. A client transition
     * can reuse the segment it already rendered, which is the one case where
     * this would bounce straight back to this form. The sign-in form navigates
     * the same way, for the same reason.
     */
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/";
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
        <label className="prio-label" htmlFor="current-password">
          Temporary password
        </label>
        <input
          id="current-password"
          name="currentPassword"
          type="password"
          className="prio-input"
          autoComplete="current-password"
          required
          autoFocus
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          aria-invalid={errors.currentPassword ? true : undefined}
        />
        <span className="prio-hint">
          The one from the email your administrator sent you.
        </span>
        {errors.currentPassword ? (
          <span className="prio-error" role="alert">
            {errors.currentPassword}
          </span>
        ) : null}
      </div>

      <div className="prio-field">
        <label className="prio-label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          name="newPassword"
          type="password"
          className="prio-input"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          aria-invalid={errors.newPassword ? true : undefined}
        />
        <span className="prio-hint">At least 8 characters.</span>
        {errors.newPassword ? (
          <span className="prio-error" role="alert">
            {errors.newPassword}
          </span>
        ) : null}
      </div>

      <div className="prio-field">
        <label className="prio-label" htmlFor="confirm-password">
          New password again
        </label>
        <input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          className="prio-input"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          aria-invalid={errors.confirmPassword ? true : undefined}
        />
        {errors.confirmPassword ? (
          <span className="prio-error" role="alert">
            {errors.confirmPassword}
          </span>
        ) : null}
      </div>

      <Button type="submit" variant="brand" loading={saving} style={{ width: "100%" }}>
        Save and continue
      </Button>
    </form>
  );
}
