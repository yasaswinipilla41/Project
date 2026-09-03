"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import {
  IconArchive,
  IconCopy,
  IconEdit,
  IconMore,
  IconSettings,
  IconStar,
  IconTrash,
} from "@/components/ui/Icon";
import {
  DeleteProjectDialog,
  EditProjectDialog,
} from "@/components/projects/ProjectActions";
import { ArchiveProjectDialog } from "@/components/projects/ArchiveProjectDialog";
import { CloneProjectDialog } from "@/components/projects/CloneProjectDialog";
import { toggleProjectFavorite } from "@/server/projects";

/**
 * The Star and "..." controls in the Flow Board's page header.
 *
 * Board-level actions map directly onto project actions — a Flow Board *is*
 * one project's board, not a separate entity — so this reuses the same
 * `updateProject` / `deleteProject` server actions and dialogs that
 * `ProjectActions` already built for the project settings page, rather than
 * re-implementing rename/delete a second time.
 */

export interface BoardHeaderActionsProps {
  project: {
    id: string;
    key: string;
    name: string;
    description: string | null;
  };
  issueCount: number;
  initialFavorite: boolean;
  /** Admin, or the project's creator — may rename, archive or delete it. */
  canManage: boolean;
  /** Board Settings and Duplicate are administrator actions, like creating a project. */
  isAdmin: boolean;
}

export function BoardHeaderActions({
  project,
  issueCount,
  initialFavorite,
  canManage,
  isAdmin,
}: BoardHeaderActionsProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [isFavorite, setIsFavorite] = useState(initialFavorite);
  const [favoritePending, setFavoritePending] = useState(false);
  const [cloning, setCloning] = useState(false);

  /*
   * `useState(initialFavorite)` only reads this argument on the very first
   * mount — a `router.refresh()` triggered elsewhere (the sidebar's own
   * Favorite toggle re-renders this same server tree with fresh data) hands
   * this component a new `initialFavorite` prop on a later render, and
   * without reconciling it here this component would keep showing its own
   * stale local copy forever. This is React's documented "adjusting state
   * when a prop changes" pattern — setting state during render, guarded by a
   * comparison against the last prop seen, rather than in an effect — so the
   * database stays the single source of truth without an extra render pass.
   */
  const [lastInitialFavorite, setLastInitialFavorite] = useState(initialFavorite);
  if (initialFavorite !== lastInitialFavorite) {
    setLastInitialFavorite(initialFavorite);
    setIsFavorite(initialFavorite);
  }

  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleToggleFavorite() {
    const next = !isFavorite;
    setIsFavorite(next);
    setFavoritePending(true);

    const result = await toggleProjectFavorite({ projectId: project.id });

    setFavoritePending(false);

    if (!result.ok) {
      setIsFavorite(!next);
      toast(result.error, "error");
      return;
    }

    // The board list elsewhere (sidebar, /projects) reads favourite state too.
    router.refresh();
  }

  const showMenu = canManage || isAdmin;

  return (
    <>
      <Button
        variant="secondary"
        iconOnly
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={isFavorite}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        disabled={favoritePending}
        onClick={handleToggleFavorite}
        data-favorite={isFavorite || undefined}
        className="prio-board__favorite"
      >
        <IconStar fill={isFavorite ? "currentColor" : "none"} />
      </Button>

      {showMenu ? (
        <Menu
          align="end"
          width={210}
          label="More board actions"
          trigger={(props) => (
            <button
              type="button"
              className="prio-btn prio-btn--secondary prio-btn--icon"
              aria-label="More board actions"
              title="More board actions"
              {...props}
            >
              <IconMore />
            </button>
          )}
        >
          {canManage ? (
            <MenuItem icon={<IconEdit />} onSelect={() => setEditing(true)}>
              Rename board
            </MenuItem>
          ) : null}

          {isAdmin ? (
            <MenuItem
              icon={<IconSettings />}
              href={`/projects/${project.key.toLowerCase()}/settings`}
            >
              Board settings
            </MenuItem>
          ) : null}

          {isAdmin ? (
            <MenuItem icon={<IconCopy />} onSelect={() => setCloning(true)}>
              Clone project
            </MenuItem>
          ) : null}

          {canManage ? (
            <>
              <MenuSeparator />
              <MenuItem icon={<IconArchive />} onSelect={() => setArchiving(true)}>
                Archive board
              </MenuItem>
              <MenuItem
                danger
                icon={<IconTrash />}
                onSelect={() => setDeleting(true)}
              >
                Delete board
              </MenuItem>
            </>
          ) : null}
        </Menu>
      ) : null}

      {cloning ? (
        <CloneProjectDialog project={project} onClose={() => setCloning(false)} />
      ) : null}

      {editing ? (
        <EditProjectDialog project={project} onClose={() => setEditing(false)} />
      ) : null}

      {archiving ? (
        <ArchiveProjectDialog
          project={project}
          onClose={() => setArchiving(false)}
        />
      ) : null}

      {deleting ? (
        <DeleteProjectDialog
          project={project}
          issueCount={issueCount}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  );
}
