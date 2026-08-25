"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Avatar, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import { createProject } from "@/server/projects";
import type { FieldErrors } from "@/server/schemas";

export interface SelectableUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

/**
 * Admin-only project creation (§19). The key is suggested from the name but
 * stays editable, and is immutable once the project exists — issue keys are
 * built from it.
 */
export function CreateProjectDialog({
  open,
  onClose,
  users,
  currentUserId,
}: {
  open: boolean;
  onClose: () => void;
  users: SelectableUser[];
  currentUserId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  /** "Internal Tools" -> "INT"; the admin can override it. */
  function suggestKey(value: string): string {
    const words = value.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const raw =
      words.length === 1
        ? words[0]!.slice(0, 3)
        : words.map((w) => w[0]).join("");
    return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setErrors({});

    const result = await createProject({
      name,
      key,
      description,
      memberIds,
    });

    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
    }

    onClose();
    toast(
      <>
        Created project <strong>{result.data.key}</strong>
      </>,
    );
    router.push(`/projects/${result.data.key.toLowerCase()}`);
    router.refresh();
  }

  const selectable = users.filter((u) => u.id !== currentUserId);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={submitting}
      title="Create project"
      description="Projects group issues, stories and bugs, and own their issue key."
      footer={
        <>
          <span className="prio-dialog__footer-note">
            The project key cannot be changed later.
          </span>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="brand"
            type="submit"
            form="prio-create-project"
            loading={submitting}
          >
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </>
      }
    >
      <form id="prio-create-project" onSubmit={handleSubmit} noValidate>
        {formError ? (
          <div style={{ marginBottom: "var(--prio-space-5)" }}>
            <Alert tone="danger" icon={<IconWarning />}>
              {formError}
            </Alert>
          </div>
        ) : null}

        <div className="prio-field">
          <label className="prio-label" htmlFor="project-name">
            Project name <span className="prio-label__required">*</span>
          </label>
          <input
            id="project-name"
            className="prio-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(suggestKey(e.target.value));
            }}
            placeholder="Engineering"
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
          <label className="prio-label" htmlFor="project-key">
            Project key <span className="prio-label__required">*</span>
          </label>
          <input
            id="project-key"
            className="prio-input prio-mono"
            value={key}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toUpperCase());
            }}
            placeholder="ENG"
            required
            maxLength={10}
            style={{ maxWidth: 180, textTransform: "uppercase" }}
            aria-invalid={errors.key ? true : undefined}
            aria-describedby="project-key-hint"
          />
          {errors.key ? (
            <span className="prio-error" role="alert">
              {errors.key}
            </span>
          ) : null}
          <span className="prio-hint" id="project-key-hint">
            Issues in this project will be numbered{" "}
            <span className="prio-key">{key || "KEY"}-1</span>,{" "}
            <span className="prio-key">{key || "KEY"}-2</span> and so on.
          </span>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="project-description">
            Description
          </label>
          <textarea
            id="project-description"
            className="prio-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this project cover?"
            rows={3}
            maxLength={2000}
          />
        </div>

        {selectable.length > 0 ? (
          <div className="prio-field">
            <span className="prio-label" id="project-members-label">
              Members
            </span>
            <span className="prio-hint">
              You are added automatically. Members can see the project and work
              on its issues.
            </span>
            <div
              className="prio-memberpicker"
              role="group"
              aria-labelledby="project-members-label"
            >
              {selectable.map((user) => {
                const selected = memberIds.includes(user.id);
                return (
                  <button
                    key={user.id}
                    type="button"
                    className="prio-memberpicker__item"
                    data-selected={selected}
                    aria-pressed={selected}
                    onClick={() =>
                      setMemberIds((prev) =>
                        selected
                          ? prev.filter((id) => id !== user.id)
                          : [...prev, user.id],
                      )
                    }
                  >
                    <Avatar name={user.name} image={user.image} size="md" />
                    <span className="prio-memberpicker__text">
                      <span className="prio-memberpicker__name">{user.name}</span>
                      <span className="prio-memberpicker__meta">
                        {user.jobTitle ?? user.email}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
