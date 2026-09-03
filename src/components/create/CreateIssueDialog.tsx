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
  labelColourFor,
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
import { createLabel } from "@/server/projects";
import { LabelPicker } from "@/components/create/LabelPicker";
import {
  DESCRIPTION_PLACEHOLDER,
  ISSUE_TYPE_FORM,
} from "@/lib/issueTypeForms";
import type { FieldErrors } from "@/server/schemas";

/**
 * The create dialog.
 *
 * One form, for every type.
 *
 * A Story, a Task and a Bug are the same record and are filed the same way:
 * summary, description, priority, severity, assignee, attachments, parent. The
 * type selector picks which of them this is, and changes nothing else — no
 * type-specific prompts, no bug-only Environment box, no severity that appears
 * for one type and vanishes for another. Everything a bug reporter used to be
 * asked separately (steps, expected, actual) belongs in the description, which
 * every type now has.
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

/*
 * Severity is a field on every type, exactly like priority. Only its *default*
 * differs: a bug opens at Major because a defect always has an impact, while
 * anything else opens unset rather than being given an opinion it has no use
 * for. That is a starting value, not a difference in the form.
 */
const EMPTY_FORM = {
  title: "",
  description: "",
  status: "BACKLOG" as IssueStatus,
  priority: "MEDIUM" as Priority,
  assigneeId: "",
  dueDate: "",
  parentId: "",
  severity: "" as Severity | "",
};

/** New bugs open at Major; anything else opens with no severity at all. */
const defaultSeverityFor = (type: IssueType): Severity | "" =>
  type === "BUG" ? "MAJOR" : "";

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
  /* A project was supplied by whatever opened this, so it is context rather
     than a choice. Global surfaces pass nothing and keep the picker. */
  const lockedProject = defaultProjectId !== null;
  const [form, setForm] = useState({
    ...EMPTY_FORM,
    severity: defaultSeverityFor(defaultType),
  });
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [screenshots, setScreenshots] = useState<StagedScreenshot[]>([]);
  const spec = ISSUE_TYPE_FORM[type];

  const [projects, setProjects] = useState<OptionProject[]>([]);
  const [members, setMembers] = useState<OptionMember[]>([]);
  const [labels, setLabels] = useState<OptionLabel[]>([]);
  const [parents, setParents] = useState<OptionParent[]>([]);
  /* Who is signed in, so "Assign to me" does not have to guess. It comes back
     with the options rather than from a second request. */
  const [viewerId, setViewerId] = useState<string | null>(null);
  /* What has been typed into the parent picker. The list itself is fetched
     from the server, so a project with thousands of issues never ships them
     all to the browser. */
  const [parentQuery, setParentQuery] = useState("");
  /* Set while a label is being created, so the picker can show it. */
  const [addingLabel, setAddingLabel] = useState(false);

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
        setViewerId(data.viewerId ?? null);

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

  /*
   * Parent search. Deliberately a second, narrower request to the same
   * endpoint rather than filtering a preloaded list in the browser: the list
   * is capped server-side, so filtering here would only ever search the
   * twenty that happened to arrive. Debounced so typing does not produce a
   * request per keystroke.
   */
  useEffect(() => {
    if (!open || !projectId) return;
    const query = parentQuery.trim();
    if (query.length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/create-options?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
        .then((data) => setParents(data.parents ?? []))
        .catch(() => {
          /* A failed or superseded search leaves the previous results up;
             an empty picker would read as "nothing matches". */
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, projectId, parentQuery]);

  /**
   * Add the typed label to this project and select it.
   *
   * A name that already exists — in any case — comes back as the existing
   * label rather than a second one, so this both creates and picks. The chip
   * list is updated from the response instead of being refetched, which keeps
   * a half-filled form intact.
   */
  /**
   * Add a label to this project and select it.
   *
   * The name is trimmed and matched without regard to case before anything is
   * created — first against what is already loaded, then, by `createLabel`
   * itself, against the database. Two people typing "regression" at the same
   * moment therefore end up on the same label rather than on two, because the
   * decision is the server's and not the browser's.
   */
  async function addLabel(rawName: string) {
    const name = rawName.trim();
    if (!name || !projectId) return;

    const already = labels.find(
      (label) => label.name.toLowerCase() === name.toLowerCase(),
    );
    if (already) {
      setLabelIds((prev) =>
        prev.includes(already.id) ? prev : [...prev, already.id],
      );
      return;
    }

    setAddingLabel(true);
    const result = await createLabel({
      projectId,
      name,
      color: labelColourFor(name),
    });
    setAddingLabel(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    const label = result.data;
    setLabels((prev) =>
      prev.some((existing) => existing.id === label.id)
        ? prev
        : [...prev, label].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setLabelIds((prev) => (prev.includes(label.id) ? prev : [...prev, label.id]));
  }

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
      description: form.description,
      status: form.status,
      priority: form.priority,
      assigneeId: form.assigneeId,
      labelIds,
      dueDate: form.dueDate,
      parentId: form.parentId,
      severity: form.severity === "" ? null : form.severity,
    });

    if (!result.ok) {
      setSubmitting(false);
      setFormError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
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
                onClick={() => {
                  setType(option);
                  /* Carry the new type's default across, unless a severity was
                     chosen by hand — switching type should not discard that. */
                  setForm((prev) =>
                    prev.severity === defaultSeverityFor(type)
                      ? { ...prev, severity: defaultSeverityFor(option) }
                      : prev,
                  );
                }}
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
              {/*
               * Opened from inside a project, the project is not a question —
               * it is context, shown so it is unmistakable and locked so an
               * issue cannot land in the wrong one by a stray click. Opened
               * from a global surface, where no project is implied, the choice
               * is still the person's to make.
               *
               * The value still posts with the form, and the server authorizes
               * the project either way, so locking the control is a courtesy
               * rather than the boundary.
               */}
              <select
                id="create-project"
                className="prio-select"
                value={projectId}
                disabled={
                  lockedProject || (loadingOptions && projects.length === 0)
                }
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setLabelIds([]);
                  set("assigneeId", "");
                  set("parentId", "");
                }}
                required
                aria-invalid={invalid("projectId")}
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

            <FieldRow label="Summary" htmlFor="create-title" required>
              <input
                id="create-title"
                className="prio-input"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Short, specific summary of the work"
                required
                maxLength={200}
                aria-invalid={invalid("title")}
              />
              <FieldError errors={errors} field="title" />
            </FieldRow>

            {/*
             * One description, for every type.
             *
             * This is the field that replaced the per-type prompt lists. A bug
             * writes its reproduction steps and expected behaviour in here; a
             * story writes its acceptance criteria in here; the placeholder
             * says so. It is the `description` column the schema always had
             * and that search has always read — the form simply stopped
             * offering it at some point, which is why a bug had nowhere to put
             * its detail except a comment.
             */}
            <FieldRow label="Description" htmlFor="create-description">
              <textarea
                id="create-description"
                className="prio-textarea"
                rows={7}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder={DESCRIPTION_PLACEHOLDER[type]}
                maxLength={20000}
                aria-invalid={invalid("description")}
              />
              <FieldError errors={errors} field="description" />
            </FieldRow>

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
              {/*
               * Offered only when the signed-in person is actually a member of
               * this project — the same list the select is built from. Someone
               * who could not be chosen from the dropdown cannot be assigned by
               * this shortcut either, and the server checks again regardless.
               */}
              {viewerId && members.some((m) => m.id === viewerId) ? (
                <button
                  type="button"
                  className="prio-assignself"
                  onClick={() => set("assigneeId", viewerId)}
                  disabled={form.assigneeId === viewerId}
                >
                  {form.assigneeId === viewerId ? "Assigned to you" : "Assign to me"}
                </button>
              ) : null}
              <FieldError errors={errors} field="assigneeId" />
            </FieldRow>

            {projectId ? (
              <FieldRow label="Labels" labelledById="create-labels-label">
                {/*
                 * Selected labels only.
                 *
                 * Every label the project owns used to be rendered as a chip
                 * to toggle, which put a wall of vocabulary in front of a
                 * form whose job is to file one issue. What is on an issue is
                 * a short list; what a project could use is a search.
                 */}
                {labelIds.length > 0 ? (
                  <div
                    className="prio-chipset"
                    role="group"
                    aria-labelledby="create-labels-label"
                  >
                    {labelIds.map((id) => {
                      const label = labels.find((l) => l.id === id);
                      if (!label) return null;
                      return (
                        <button
                          key={label.id}
                          type="button"
                          className="prio-chipset__chip"
                          data-selected
                          aria-label={`Remove ${label.name}`}
                          onClick={() =>
                            setLabelIds((prev) =>
                              prev.filter((x) => x !== label.id),
                            )
                          }
                        >
                          <span
                            className="prio-label-chip__swatch"
                            style={{ background: label.color }}
                            aria-hidden
                          />
                          {label.name}
                          <span aria-hidden>&times;</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <LabelPicker
                  labels={labels}
                  selectedIds={labelIds}
                  disabled={!projectId || addingLabel}
                  busy={addingLabel}
                  onSelect={(id) =>
                    setLabelIds((prev) =>
                      prev.includes(id) ? prev : [...prev, id],
                    )
                  }
                  onCreate={addLabel}
                />
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
              label="Attachments"
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
             * Severity, for every type.
             *
             * It used to appear only when the type picker said "Bug", which
             * made the form a different shape for a bug than for a task. It is
             * a standard field now, defaulting to "Not set" for everything
             * except a bug — so an issue created without touching it still
             * stores `null`, exactly as a non-bug always did.
             */}
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
                  : "Impact if this goes wrong. Priority is how soon it is worked on — the two are independent."}
              </span>
            </div>

            <div className="prio-field">
              <label className="prio-label" htmlFor="create-parent">
                Parent issue
              </label>
              {/*
               * A search box with a datalist rather than a plain select: the
               * server returns at most twenty candidates, so the browser never
               * holds a project's whole issue list, and typing narrows against
               * the database instead of against whatever happened to arrive.
               * `list` keeps it a native control — no bespoke popup to trap
               * focus or fight a screen reader.
               */}
              <input
                id="create-parent"
                className="prio-input"
                list="create-parent-options"
                value={parentQuery}
                placeholder="Search by key or title"
                disabled={!projectId}
                aria-invalid={invalid("parentId")}
                onChange={(event) => {
                  const text = event.target.value;
                  setParentQuery(text);
                  /* The datalist gives back the option's value, so an exact
                     hit selects; anything else clears, which is what makes
                     half-typed text mean "no parent" rather than the last
                     thing that matched. */
                  const hit = parents.find(
                    (parent) => `${parent.key} — ${parent.title}` === text,
                  );
                  set("parentId", hit ? hit.id : "");
                }}
              />
              <datalist id="create-parent-options">
                {parents.map((parent) => (
                  <option
                    key={parent.id}
                    value={`${parent.key} — ${parent.title}`}
                  />
                ))}
              </datalist>
              <FieldError errors={errors} field="parentId" />
              <span className="prio-hint">
                {form.parentId
                  ? "This issue will be filed under the selected parent."
                  : "Optional. Search an existing issue by key or title to file this one under it."}
              </span>
            </div>
          </aside>
        </div>
      </form>
    </Dialog>
  );
}
