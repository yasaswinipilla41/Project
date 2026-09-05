"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { createSprint, updateSprint } from "@/server/sprints";

/**
 * Create or edit a sprint: name, goal, and the dates it runs between.
 *
 * One dialog for both, because they ask for exactly the same four things and
 * a second form would be a second place for the validation to drift.
 *
 * The dates are plain `<input type="date">` values — `YYYY-MM-DD`, the same
 * shape the Create Issue dialog sends for a due date — and the server reads
 * them back at UTC midnight, so a day boundary cannot move a sprint. The
 * "start must not be after end" rule is checked here to say so early, and
 * again on the server, which is where it is actually enforced.
 *
 * The project is fixed by wherever the dialog was opened from, and is never a
 * free-text field: on the project's own Sprints page it is that project; from
 * the top bar's Create menu it is chosen from the projects the person can
 * already see. The server then checks they may manage whichever one arrives.
 */

export interface SprintDraft {
  id: string;
  name: string;
  goal: string | null;
  startDate: Date;
  endDate: Date;
}

/** `2026-09-07` — what a date input reads and writes, in UTC. */
function dateValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function SprintFormDialog({
  projects,
  projectId,
  sprint,
  onClose,
}: {
  /** Offered when the dialog is opened without a project in context. */
  projects?: { id: string; key: string; name: string }[];
  /** The project this sprint belongs to, when it is already known. */
  projectId?: string;
  /** Present when editing; absent when creating. */
  sprint?: SprintDraft;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const editing = sprint !== undefined;

  const [chosenProject, setChosenProject] = useState(
    projectId ?? projects?.[0]?.id ?? "",
  );
  const [name, setName] = useState(sprint?.name ?? "");
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [startDate, setStartDate] = useState(
    sprint ? dateValue(sprint.startDate) : "",
  );
  const [endDate, setEndDate] = useState(sprint ? dateValue(sprint.endDate) : "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const needsProject = projectId === undefined;

  async function save() {
    setError(null);
    setFieldErrors({});

    /* Said here so the person is told before a round trip; the server refuses
       the same thing regardless of what this does. */
    if (startDate && endDate && startDate > endDate) {
      setFieldErrors({ endDate: "The end date cannot be before the start date." });
      return;
    }

    setSaving(true);

    if (editing) {
      const result = await updateSprint({
        sprintId: sprint.id,
        name,
        goal,
        startDate,
        endDate,
      });
      setSaving(false);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      onClose();
      toast(
        <>
          Updated <strong>{name}</strong>
        </>,
      );
      router.refresh();
      return;
    }

    const result = await createSprint({
      projectId: needsProject ? chosenProject : projectId,
      name,
      goal,
      startDate,
      endDate,
    });
    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
      return;
    }

    onClose();
    toast(
      <>
        Created sprint <strong>{name}</strong>
      </>,
    );
    /* Lands on the project's Sprints page, which is where the next step —
       adding issues to it — actually happens. */
    router.push(`/projects/${result.data.projectKey.toLowerCase()}/sprints`);
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={() => (saving ? undefined : onClose())}
      busy={saving}
      title={editing ? "Edit sprint" : "New sprint"}
      description={
        editing
          ? "Change what this sprint is for and when it runs."
          : "A fixed period of work for one project. Add issues to it next, then start it."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => void save()} loading={saving}>
            {editing ? "Save" : "Create sprint"}
          </Button>
        </>
      }
    >
      <div>
        {error ? <Alert tone="danger">{error}</Alert> : null}

        {needsProject ? (
          <div className="prio-field">
            <label className="prio-label" htmlFor="sprint-project">
              Project
            </label>
            <select
              id="sprint-project"
              className="prio-select"
              value={chosenProject}
              onChange={(event) => setChosenProject(event.target.value)}
            >
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} ({project.key})
                </option>
              ))}
            </select>
            <p className="prio-hint">
              The sprint, and every issue in it, belongs to this project.
            </p>
          </div>
        ) : null}

        <div className="prio-field">
          <label className="prio-label" htmlFor="sprint-name">
            Sprint name
          </label>
          <input
            id="sprint-name"
            className="prio-input"
            value={name}
            maxLength={80}
            placeholder="Sprint 5"
            onChange={(event) => setName(event.target.value)}
          />
          {fieldErrors.name ? (
            <p className="prio-error">{fieldErrors.name}</p>
          ) : null}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="sprint-goal">
            Sprint goal
          </label>
          <textarea
            id="sprint-goal"
            className="prio-textarea"
            rows={2}
            value={goal}
            maxLength={500}
            placeholder="Complete notification module"
            onChange={(event) => setGoal(event.target.value)}
          />
          {fieldErrors.goal ? (
            <p className="prio-error">{fieldErrors.goal}</p>
          ) : null}
        </div>

        <div className="row g-3">
          <div className="col-12 col-sm-6">
            <div className="prio-field">
              <label className="prio-label" htmlFor="sprint-start">
                Start date
              </label>
              <input
                id="sprint-start"
                type="date"
                className="prio-input"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
              {fieldErrors.startDate ? (
                <p className="prio-error">{fieldErrors.startDate}</p>
              ) : null}
            </div>
          </div>
          <div className="col-12 col-sm-6">
            <div className="prio-field">
              <label className="prio-label" htmlFor="sprint-end">
                End date
              </label>
              <input
                id="sprint-end"
                type="date"
                className="prio-input"
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
              />
              {fieldErrors.endDate ? (
                <p className="prio-error">{fieldErrors.endDate}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
