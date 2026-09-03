"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import { duplicateProject } from "@/server/projects";

/**
 * Clone a project.
 *
 * Duplicating a project means duplicating the work in it, so the project's
 * configuration, its issues and their conversations always travel — there is
 * no question to ask about those, and a copy without them would not be a copy
 * anyone could work in.
 *
 * The two questions that remain are the same two the issue clone asks, and
 * they start ticked here rather than unticked: a duplicated *project* is
 * expected to be complete, where a duplicated single issue is usually the
 * start of a new one. Either can still be turned off, and turning one off
 * means exactly what it says.
 *
 * The clone is a separate project from the moment it exists — its own key, its
 * own issue numbering, its own comments, its own files. Nothing here writes to
 * the original.
 */
export function CloneProjectDialog({
  project,
  onClose,
}: {
  project: { id: string; name: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [copyLinks, setCopyLinks] = useState(true);
  const [copyAttachments, setCopyAttachments] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clone() {
    setCloning(true);
    setError(null);

    const result = await duplicateProject({
      projectId: project.id,
      copyLinks,
      copyAttachments,
    });

    if (!result.ok) {
      setCloning(false);
      setError(result.error);
      return;
    }

    setCloning(false);
    onClose();
    toast(
      <>
        Cloned as <strong>{result.data.key}</strong> — {result.data.copiedIssues}{" "}
        issue(s), {result.data.copiedComments} comment(s),{" "}
        {result.data.copiedLinks} link(s), {result.data.copiedAttachments}{" "}
        file(s)
      </>,
    );
    router.push(`/projects/${result.data.key.toLowerCase()}/board`);
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={() => (cloning ? undefined : onClose())}
      busy={cloning}
      title="Clone project"
      description={`A new, independent project based on ${project.name}. Its settings, issues and comments come with it; choose what else does.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={cloning}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => void clone()} loading={cloning}>
            {cloning ? "Cloning…" : "Clone"}
          </Button>
        </>
      }
    >
      {error ? (
        <div style={{ marginBottom: "var(--prio-space-5)" }}>
          <Alert tone="danger" icon={<IconWarning />}>
            {error}
          </Alert>
        </div>
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
          Parent/sub-issue hierarchy and related-issue links, re-pointed at the
          copies. Nothing in the clone links back into {project.name}.
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
          The project&rsquo;s files, its issues&rsquo; files and the ones on
          their comments, copied rather than shared — deleting the clone&rsquo;s
          can never remove the original&rsquo;s.
        </span>
      </div>
    </Dialog>
  );
}
