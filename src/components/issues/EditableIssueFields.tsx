"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/primitives";
import { RichText } from "@/components/richtext/RichText";
import { useToast } from "@/components/ui/Toast";
import { IconEdit, IconParent } from "@/components/ui/Icon";
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

/* ---------------------------------------------------------- description */

/**
 * The issue's description — the field every type shares.
 *
 * `description` has been a column since the beginning and search has always
 * read it, but no screen offered it: the create form dropped it, and the
 * detail page never rendered it. A bug therefore had nowhere to record what
 * happened except a comment, which is exactly why the bug-only prompt list
 * existed. With the field back, one description serves a Story, a Task and a
 * Bug alike.
 *
 * Read as rich text, written as plain text — the same arrangement the
 * conversation uses, so a description and a comment are formatted by one
 * parser and not two.
 */
export function EditableDescription({
  issueId,
  description,
}: {
  issueId: string;
  description: string | null;
}) {
  const { save, saving } = useFieldSave(issueId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim() === (description ?? "").trim()) {
      setEditing(false);
      return;
    }
    const saved = await save(
      { description: value },
      value.trim() ? "Description updated" : "Description cleared",
    );
    if (saved) setEditing(false);
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="prio-editable__form">
        <label className="prio-visually-hidden" htmlFor="issue-description-edit">
          Description
        </label>
        <textarea
          id="issue-description-edit"
          className="prio-textarea"
          rows={10}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={20000}
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
    <div className="prio-editable">
      {description ? (
        <RichText value={description} />
      ) : (
        <p className="prio-text-muted" style={{ fontSize: "var(--prio-text-sm)" }}>
          No description yet. Add what happened, what should happen, and
          anything needed to reproduce or verify it.
        </p>
      )}
      <button
        type="button"
        className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm prio-editable__trigger"
        onClick={() => {
          setValue(description ?? "");
          setEditing(true);
        }}
        aria-label="Edit description"
      >
        <IconEdit size={14} />
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- parent */

export interface ParentCandidate {
  id: string;
  key: string;
  title: string;
}

/**
 * Which **issue** this one is filed under.
 *
 * The parent of an issue is another issue, never its project: `INT-108` is a
 * child of `INT-101`, and both live in Internal Tools. The two relationships
 * are stored separately (`parentId` and `projectId`) and are shown separately
 * — the Project row directly below this one is the project, and neither row is
 * ever filled in from the other.
 *
 * Candidates come from the same `/api/create-options` endpoint the create
 * dialog's parent picker uses, so there is one query deciding what may be a
 * parent (top-level issues in this project) rather than two that can drift.
 * The issue itself is filtered out of the list, and `updateIssue` refuses a
 * self-parent, a cross-project parent, a parent that is already a sub-issue
 * and an issue that has sub-issues of its own — the picker is a convenience,
 * the server is the rule.
 */
export function ParentControl({
  issueId,
  projectId,
  parent,
}: {
  issueId: string;
  projectId: string;
  parent: { key: string; title: string } | null;
}) {
  const { save, saving } = useFieldSave(issueId);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [chosenId, setChosenId] = useState("");
  const [candidates, setCandidates] = useState<ParentCandidate[]>([]);

  /* The list is fetched, and re-fetched as the search narrows, so a project
     with thousands of issues never ships them all to the browser. */
  useEffect(() => {
    if (!editing) return;

    const controller = new AbortController();
    const term = query.trim();
    const timer = setTimeout(
      () => {
        const url =
          `/api/create-options?projectId=${encodeURIComponent(projectId)}` +
          (term ? `&q=${encodeURIComponent(term)}` : "");

        fetch(url, { signal: controller.signal })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
          .then((data: { parents?: ParentCandidate[] }) =>
            setCandidates(
              (data.parents ?? []).filter((option) => option.id !== issueId),
            ),
          )
          .catch(() => {
            /* A failed or superseded search leaves the previous list up; an
               empty picker would read as "nothing matches". */
          });
      },
      term ? 250 : 0,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [editing, projectId, issueId, query]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await save({ parentId: chosenId }, chosenId ? "Parent set" : "Parent cleared")) {
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="prio-editable__form">
        <label className="prio-visually-hidden" htmlFor="issue-parent-edit">
          Parent issue
        </label>
        <input
          id="issue-parent-edit"
          className="prio-input"
          list="issue-parent-options"
          value={query}
          placeholder="Search by key or title"
          autoComplete="off"
          autoFocus
          onChange={(event) => {
            const text = event.target.value;
            setQuery(text);
            /* The datalist hands back the option's own value, so an exact hit
               selects and anything else clears — which is what makes
               half-typed text mean "no parent" rather than the last thing
               that happened to match. */
            const hit = candidates.find(
              (option) => `${option.key} — ${option.title}` === text,
            );
            setChosenId(hit ? hit.id : "");
          }}
        />
        <datalist id="issue-parent-options">
          {candidates.map((option) => (
            <option key={option.id} value={`${option.key} — ${option.title}`} />
          ))}
        </datalist>
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
          {parent ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => void save({ parentId: "" }, "Parent cleared").then(
                (done) => done && setEditing(false),
              )}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <span className="prio-editable prio-editable--inline">
      {parent ? (
        <Link
          href={`/issues/${parent.key.toLowerCase()}`}
          className="prio-parentlink"
        >
          <IconParent size={13} />
          {parent.key}
        </Link>
      ) : (
        <span className="prio-text-muted">None</span>
      )}
      <button
        type="button"
        className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm prio-editable__trigger"
        onClick={() => {
          setQuery("");
          setChosenId("");
          setEditing(true);
        }}
        aria-label="Edit parent issue"
      >
        <IconEdit size={13} />
      </button>
    </span>
  );
}
