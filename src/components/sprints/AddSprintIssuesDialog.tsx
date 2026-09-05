"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Avatar, Button, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox } from "@/components/ui/Icon";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { addIssuesToSprint } from "@/server/sprints";
import type { SprintIssueSummary } from "@/server/queries/sprints";

/**
 * Choose work from the project's backlog and put it in the sprint.
 *
 * The list is the backlog handed down by the page, which is built by
 * `loadSprintBacklog` with `projectId` in its `where` — so this picker can
 * only ever show this project's own open, unsprinted work. There is no project
 * control here and no way to widen the list: an issue from another project
 * cannot be shown, cannot be searched for, and cannot be selected. The server
 * re-applies the same scope when the selection arrives, so a hand-made request
 * gets no further than this dialog would have.
 */
export function AddSprintIssuesDialog({
  sprintId,
  sprintName,
  projectKey,
  backlog,
  onClose,
}: {
  sprintId: string;
  sprintName: string;
  projectKey: string;
  backlog: SprintIssueSummary[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return backlog;
    return backlog.filter(
      (issue) =>
        issue.key.toLowerCase().includes(needle) ||
        issue.title.toLowerCase().includes(needle),
    );
  }, [backlog, query]);

  function toggle(id: string) {
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    if (picked.size === 0) return;

    setSaving(true);
    setError(null);

    const result = await addIssuesToSprint({
      sprintId,
      issueIds: [...picked],
    });

    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    onClose();
    toast(
      <>
        Added {result.data.added}{" "}
        {result.data.added === 1 ? "issue" : "issues"} to{" "}
        <strong>{sprintName}</strong>
      </>,
    );
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={() => (saving ? undefined : onClose())}
      busy={saving}
      size="lg"
      title={`Add issues to ${sprintName}`}
      description={`Open work in ${projectKey} that is not already in a sprint. Only this project's issues can be added.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="brand"
            onClick={() => void add()}
            loading={saving}
            disabled={picked.size === 0}
          >
            {picked.size === 0
              ? "Add to sprint"
              : `Add ${picked.size} to sprint`}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {backlog.length === 0 ? (
        <EmptyState
          icon={<IconEmptyBox />}
          title="The backlog is empty"
          body={`Every open issue in ${projectKey} is already in a sprint. Create an issue, or take one back out of another sprint.`}
        />
      ) : (
        <>
          <div className="prio-field">
            <label className="prio-label" htmlFor="sprint-backlog-search">
              Search the backlog
            </label>
            <input
              id="sprint-backlog-search"
              className="prio-input"
              value={query}
              placeholder="Key or title"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {matching.length === 0 ? (
            <p className="prio-text-muted">Nothing in the backlog matches that.</p>
          ) : (
            <ul className="prio-sprintpicker">
              {matching.map((issue) => (
                <li key={issue.id}>
                  <label className="prio-sprintpicker__row">
                    <input
                      type="checkbox"
                      checked={picked.has(issue.id)}
                      onChange={() => toggle(issue.id)}
                    />
                    <IssueTypeIcon type={issue.type} size={15} />
                    <IssueKey issueKey={issue.key} />
                    <span className="prio-sprintpicker__title prio-truncate">
                      {issue.title}
                    </span>
                    <StatusPill status={issue.status} />
                    {issue.assignee ? (
                      <Avatar
                        name={issue.assignee.name}
                        image={issue.assignee.image}
                        size="xs"
                      />
                    ) : (
                      <Avatar name={null} size="xs" empty />
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}
