import Link from "next/link";

/**
 * Choosing which project's work table to look at.
 *
 * Plain links rather than a control that needs JavaScript: the choice already
 * lives in the URL so the table can be sorted and shared, and this keeps the
 * two consistent. Only projects the viewer can already open are listed — team
 * membership decides whether this picker exists, never what is in it.
 */
export function ProjectWorkPicker({
  projects,
  selectedId,
  basePath,
}: {
  projects: { id: string; key: string; name: string }[];
  selectedId: string | null;
  basePath: string;
}) {
  if (projects.length === 0) {
    return (
      <p className="prio-text-muted">
        You are not on any project yet, so there is no work to show.
      </p>
    );
  }

  return (
    <div className="prio-workpicker" role="group" aria-label="Choose a project">
      {projects.map((project) => (
        <Link
          key={project.id}
          href={`${basePath}?project=${project.id}`}
          className="prio-workpicker__option"
          data-active={project.id === selectedId || undefined}
          aria-current={project.id === selectedId ? "true" : undefined}
        >
          <span className="prio-workpicker__badge" aria-hidden>
            {project.key.slice(0, 2)}
          </span>
          <span className="prio-truncate">{project.name}</span>
        </Link>
      ))}
    </div>
  );
}
