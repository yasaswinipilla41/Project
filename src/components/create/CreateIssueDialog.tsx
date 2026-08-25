"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { IssueTypeIcon } from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import {
  ISSUE_TYPES,
  ISSUE_TYPE_DESCRIPTION,
  ISSUE_TYPE_LABEL,
  ISSUE_STATUSES,
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
  SEVERITY_DESCRIPTION,
  SEVERITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import type { IssueStatus, IssueType, Priority, Severity } from "@prisma/client";
import { createIssue } from "@/server/issues";
import type { FieldErrors } from "@/server/schemas";

/**
 * The global Create dialog.
 *
 * One dialog serves Task, Bug and Story. Choosing Bug adds severity and makes
 * the description required — the same rule the server enforces, so the two can
 * never disagree.
 *
 * The long-form reproduction write-up that used to live here (steps, expected
 * result, actual result, environment) has been removed from creation. The
 * columns remain in the database and existing bugs still display whatever they
 * recorded; new bugs simply start with a description and gain detail through
 * comments and attachments instead of a wall of required fields.
 */

interface OptionProject {
  id: string;
  key: string;
  name: string;
}
interface OptionMember {
  id: string;
  name: string;
  email: string;
  image: string | null;
}
interface OptionLabel {
  id: string;
  name: string;
  color: string;
}
interface OptionParent {
  id: string;
  key: string;
  title: string;
  type: IssueType;
}

export interface CreateIssueDialogProps {
  open: boolean;
  onClose: () => void;
  /** Preselects a project, e.g. when opened from inside a project. */
  defaultProjectId?: string | null;
  defaultType?: IssueType;
}

/**
 * Field-level validation message. Declared at module scope so React keeps the
 * same component identity across renders — a component defined inside another
 * component's body remounts on every keystroke and would drop input focus.
 */
function FieldError({
  errors,
  field,
}: {
  errors: FieldErrors;
  field: string;
}) {
  if (!errors[field]) return null;
  return (
    <span className="prio-error" role="alert">
      {errors[field]}
    </span>
  );
}

const EMPTY_FORM = {
  title: "",
  description: "",
  status: "BACKLOG" as IssueStatus,
  priority: "MEDIUM" as Priority,
  assigneeId: "",
  dueDate: "",
  parentId: "",
  severity: "MAJOR" as Severity,
};

export function CreateIssueDialog({
  open,
  onClose,
  defaultProjectId = null,
  defaultType = "TASK",
}: CreateIssueDialogProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [type, setType] = useState<IssueType>(defaultType);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [form, setForm] = useState(EMPTY_FORM);
  const [labelIds, setLabelIds] = useState<string[]>([]);

  const [projects, setProjects] = useState<OptionProject[]>([]);
  const [members, setMembers] = useState<OptionMember[]>([]);
  const [labels, setLabels] = useState<OptionLabel[]>([]);
  const [parents, setParents] = useState<OptionParent[]>([]);

  /**
   * The project whose options are currently loaded (`undefined` before the
   * first response). Loading is derived from it rather than stored separately,
   * which keeps the fetch effect free of synchronous state updates.
   */
  const [optionsFor, setOptionsFor] = useState<string | null | undefined>(
    undefined,
  );
  const loadingOptions = optionsFor !== (projectId || null);

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isBug = type === "BUG";

  const set = useCallback(
    <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    },
    [],
  );

  // Load projects, then the selected project's members, labels and parents.
  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();

    const url = projectId
      ? `/api/create-options?projectId=${encodeURIComponent(projectId)}`
      : "/api/create-options";

    fetch(url, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        setProjects(data.projects ?? []);
        setMembers(data.members ?? []);
        setLabels(data.labels ?? []);
        setParents(data.parents ?? []);

        // Preselect when the user only has one project to choose from.
        if (!projectId && data.projects?.length === 1) {
          setProjectId(data.projects[0].id);
          return;
        }
        setOptionsFor(projectId || null);
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setOptionsFor(projectId || null);
        setFormError("Could not load projects. Close and try again.");
      });

    return () => controller.abort();
  }, [open, projectId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setErrors({});

    const result = await createIssue({
      projectId,
      type,
      title: form.title,
      description: form.description,
      status: form.status,
      priority: form.priority,
      assigneeId: form.assigneeId,
      labelIds,
      dueDate: form.dueDate,
      parentId: form.parentId,
      severity: isBug ? form.severity : null,
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
        Created <strong>{result.data.key}</strong> — {result.data.title}
      </>,
    );
    router.push(`/issues/${result.data.key.toLowerCase()}`);
    router.refresh();
  }

  const invalid = (field: string) => (errors[field] ? true : undefined);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      busy={submitting}
      title={`Create ${ISSUE_TYPE_LABEL[type].toLowerCase()}`}
      description={ISSUE_TYPE_DESCRIPTION[type]}
      footer={
        <>
          <span className="prio-dialog__footer-note">
            {isBug
              ? "Describe the problem — you can add steps, screenshots and recordings in the comments."
              : ISSUE_TYPE_DESCRIPTION[type]}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="brand"
            type="submit"
            form="prio-create-form"
            loading={submitting}
          >
            {submitting ? "Creating…" : `Create ${ISSUE_TYPE_LABEL[type].toLowerCase()}`}
          </Button>
        </>
      }
    >
      <form id="prio-create-form" onSubmit={handleSubmit} noValidate>
        {formError ? (
          <div style={{ marginBottom: "var(--prio-space-5)" }}>
            <Alert tone="danger" icon={<IconWarning />}>
              {formError}
            </Alert>
          </div>
        ) : null}

        {/* ------------------------------------------------- type picker */}
        <fieldset className="prio-typepicker" aria-label="Issue type">
          {ISSUE_TYPES.map((option) => (
            <button
              key={option}
              type="button"
              className="prio-typepicker__option"
              data-selected={type === option}
              aria-pressed={type === option}
              onClick={() => setType(option)}
            >
              <IssueTypeIcon type={option} size={22} />
              <span className="prio-typepicker__label">
                {ISSUE_TYPE_LABEL[option]}
              </span>
              <span className="prio-typepicker__hint">
                {ISSUE_TYPE_DESCRIPTION[option]}
              </span>
            </button>
          ))}
        </fieldset>

        {/* ---------------------------------------------------- project */}
        <div className="prio-field">
          <label className="prio-label" htmlFor="create-project">
            Project <span className="prio-label__required">*</span>
          </label>
          <select
            id="create-project"
            className="prio-select"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setLabelIds([]);
              set("assigneeId", "");
              set("parentId", "");
            }}
            required
            aria-invalid={invalid("projectId")}
            disabled={loadingOptions && projects.length === 0}
          >
            <option value="">
              {loadingOptions && projects.length === 0
                ? "Loading projects…"
                : "Choose a project"}
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} ({project.key})
              </option>
            ))}
          </select>
          <FieldError errors={errors} field="projectId" />
          {!loadingOptions && projects.length === 0 ? (
            <span className="prio-hint">
              You are not a member of any project yet. Ask an administrator for
              access.
            </span>
          ) : null}
        </div>

        {/* ------------------------------------------------------- title */}
        <div className="prio-field">
          <label className="prio-label" htmlFor="create-title">
            {isBug ? "Bug title" : "Title"}{" "}
            <span className="prio-label__required">*</span>
          </label>
          <input
            id="create-title"
            className="prio-input"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={
              isBug
                ? "Login fails after session expiration"
                : "Short, specific summary of the work"
            }
            required
            maxLength={200}
            aria-invalid={invalid("title")}
          />
          <FieldError errors={errors} field="title" />
        </div>

        {/* ------------------------------------------------- description */}
        <div className="prio-field">
          <label className="prio-label" htmlFor="create-description">
            Description
            {isBug ? <span className="prio-label__required">*</span> : null}
          </label>
          <textarea
            id="create-description"
            className="prio-textarea"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder={
              isBug
                ? "What is broken, and what is the impact?"
                : "Add any detail that helps whoever picks this up."
            }
            rows={4}
            aria-invalid={invalid("description")}
          />
          <FieldError errors={errors} field="description" />
        </div>

        {/* --------------------------------------------------- metadata */}
        <section className="prio-formsection" aria-label="Details">
          <h3 className="prio-formsection__title">Details</h3>

          <div className="row g-3">
            <div className="col-12 col-md-6">
              <div className="prio-field">
                <label className="prio-label" htmlFor="create-status">
                  Status
                </label>
                <select
                  id="create-status"
                  className="prio-select"
                  value={form.status}
                  onChange={(e) => set("status", e.target.value as IssueStatus)}
                >
                  {ISSUE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="col-12 col-md-6">
              <div className="prio-field">
                <label className="prio-label" htmlFor="create-priority">
                  Priority
                </label>
                <select
                  id="create-priority"
                  className="prio-select"
                  value={form.priority}
                  onChange={(e) => set("priority", e.target.value as Priority)}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/*
             * Severity sits with the other metadata rather than in a section of
             * its own. It is a first-class field of a bug — the dashboard, the
             * filters and the issue list all read it — so it stays; only the
             * long-form reproduction write-up that used to surround it is gone.
             */}
            {isBug ? (
              <div className="col-12 col-md-6">
                <div className="prio-field">
                  <label className="prio-label" htmlFor="create-severity">
                    Severity
                  </label>
                  <select
                    id="create-severity"
                    className="prio-select"
                    value={form.severity}
                    onChange={(e) => set("severity", e.target.value as Severity)}
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {SEVERITY_LABEL[s]} — {SEVERITY_DESCRIPTION[s]}
                      </option>
                    ))}
                  </select>
                  <span className="prio-hint">
                    Severity is the impact of the defect; priority is how soon it
                    should be worked on. They are independent.
                  </span>
                </div>
              </div>
            ) : null}

            <div className="col-12 col-md-6">
              <div className="prio-field">
                <label className="prio-label" htmlFor="create-assignee">
                  Assignee
                </label>
                <select
                  id="create-assignee"
                  className="prio-select"
                  value={form.assigneeId}
                  onChange={(e) => set("assigneeId", e.target.value)}
                  disabled={!projectId}
                  aria-invalid={invalid("assigneeId")}
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
                <FieldError errors={errors} field="assigneeId" />
              </div>
            </div>

            <div className="col-12 col-md-6">
              <div className="prio-field">
                <label className="prio-label" htmlFor="create-due">
                  Due date
                </label>
                <input
                  id="create-due"
                  type="date"
                  className="prio-input"
                  value={form.dueDate}
                  onChange={(e) => set("dueDate", e.target.value)}
                />
              </div>
            </div>

            <div className="col-12">
              <div className="prio-field">
                <label className="prio-label" htmlFor="create-parent">
                  Parent issue
                </label>
                <select
                  id="create-parent"
                  className="prio-select"
                  value={form.parentId}
                  onChange={(e) => set("parentId", e.target.value)}
                  disabled={!projectId}
                  aria-invalid={invalid("parentId")}
                >
                  <option value="">None</option>
                  {parents.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {parent.key} — {parent.title}
                    </option>
                  ))}
                </select>
                <FieldError errors={errors} field="parentId" />
              </div>
            </div>
          </div>

          {labels.length > 0 ? (
            <div className="prio-field">
              <span className="prio-label" id="create-labels-label">
                Labels
              </span>
              <div
                className="prio-chipset"
                role="group"
                aria-labelledby="create-labels-label"
              >
                {labels.map((label) => {
                  const selected = labelIds.includes(label.id);
                  return (
                    <button
                      key={label.id}
                      type="button"
                      className="prio-chipset__chip"
                      data-selected={selected}
                      aria-pressed={selected}
                      onClick={() =>
                        setLabelIds((prev) =>
                          selected
                            ? prev.filter((id) => id !== label.id)
                            : [...prev, label.id],
                        )
                      }
                    >
                      <span
                        className="prio-label-chip__swatch"
                        style={{ background: label.color }}
                        aria-hidden
                      />
                      {label.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      </form>
    </Dialog>
  );
}
