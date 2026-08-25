"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconEdit } from "@/components/ui/Icon";
import { toDateInputValue } from "@/lib/format";
import { updateIssue } from "@/server/issues";

/**
 * In-place editing of an issue's free-text fields.
 *
 * Each editor sends only the field it changed, so the partial-update contract
 * is exercised exactly as intended: nothing else on the issue is touched, and
 * the activity trail records one change.
 */

function useFieldSave(issueId: string) {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  async function save(
    patch: Record<string, unknown>,
    successMessage: string,
  ): Promise<boolean> {
    setSaving(true);
    const result = await updateIssue({ issueId, ...patch });
    setSaving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return false;
    }

    toast(successMessage);
    startTransition(() => router.refresh());
    return true;
  }

  return { save, saving };
}

/* ---------------------------------------------------------------- title */

export function EditableTitle({
  issueId,
  title,
}: {
  issueId: string;
  title: string;
}) {
  const { save, saving } = useFieldSave(issueId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim() === title) {
      setEditing(false);
      return;
    }
    if (await save({ title: value }, "Title updated")) setEditing(false);
  }

  if (!editing) {
    return (
      <h1 className="prio-issue__title prio-editable">
        {title}
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm prio-editable__trigger"
          onClick={() => {
            setValue(title);
            setEditing(true);
          }}
          aria-label="Edit title"
        >
          <IconEdit size={14} />
        </button>
      </h1>
    );
  }

  return (
    <form onSubmit={submit} className="prio-editable__form">
      <label className="prio-visually-hidden" htmlFor="issue-title-edit">
        Issue title
      </label>
      <input
        id="issue-title-edit"
        className="prio-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        required
        minLength={3}
        maxLength={200}
        autoFocus
        style={{ fontSize: "var(--prio-text-xl)", minHeight: 44 }}
      />
      <div className="prio-editable__actions">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(false)}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------- long text fields */

export function EditableText({
  issueId,
  field,
  label,
  value,
  emptyText,
  rows = 6,
  mono,
}: {
  issueId: string;
  field:
    | "description"
    | "stepsToReproduce"
    | "expectedResult"
    | "actualResult";
  label: string;
  value: string | null;
  emptyText: string;
  rows?: number;
  mono?: boolean;
}) {
  const { save, saving } = useFieldSave(issueId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === (value ?? "")) {
      setEditing(false);
      return;
    }
    if (await save({ [field]: draft }, `${label} updated`)) setEditing(false);
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="prio-editable__form">
        <label className="prio-visually-hidden" htmlFor={`edit-${field}`}>
          {label}
        </label>
        <textarea
          id={`edit-${field}`}
          className="prio-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={rows}
          autoFocus
        />
        <div className="prio-editable__actions">
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(value ?? "");
              setEditing(false);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="prio-editable">
      {value ? (
        <div className={mono ? "prio-prose prio-prose--steps" : "prio-prose"}>
          {value}
        </div>
      ) : (
        <p className="prio-text-muted">{emptyText}</p>
      )}
      <button
        type="button"
        className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm prio-editable__trigger"
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        aria-label={`Edit ${label.toLowerCase()}`}
      >
        <IconEdit size={14} />
      </button>
    </div>
  );
}

/** Wraps the read-only due date so it can be swapped into edit mode. */
export function DueDateField({
  issueId,
  dueDate,
  children,
}: {
  issueId: string;
  dueDate: Date | null;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const { save, saving } = useFieldSave(issueId);
  const [value, setValue] = useState(toDateInputValue(dueDate));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await save({ dueDate: value }, value ? "Due date set" : "Due date cleared")) {
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="prio-editable__form">
        <label className="prio-visually-hidden" htmlFor="due-date-edit">
          Due date
        </label>
        <input
          id="due-date-edit"
          type="date"
          className="prio-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <div className="prio-editable__actions">
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <span className="prio-editable prio-editable--inline">
      {children}
      <button
        type="button"
        className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm prio-editable__trigger"
        onClick={() => {
          setValue(toDateInputValue(dueDate));
          setEditing(true);
        }}
        aria-label="Edit due date"
      >
        <IconEdit size={13} />
      </button>
    </span>
  );
}
