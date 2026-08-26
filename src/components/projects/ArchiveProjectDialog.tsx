"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import { updateProject } from "@/server/projects";

/**
 * Archiving is the reversible sibling of deleting a board — no typed
 * confirmation, since nothing is destroyed, but still a confirmation dialog
 * because it immediately hides the project from everyone who is not an
 * administrator. Restoring it is a checkbox on the project settings page
 * (`ProjectSettings`), which is what the dialog copy points back to.
 */
export function ArchiveProjectDialog({
  project,
  onClose,
}: {
  project: { id: string; key: string; name: string; description: string | null };
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [archiving, setArchiving] = useState(false);

  async function handleConfirm() {
    setArchiving(true);

    const result = await updateProject({
      projectId: project.id,
      name: project.name,
      description: project.description,
      isArchived: true,
    });

    if (!result.ok) {
      setArchiving(false);
      toast(result.error, "error");
      return;
    }

    onClose();
    toast(`Archived ${project.name}`);
    // The board this dialog was opened from is no longer reachable once
    // archived — `projectScope` excludes it for everyone but an admin
    // visiting it directly, so send the person somewhere that still exists.
    router.push("/projects");
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={archiving}
      title="Archive this board?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={archiving}>
            Cancel
          </Button>
          <Button variant="primary" loading={archiving} onClick={handleConfirm}>
            {archiving ? "Archiving…" : "Archive board"}
          </Button>
        </>
      }
    >
      <Alert tone="warning" icon={<IconWarning />}>
        Archiving <strong>{project.name}</strong> hides it from the project
        list, board switcher and sidebar for everyone except an administrator.
        Nothing is deleted — restore it any time from Project Settings.
      </Alert>
    </Dialog>
  );
}
