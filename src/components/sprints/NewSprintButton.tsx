"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/Icon";
import { SprintFormDialog } from "./SprintFormDialog";

/**
 * "New sprint" on the project's Sprints page.
 *
 * The project is fixed by the page it sits on, so the dialog opens with no
 * project question to answer — the sprint belongs to the project being looked
 * at, and could not belong to another.
 */
export function NewSprintButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <IconPlus size={14} />
        New sprint
      </Button>

      {/* Mounted only while open, so every open starts from an empty form. */}
      {open ? (
        <SprintFormDialog projectId={projectId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
