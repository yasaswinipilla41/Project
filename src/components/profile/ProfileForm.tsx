"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, MetaRow } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { changeOwnPassword, updateProfile } from "@/server/users";
import type { FieldErrors } from "@/server/schemas";

/**
 * Profile settings.
 *
 * The fields are shown as a summary and edited in a dialog rather than sitting
 * permanently in an editable form — a page of live inputs invites accidental
 * edits, and there is no draft state here to protect them.
 *
 * Changing a password is a separate dialog reached from the same place. It is
 * separate on purpose: it asks for the current password, which the profile
 * fields have no business collecting, and it saves through its own action.
 */
export function ProfileForm({
  initialName,
  initialJobTitle,
  initialEmailNotifications,
}: {
  initialName: string;
  initialJobTitle: string;
  initialEmailNotifications: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const [name, setName] = useState(initialName);
  const [jobTitle, setJobTitle] = useState(initialJobTitle);
  const [emailNotifications, setEmailNotifications] = useState(
    initialEmailNotifications,
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  /** Reopening starts from what is saved, so a cancelled edit leaves nothing behind. */
  function openEditor() {
    setName(initialName);
    setJobTitle(initialJobTitle);
    setEmailNotifications(initialEmailNotifications);
    setErrors({});
    setFormError(null);
    setEditing(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);

    const result = await updateProfile({
      name,
      jobTitle,
      emailNotificationsEnabled: emailNotifications,
    });

    setSaving(false);

    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      setFormError(result.error);
      return;
    }

    setEditing(false);
    toast("Profile updated");
    router.refresh();
  }

  return (
    <>
      <MetaRow label="Display name">{initialName}</MetaRow>
      <MetaRow label="Job title">
        {initialJobTitle || <span className="prio-text-muted">Not set</span>}
      </MetaRow>
      <MetaRow label="Email notifications">
        {initialEmailNotifications ? "On" : "Off"}
      </MetaRow>

      <div
        style={{
          display: "flex",
          gap: "var(--prio-space-3)",
          marginTop: "var(--prio-space-5)",
        }}
      >
        <Button variant="primary" onClick={openEditor}>
          Edit
        </Button>
        <Button variant="secondary" onClick={() => setChangingPassword(true)}>
          Change password
        </Button>
      </div>

      {editing ? (
        <Dialog
          open
          onClose={() => setEditing(false)}
          busy={saving}
          title="Edit profile"
          description="Your name and job title are shown to everyone in this workspace."
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="prio-profile-form"
                loading={saving}
              >
                Save
              </Button>
            </>
          }
        >
          <form id="prio-profile-form" onSubmit={submit} noValidate>
            {formError ? (
              <p className="prio-error" role="alert">
                {formError}
              </p>
            ) : null}

            <div className="prio-field">
              <label className="prio-label" htmlFor="profile-name">
                Display name
              </label>
              <input
                id="profile-name"
                className="prio-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
                aria-invalid={errors.name ? true : undefined}
              />
              {errors.name ? (
                <span className="prio-error" role="alert">
                  {errors.name}
                </span>
              ) : null}
            </div>

            <div className="prio-field">
              <label className="prio-label" htmlFor="profile-title">
                Job title
              </label>
              <input
                id="profile-title"
                className="prio-input"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                maxLength={80}
                placeholder="Engineer, Designer, QA"
              />
            </div>

            <div className="prio-field">
              <label className="prio-checkbox">
                <input
                  type="checkbox"
                  checked={emailNotifications}
                  onChange={(e) => setEmailNotifications(e.target.checked)}
                />
                Send me email notifications
              </label>
              <span className="prio-hint">
                In-app notifications are always delivered. This controls email
                only.
              </span>
            </div>
          </form>
        </Dialog>
      ) : null}

      {changingPassword ? (
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} />
      ) : null}
    </>
  );
}

/**
 * Changing your own password.
 *
 * Asks for the current one — that is the whole point of a self-service change
 * as opposed to an administrator's reset, and it is what stops a walk-up on an
 * unlocked session becoming an account takeover. Nothing typed here is kept
 * after the dialog closes.
 */
function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);

    const result = await changeOwnPassword({
      currentPassword,
      newPassword,
      confirmPassword,
    });

    setSaving(false);

    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      setFormError(result.error);
      return;
    }

    toast("Password changed");
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={saving}
      title="Change password"
      description="You will stay signed in on this device."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="prio-password-form"
            loading={saving}
          >
            Change password
          </Button>
        </>
      }
    >
      <form id="prio-password-form" onSubmit={submit} noValidate>
        {formError ? (
          <p className="prio-error" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="prio-field">
          <label className="prio-label" htmlFor="password-current">
            Current password
          </label>
          <input
            id="password-current"
            type="password"
            autoComplete="current-password"
            className="prio-input"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            aria-invalid={errors.currentPassword ? true : undefined}
          />
          {errors.currentPassword ? (
            <span className="prio-error" role="alert">
              {errors.currentPassword}
            </span>
          ) : null}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="password-new">
            New password
          </label>
          <input
            id="password-new"
            type="password"
            autoComplete="new-password"
            className="prio-input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            aria-invalid={errors.newPassword ? true : undefined}
          />
          {errors.newPassword ? (
            <span className="prio-error" role="alert">
              {errors.newPassword}
            </span>
          ) : (
            <span className="prio-hint">At least 8 characters.</span>
          )}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="password-confirm">
            Confirm new password
          </label>
          <input
            id="password-confirm"
            type="password"
            autoComplete="new-password"
            className="prio-input"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            aria-invalid={errors.confirmPassword ? true : undefined}
          />
          {errors.confirmPassword ? (
            <span className="prio-error" role="alert">
              {errors.confirmPassword}
            </span>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
