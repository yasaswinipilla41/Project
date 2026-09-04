"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import {
  IconChevronDown,
  IconCopy,
  IconEdit,
  IconTrash,
  IconWarning,
} from "@/components/ui/Icon";
import { CloneProjectDialog } from "@/components/projects/CloneProjectDialog";
import { deleteProject, updateProject } from "@/server/projects";
import type { FieldErrors } from "@/server/schemas";

/**
 * The project's own actions menu, beside Settings.
 *
 * Two audiences share one menu. Clone is offered to anyone who can open the
 * project, because copying work you can already read is not an administrator's
 * privilege; Edit and Delete stay with the administrator or the person who
 * created it, exactly as before.
 *
 * All of that is presentation. `updateProject`, `deleteProject` and
 * `duplicateProject` each re-derive the caller and re-check access on the
 * server, so hiding an item here is a courtesy and never the control.
 */

export interface ProjectActionsProps {
  project: {
    id: string;
    key: string;
    name: string;
    description: string | null;
  };
  /** Issue count, shown in the delete dialog so the cost is stated plainly. */
  issueCount: number;
  /**
   * Whether this person may rename or delete the project — an administrator,
   * or whoever created it. Everyone who can see the project still gets the
   * menu, because Clone is theirs.
   */
  canManage: boolean;
}

export function ProjectActions({
  project,
  issueCount,
  canManage,
}: ProjectActionsProps) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);

  return (
    <>
      <Menu
        align="end"
        width={220}
        label="More project actions"
        trigger={(props) => (
          <button
            type="button"
            className="prio-btn prio-btn--secondary prio-btn--icon"
            aria-label="More project actions"
            {...props}
          >
            <IconChevronDown size={12} />
          </button>
        )}
      >
        <MenuItem icon={<IconCopy />} onSelect={() => setCloning(true)}>
          Clone project
        </MenuItem>

        {canManage ? (
          <>
            <MenuSeparator />
            <MenuItem icon={<IconEdit />} onSelect={() => setEditing(true)}>
              Edit project
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<IconTrash />}
              onSelect={() => setDeleting(true)}
            >
              Delete project
            </MenuItem>
          </>
        ) : null}
      </Menu>

      {cloning ? (
        <CloneProjectDialog project={project} onClose={() => setCloning(false)} />
      ) : null}

      {/* Mounted only while open, so each open starts from the saved values. */}
      {editing ? (
        <EditProjectDialog project={project} onClose={() => setEditing(false)} />
      ) : null}

      {deleting ? (
        <DeleteProjectDialog
          project={project}
          issueCount={issueCount}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------- edit */

export function EditProjectDialog({
  project,
  onClose,
}: {
  project: ProjectActionsProps["project"];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setErrors({});

    const result = await updateProject({
      projectId: project.id,
      name,
      description,
    });

    setSaving(false);

    if (!result.ok) {
      setFormError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
    }

    onClose();
    toast(<>Saved changes to {name}</>);
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={saving}
      title="Edit project"
      description="Change how this project is described. Its key cannot change."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="brand"
            type="submit"
            form="prio-project-edit"
            loading={saving}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <form id="prio-project-edit" onSubmit={handleSubmit} noValidate>
        {formError ? (
          <div style={{ marginBottom: "var(--prio-space-5)" }}>
            <Alert tone="danger" icon={<IconWarning />}>
              {formError}
            </Alert>
          </div>
        ) : null}

        <div className="prio-field">
          <label className="prio-label" htmlFor="project-edit-name">
            Project name <span className="prio-label__required">*</span>
          </label>
          <input
            id="project-edit-name"
            className="prio-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoFocus
            aria-invalid={errors.name ? true : undefined}
          />
          {errors.name ? (
            <span className="prio-error" role="alert">
              {errors.name}
            </span>
          ) : null}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="project-edit-key">
            Project key
          </label>
          <input
            id="project-edit-key"
            className="prio-input"
            value={project.key}
            readOnly
            disabled
          />
          <span className="prio-hint">
            Every issue in this project is permanently named after its key
            ({project.key}-1, {project.key}-2 …), so the key cannot be changed
            without breaking references that already exist.
          </span>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="project-edit-description">
            Description
          </label>
          <textarea
            id="project-edit-description"
            className="prio-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="What this project covers"
          />
        </div>
      </form>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- delete */

export function DeleteProjectDialog({
  project,
  issueCount,
  onClose,
}: {
  project: ProjectActionsProps["project"];
  issueCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /* The button unlocks only on an exact match. The server checks this again;
     this is here so nobody deletes the wrong project by muscle memory. */
  const matches = confirmName.trim() === project.name;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches) return;

    setDeleting(true);
    setFormError(null);

    const result = await deleteProject({
      projectId: project.id,
      confirmName,
    });

    if (!result.ok) {
      setDeleting(false);
      setFormError(result.error);
      return;
    }

    onClose();
    toast(
      <>
        Deleted <strong>{project.name}</strong>
        {result.data.issues > 0
          ? ` and its ${result.data.issues} ${
              result.data.issues === 1 ? "issue" : "issues"
            }`
          : ""}
      </>,
    );
    router.push("/projects");
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={deleting}
      title="Delete project?"
      description="This cannot be undone."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            type="submit"
            form="prio-project-delete"
            loading={deleting}
            disabled={!matches}
          >
            {deleting ? "Deleting…" : "Delete project"}
          </Button>
        </>
      }
    >
      <form id="prio-project-delete" onSubmit={handleSubmit} noValidate>
        {formError ? (
          <div style={{ marginBottom: "var(--prio-space-5)" }}>
            <Alert tone="danger" icon={<IconWarning />}>
              {formError}
            </Alert>
          </div>
        ) : null}

        <Alert tone="danger" icon={<IconWarning />}>
          Deleting <strong>{project.name}</strong> permanently removes{" "}
          {issueCount === 0
            ? "the project"
            : `${issueCount} ${issueCount === 1 ? "issue" : "issues"}`}{" "}
          along with every comment, attachment, label and piece of activity
          recorded against them.
        </Alert>

        <div className="prio-field" style={{ marginTop: "var(--prio-space-5)" }}>
          <label className="prio-label" htmlFor="project-delete-confirm">
            Type <strong>{project.name}</strong> to confirm
          </label>
          <input
            id="project-delete-confirm"
            className="prio-input"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            autoComplete="off"
            autoFocus
            aria-describedby="project-delete-hint"
          />
          <span className="prio-hint" id="project-delete-hint">
            {matches
              ? "Names match. This will delete the project."
              : "The name must match exactly."}
          </span>
        </div>
      </form>
    </Dialog>
  );
}
