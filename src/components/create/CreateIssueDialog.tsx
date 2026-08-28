"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Dialog } from "@/components/ui/Dialog";
import { IssueTypeIcon } from "@/components/ui/Indicators";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import {
  ScreenshotAttachmentField,
  type StagedScreenshot,
} from "@/components/attachments/ScreenshotAttachmentField";
import { uploadStagedScreenshot } from "@/lib/uploadAttachment";
import {
  ISSUE_TYPES,
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
import { createComment } from "@/server/comments";
import {
  ISSUE_TYPE_FORM,
  composeTypeDetail,
} from "@/lib/issueTypeForms";
import type { FieldErrors } from "@/server/schemas";

/**
 * The create dialog.
 *
 * Deliberately short: a title, a type, and the metadata that decides where the
 * work lands. The long-form fields a bug used to demand up front — description,
 * reproduction steps, expected and actual result — are no longer collected
 * here. Their columns still exist and still hold what earlier issues recorded;
 * detail now arrives through comments and attachments on the issue itself.
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
  /**
   * Shows the five-type selector and makes the submit button name the type.
   *
   * Opt-in, and only the top bar's `prio-create` control opts in. The Issues
   * page header creates a plain issue with no type question and must keep
   * doing exactly that, so it simply does not pass this — the two entry
   * points share the dialog without sharing this behaviour.
   */
  showTypeSelector?: boolean;
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

/**
 * One label/control row.
 *
 * The label sits beside its control rather than above it, which is what gives
 * the form its scannable left edge: every label ends at the same x, so the
 * eye runs down the names and stops at the one it wants. Module scope, for
 * the same reason as `FieldError` above.
 */
function FieldRow({
  label,
  htmlFor,
  labelledById,
  required = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** For a group of controls, which has no single element to point a label at. */
  labelledById?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="prio-createissue__row">
      {htmlFor ? (
        <label className="prio-label prio-createissue__rowlabel" htmlFor={htmlFor}>
          {label} {required ? <span className="prio-label__required">*</span> : null}
        </label>
      ) : (
        <span className="prio-label prio-createissue__rowlabel" id={labelledById}>
          {label} {required ? <span className="prio-label__required">*</span> : null}
        </span>
      )}
      <div className="prio-createissue__rowfield">{children}</div>
    </div>
  );
}

const EMPTY_FORM = {
  title: "",
  status: "BACKLOG" as IssueStatus,
  priority: "MEDIUM" as Priority,
  assigneeId: "",
  dueDate: "",
  parentId: "",
  severity: "" as Severity | "",
};

export function CreateIssueDialog({
  open,
  onClose,
  defaultProjectId = null,
  defaultType = "TASK",
  showTypeSelector = false,
}: CreateIssueDialogProps) {
  const router = useRouter();
  const { toast } = useToast();

  /*
   * The type the issue will be created as. It is state so the selector can
   * change it, but nothing changes it unless `showTypeSelector` is on — with
   * the selector off this holds `defaultType` for the dialog's whole life,
   * which is precisely the behaviour the Issues page header relies on.
   */
  const [type, setType] = useState<IssueType>(defaultType);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [form, setForm] = useState(EMPTY_FORM);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [screenshots, setScreenshots] = useState<StagedScreenshot[]>([]);
  /* Answers to the type's long-form prompts, keyed by section. Kept apart
     from `form` because none of them are columns — they are composed into the
     issue's opening comment once it exists. */
  const [details, setDetails] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState("");

  const spec = ISSUE_TYPE_FORM[type];

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

    /* Named for the type, so a missing Epic name does not report itself as a
       missing issue title. The server still validates independently — this
       only makes the message say what the person was actually asked for. */
    if (showTypeSelector && form.title.trim().length === 0) {
      setSubmitting(false);
      setErrors({ title: spec.titleRequired });
      return;
    }

    const result = await createIssue({
      projectId,
      type,
      title: form.title,
      status: form.status,
      priority: form.priority,
      assigneeId: form.assigneeId,
      labelIds,
      dueDate: form.dueDate,
      parentId: form.parentId,
      severity: form.severity === "" ? null : form.severity,
      environment: spec.showEnvironment ? environment : undefined,
    });

    if (!result.ok) {
      setSubmitting(false);
      setFormError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
    }

    /* The written detail goes where this application already keeps written
       detail: the issue's own conversation. A failure here never blocks
       navigation — the issue is real either way. */
    if (showTypeSelector) {
      const body = composeTypeDetail(type, details);
      if (body.length > 0) {
        try {
          await createComment({ issueId: result.data.id, body });
        } catch {
          /* The issue stands on its own; the detail can be re-added by hand. */
        }
      }
    }

    // The issue exists now, so the staged screenshots have somewhere to
    // point. A failed attach never blocks navigation — the issue is real
    // either way, and its own Attachments panel can retry the upload.
    for (const [index, screenshot] of screenshots.entries()) {
      try {
        await uploadStagedScreenshot({ issueId: result.data.id }, screenshot, index);
      } catch (uploadError) {
        toast(
          uploadError instanceof Error
            ? uploadError.message
            : "A screenshot could not be attached.",
          "error",
        );
      }
    }

    setSubmitting(false);
    setScreenshots([]);
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
      title={showTypeSelector ? spec.heading : "Create Issue"}
      description={
        showTypeSelector
          ? spec.description
          : "Give it a project and a summary. Everything else can change later."
      }
      footer={
        <>
          <span className="prio-dialog__footer-note">
            Detail, steps and evidence go on the issue itself — as comments and
            attachments — once it exists.
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
            {submitting
              ? "Creating…"
              : showTypeSelector
                ? `Create ${ISSUE_TYPE_LABEL[type]}`
                : "Create issue"}
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

        {showTypeSelector ? (
          <fieldset className="prio-create__type" aria-label="What are you creating?">
            {ISSUE_TYPES.map((option) => (
              <button
                key={option}
                type="button"
                className="prio-create__type-card"
                data-selected={type === option}
                aria-pressed={type === option}
                onClick={() => setType(option)}
              >
                <IssueTypeIcon type={option} size={18} />
                <span className="prio-create__type-label">
                  {ISSUE_TYPE_LABEL[option]}
                </span>
                <span className="prio-create__type-hint">
                  {ISSUE_TYPE_FORM[option].cardHint}
                </span>
              </button>
            ))}
          </fieldset>
        ) : null}

        <div className="prio-createissue">
          {/* ------------------------------------------------ main column */}
          <div className="prio-createissue__main">
            <FieldRow label="Project" htmlFor="create-project" required>
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
                  You are not a member of any project yet. Ask an administrator
                  for access.
                </span>
              ) : null}
            </FieldRow>

            <FieldRow
              label={showTypeSelector ? spec.titleLabel : "Summary"}
              htmlFor="create-title"
              required
            >
              <input
                id="create-title"
                className="prio-input"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder={
                  showTypeSelector
                    ? spec.titlePlaceholder
                    : "Short, specific summary of the work"
                }
                required
                maxLength={200}
                aria-invalid={invalid("title")}
              />
              <FieldError errors={errors} field="title" />
            </FieldRow>

            {showTypeSelector && spec.showEnvironment ? (
              <FieldRow label="Environment" htmlFor="create-environment">
                <input
                  id="create-environment"
                  className="prio-input"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  placeholder="e.g. Chrome 151, Windows 11, Production"
                  maxLength={120}
                />
                <span className="prio-hint">
                  Stored on the issue itself and shown in its Environment panel.
                </span>
              </FieldRow>
            ) : null}

            {showTypeSelector
              ? spec.sections.map((section) => (
                  <FieldRow
                    key={section.key}
                    label={section.label}
                    htmlFor={`create-detail-${section.key}`}
                  >
                    {section.options ? (
                      <select
                        id={`create-detail-${section.key}`}
                        className="prio-select"
                        value={details[section.key] ?? ""}
                        onChange={(e) =>
                          setDetails((prev) => ({
                            ...prev,
                            [section.key]: e.target.value,
                          }))
                        }
                      >
                        <option value="">Not set</option>
                        {section.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <textarea
                        id={`create-detail-${section.key}`}
                        className="prio-textarea"
                        rows={section.rows ?? 2}
                        value={details[section.key] ?? ""}
                        onChange={(e) =>
                          setDetails((prev) => ({
                            ...prev,
                            [section.key]: e.target.value,
                          }))
                        }
                        placeholder={section.placeholder}
                        maxLength={4000}
                      />
                    )}
                  </FieldRow>
                ))
              : null}

            <FieldRow label="Priority" htmlFor="create-priority">
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
            </FieldRow>

            <FieldRow label="Assignee" htmlFor="create-assignee">
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
            </FieldRow>

            {labels.length > 0 ? (
              <FieldRow label="Labels" labelledById="create-labels-label">
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
              </FieldRow>
            ) : null}

            <FieldRow label="Due date" htmlFor="create-due">
              <input
                id="create-due"
                type="date"
                className="prio-input"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </FieldRow>

            {/*
             * Files span the full width of the column rather than sitting in a
             * label/control row: the field brings its own label, its own drop
             * zone and its own thumbnail grid, and squeezing that into the
             * narrow control cell would cost the drop target most of its area.
             * The component itself is untouched — this is only where it sits.
             */}
            <ScreenshotAttachmentField
              label="Files"
              value={screenshots}
              onChange={setScreenshots}
            />
          </div>

          {/* ----------------------------------------------------- sidebar */}
          <aside className="prio-createissue__side" aria-label="Issue details">
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

            {/*
             * Severity used to appear only when the type picker said "Bug".
             * With the picker gone it would have become unreachable, so it is
             * offered here with an explicit "Not set" — which is also the
             * default, so an issue created without touching it still stores
             * `null`, exactly as a non-bug always did.
             */}
            {!showTypeSelector || spec.showSeverity ? (
            <div className="prio-field">
              <label className="prio-label" htmlFor="create-severity">
                Severity
              </label>
              <select
                id="create-severity"
                className="prio-select"
                value={form.severity}
                onChange={(e) =>
                  set("severity", e.target.value as Severity | "")
                }
              >
                <option value="">Not set</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {SEVERITY_LABEL[s]}
                  </option>
                ))}
              </select>
              <span className="prio-hint">
                {form.severity
                  ? SEVERITY_DESCRIPTION[form.severity]
                  : "Impact of the defect. Priority is how soon it is worked on — the two are independent."}
              </span>
            </div>
            ) : null}

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
              <span className="prio-hint">
                Files this issue under an existing one. Further links can be
                added from the issue itself once it exists.
              </span>
            </div>
          </aside>
        </div>
      </form>
    </Dialog>
  );
}
