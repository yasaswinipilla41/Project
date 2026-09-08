"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { IconBug } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { PRIORITIES, PRIORITY_LABEL } from "@/lib/domain";
import { reportBug } from "@/server/issues";
import type { FieldErrors } from "@/server/schemas";
import type { Priority } from "@prisma/client";

/**
 * "Report a problem" — a tester filing a bug against the work under test.
 *
 * Asks for the four things only the tester knows, and nothing else: the
 * project, the person who should fix it, the reporter and the link back to
 * this issue are all derived server-side from the issue being tested.
 *
 * Offered to anyone who can see the issue *except* its assignee, matching the
 * verdict buttons — you report a problem with somebody else's work, not your
 * own. `reportBug` re-derives access on the server regardless.
 */
export function ReportBugDialog({
  issueId,
  issueKey,
  assigneeId,
  currentUserId,
}: {
  issueId: string;
  issueKey: string;
  assigneeId: string | null;
  currentUserId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const [title, setTitle] = useState("");
  const [affectedModule, setAffectedModule] = useState("");
  const [priority, setPriority] = useState<Priority>("MEDIUM");

  if (assigneeId === currentUserId) return null;

  function reset() {
    setTitle("");
    setAffectedModule("");
    setPriority("MEDIUM");
    setErrors({});
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrors({});

    const result = await reportBug({
      issueId,
      title,
      affectedModule,
      priority,
    });

    setSaving(false);

    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      toast(result.error, "error");
      return;
    }

    toast(`Reported ${result.data.key}`);
    setOpen(false);
    reset();
    // Straight to the new bug — attachments and discussion happen there.
    router.push(`/issues/${result.data.key.toLowerCase()}`);
    router.refresh();
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        title={`Report a problem found while testing ${issueKey}`}
      >
        <IconBug size={13} />
        Report a problem
      </Button>

      {open ? (
        <Dialog
          open
          onClose={() => setOpen(false)}
          busy={saving}
          size="lg"
          title="Report a problem"
          description={`Filed against ${issueKey}, and assigned back to whoever owns that work.`}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                variant="brand"
                type="submit"
                form="prio-report-bug"
                loading={saving}
              >
                Report problem
              </Button>
            </>
          }
        >
          <form id="prio-report-bug" onSubmit={submit} noValidate>
            <Field
              id="bug-title"
              label="Summary"
              required
              error={errors.title}
              hint="One line a developer can recognise in a list."
            >
              <input
                id="bug-title"
                className="prio-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
                autoFocus
              />
            </Field>

            <Field
              id="bug-where"
              label="Where you found it"
              required
              error={errors.affectedModule}
              hint="The screen or area — for example Login page, Issue details."
            >
              <input
                id="bug-where"
                className="prio-input"
                value={affectedModule}
                onChange={(e) => setAffectedModule(e.target.value)}
                maxLength={120}
                required
              />
            </Field>

            <div className="row g-3">
              {/* Priority alone in the row now that severity is gone; it keeps
                  the half-width control the form was laid out around rather
                  than stretching one select across the dialog. */}
              <div className="col-12 col-md-6">
                <Field id="bug-priority" label="Priority">
                  <select
                    id="bug-priority"
                    className="prio-select"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as Priority)}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>

            <p className="prio-hint">
              Screenshots, recordings and logs go on the bug itself — you land
              on it as soon as it is reported.
            </p>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

function Field({
  id,
  label,
  required,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="prio-field">
      <label className="prio-label" htmlFor={id}>
        {label}
        {required ? <span className="prio-label__required">*</span> : null}
      </label>
      {children}
      {error ? (
        <span className="prio-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="prio-hint">{hint}</span>
      ) : null}
    </div>
  );
}
