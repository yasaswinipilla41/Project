"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { updateProfile } from "@/server/users";
import type { FieldErrors } from "@/server/schemas";

/**
 * Self-service profile editing.
 *
 * Only the fields a person owns are editable: name, job title and their email
 * notification preference. Email, role and account status are administered,
 * never self-assigned.
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

  const [name, setName] = useState(initialName);
  const [jobTitle, setJobTitle] = useState(initialJobTitle);
  const [emailNotifications, setEmailNotifications] = useState(
    initialEmailNotifications,
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrors({});

    const result = await updateProfile({
      name,
      jobTitle,
      emailNotificationsEnabled: emailNotifications,
    });

    setSaving(false);

    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      toast(result.error, "error");
      return;
    }

    toast("Profile updated");
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate>
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
          In-app notifications are always delivered. This controls email only.
        </span>
      </div>

      <Button type="submit" variant="primary" loading={saving}>
        Save profile
      </Button>
    </form>
  );
}
