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
 * The same two questions the issue clone asks, for the same reason: a copy
 * that silently dragged every relationship and every file along with it is not
 * a decision anyone made. Both start unticked.
 *
 * The clone is a separate project from the moment it exists — its own key, its
 * own issue numbering, its own files. Nothing here writes to the original.
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

  const [copyLinks, setCopyLinks] = useState(false);
  const [copyAttachments, setCopyAttachments] = useState(false);
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
        issue(s), {result.data.copiedLinks} link(s),{" "}
        {result.data.copiedAttachments} file(s)
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
      description={`A new project based on ${project.name}. Choose what comes with it.`}
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
          The project&rsquo;s files and its issues&rsquo; files, copied rather
          than shared — deleting the clone can never remove the original&rsquo;s.
        </span>
      </div>
    </Dialog>
  );
}
