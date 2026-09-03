"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { IssueStatus, IssueType, Priority, Severity } from "@prisma/client";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { IssueTypeIcon } from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import { DESCRIPTION_PLACEHOLDER } from "@/lib/issueTypeForms";
import { cloneIssue, issueCloneDraft, type IssueCloneDraft } from "@/server/issues";
import type { FieldErrors } from "@/server/schemas";

/**
 * Clone an issue.
 *
 * Two steps, and the order of them is the requirement:
 *
 *   1. **Options** — copy the links? copy the attachments? Neither, either or
 *      both, and both start off.
 *   2. **An editable draft** — the source's content, prefilled and open for
 *      editing, with its ticket ID showing "Not assigned yet" because it has
 *      not got one.
 *
 * The draft is not a database row. Nothing is written between clicking Clone
 * and clicking Save: no issue, no key, no attachment, no link. That is what
 * makes cancelling free — there is nothing to clean up, because nothing was
 * created — and it is why the new ticket ID cannot appear early. `cloneIssue`
 * allocates the key inside the same transaction that creates the row, at Save
 * and not before.
 *
 * The fields offered here are the standard ones every type shares — summary,
 * description, type, priority, severity, assignee — because a clone of a Bug
 * and a clone of a Story are the same form, exactly as creating them is.
 */

interface Member {
  id: string;
  name: string;
}

export function CloneIssueDialog({
  issueId,
  issueKey,
  onClose,
}: {
  issueId: string;
  issueKey: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [draft, setDraft] = useState<IssueCloneDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [copyLinks, setCopyLinks] = useState(false);
  const [copyAttachments, setCopyAttachments] = useState(false);
  const [editing, setEditing] = useState(false);

  const [members, setMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  /* The editable copy of the source. Held apart from `draft` so "what the
     source said" and "what the person has typed" never get confused. */
  const [form, setForm] = useState({
    title: "",
    description: "",
    type: "TASK" as IssueType,
    status: "BACKLOG" as IssueStatus,
    priority: "MEDIUM" as Priority,
    severity: "" as Severity | "",
    assigneeId: "",
  });

  useEffect(() => {
    let live = true;

    void issueCloneDraft(issueId).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setDraft(result.data);
      setForm({
        title: result.data.title,
        description: result.data.description ?? "",
        type: result.data.type,
        status: result.data.status,
        priority: result.data.priority,
        severity: result.data.severity ?? "",
        assigneeId: result.data.assigneeId ?? "",
      });
    });

    return () => {
      live = false;
    };
  }, [issueId]);

  /* The assignee list belongs to the project the clone will land in, which is
     the source's project — the same list the create dialog uses. */
  useEffect(() => {
    if (!draft) return;
    const controller = new AbortController();

    fetch(`/api/create-options?projectId=${encodeURIComponent(draft.projectId)}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((data: { members?: Member[] }) => setMembers(data.members ?? []))
      .catch(() => {
        /* An empty list still lets the clone be saved unassigned. */
      });

    return () => controller.abort();
  }, [draft]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;

    setSaving(true);
    setFormError(null);
    setErrors({});

    const result = await cloneIssue({
      sourceIssueId: draft.sourceId,
      projectId: draft.projectId,
      copyLinks,
      copyAttachments,
      type: form.type,
      title: form.title,
      description: form.description,
      status: form.status,
      priority: form.priority,
      severity: form.severity === "" ? null : form.severity,
      assigneeId: form.assigneeId,
      labelIds: draft.labelIds,
    });

    if (!result.ok) {
      setSaving(false);
      setFormError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
    }

    setSaving(false);
    onClose();
    toast(
      <>
        Created <strong>{result.data.key}</strong> from {draft.sourceKey}
        {result.data.copiedLinks > 0 || result.data.copiedAttachments > 0
          ? ` — ${result.data.copiedLinks} link(s), ${result.data.copiedAttachments} file(s) copied`
          : null}
      </>,
    );
    router.push(`/issues/${result.data.key.toLowerCase()}`);
    router.refresh();
  }

  /* ------------------------------------------------------------ options */

  if (!editing) {
    return (
      /*
       * Keyed per stage, and this is load-bearing rather than tidiness.
       *
       * Both stages return a `Dialog` from the same position, so without a key
       * React reconciles them as one element and *reuses the DOM nodes* —
       * including the footer's primary button, which is "Clone" here and
       * "Save" over there. Reusing it meant the click that advanced the stage
       * synchronously rewrote that very button to `type="submit"` with the
       * draft form's id, and the browser then ran its default action against
       * the new attributes: the draft submitted itself the instant Clone was
       * pressed. The issue was created, a ticket ID was allocated, and nobody
       * ever saw the draft — precisely what §8 forbids.
       *
       * Distinct keys make them two dialogs, so no node is ever inherited.
       */
      <Dialog
        key="clone-options"
        open
        onClose={onClose}
        title="Clone issue"
        description={`A new issue based on ${issueKey}. Choose what comes with it.`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="brand"
              disabled={draft === null}
              onClick={() => setEditing(true)}
            >
              Clone
            </Button>
          </>
        }
      >
        {loadError ? (
          <Alert tone="danger" icon={<IconWarning />}>
            {loadError}
          </Alert>
        ) : null}

        <div className="prio-field">
          <label className="prio-checkbox">
            <input
              type="checkbox"
              checked={copyLinks}
              onChange={(event) => setCopyLinks(event.target.checked)}
            />
            Do you want to copy the links?
          </label>
          <span className="prio-hint">
            {draft
              ? `${draft.linkCount} related issue link${draft.linkCount === 1 ? "" : "s"}${
                  draft.parentKey ? `, and the parent ${draft.parentKey}` : ""
                }.`
              : "Loading…"}
          </span>
        </div>

        <div className="prio-field">
          <label className="prio-checkbox">
            <input
              type="checkbox"
              checked={copyAttachments}
              onChange={(event) => setCopyAttachments(event.target.checked)}
            />
            Do you want to copy the attachments?
          </label>
          <span className="prio-hint">
            {draft
              ? `${draft.attachmentCount} file${draft.attachmentCount === 1 ? "" : "s"} on the issue itself.`
              : "Loading…"}
          </span>
        </div>
      </Dialog>
    );
  }

  /* -------------------------------------------------------- editable draft */

  return (
    <Dialog
      key="clone-draft"
      open
      onClose={onClose}
      size="lg"
      busy={saving}
      title="Clone issue"
      description={`An unsaved copy of ${issueKey}. It becomes a real issue, with a ticket ID, when you save.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="brand"
            type="submit"
            form="prio-clone-form"
            loading={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="prio-clone-form" onSubmit={save} noValidate>
        {formError ? (
          <div style={{ marginBottom: "var(--prio-space-5)" }}>
            <Alert tone="danger" icon={<IconWarning />}>
              {formError}
            </Alert>
          </div>
        ) : null}

        {/*
         * The draft says outright that it has no ticket ID. An invented
         * placeholder — "INT-NEW", "DRAFT-1" — would be worse than nothing:
         * somebody would quote it.
         */}
        <div className="prio-clonedraft">
          <span className="prio-clonedraft__label">Ticket ID</span>
          <span className="prio-clonedraft__value">Not assigned yet</span>
          <span className="prio-clonedraft__note">
            Cloned from {issueKey} in {draft?.projectName}. Links{" "}
            {copyLinks ? "will" : "will not"} be copied; attachments{" "}
            {copyAttachments ? "will" : "will not"}.
          </span>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-title">
            Summary
          </label>
          <input
            id="clone-title"
            className="prio-input"
            value={form.title}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, title: event.target.value }))
            }
            maxLength={200}
            required
            aria-invalid={errors.title ? true : undefined}
          />
          {errors.title ? (
            <span className="prio-error" role="alert">
              {errors.title}
            </span>
          ) : null}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-description">
            Description
          </label>
          <textarea
            id="clone-description"
            className="prio-textarea"
            rows={7}
            value={form.description}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, description: event.target.value }))
            }
            placeholder={DESCRIPTION_PLACEHOLDER[form.type]}
            maxLength={20000}
          />
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-type">
            Issue type
          </label>
          <select
            id="clone-type"
            className="prio-select"
            value={form.type}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                type: event.target.value as IssueType,
              }))
            }
          >
            {ISSUE_TYPES.map((option) => (
              <option key={option} value={option}>
                {ISSUE_TYPE_LABEL[option]}
              </option>
            ))}
          </select>
          <span className="prio-hint">
            <IssueTypeIcon type={form.type} size={13} /> The type is the only
            thing that differs between a story, a task and a bug.
          </span>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-status">
            Status
          </label>
          <select
            id="clone-status"
            className="prio-select"
            value={form.status}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                status: event.target.value as IssueStatus,
              }))
            }
          >
            {ISSUE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {STATUS_LABEL[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-priority">
            Priority
          </label>
          <select
            id="clone-priority"
            className="prio-select"
            value={form.priority}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                priority: event.target.value as Priority,
              }))
            }
          >
            {PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {PRIORITY_LABEL[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-severity">
            Severity
          </label>
          <select
            id="clone-severity"
            className="prio-select"
            value={form.severity}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                severity: event.target.value as Severity | "",
              }))
            }
          >
            <option value="">Not set</option>
            {SEVERITIES.map((option) => (
              <option key={option} value={option}>
                {SEVERITY_LABEL[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="clone-assignee">
            Assignee
          </label>
          <select
            id="clone-assignee"
            className="prio-select"
            value={form.assigneeId}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, assigneeId: event.target.value }))
            }
            aria-invalid={errors.assigneeId ? true : undefined}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          {errors.assigneeId ? (
            <span className="prio-error" role="alert">
              {errors.assigneeId}
            </span>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
