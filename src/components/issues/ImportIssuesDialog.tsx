"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconDownload, IconWarning } from "@/components/ui/Icon";
import {
  TEMPLATE_FILENAME,
  templateColumns,
  templateRows,
} from "@/lib/importTemplate";
import { importWorkItems, type ImportProblem } from "@/server/issueImport";

/**
 * Bringing work items in from a spreadsheet.
 *
 * Deliberately plain: a file, a button, and — when the file is not right — a
 * list of what to correct. The interesting design is on the server, which
 * validates every row before it writes any of them, so this never has to
 * report a half-finished import.
 *
 * The errors are shown in full rather than summarised. "Import failed" sends
 * somebody back to a spreadsheet with nothing to look for; "Row 7: Unknown
 * priority" sends them to row 7.
 *
 * Download Template answers the question before it is asked: the columns the
 * parser matches on, spelled the way it spells them, in an empty sheet. See
 * `lib/importTemplate`, which is checked against the parser's own header list
 * so the offer and the requirement cannot drift.
 */
export function ImportIssuesDialog({
  project,
  onClose,
}: {
  /**
   * The project this import belongs to, on a surface that is one project's.
   *
   * Sent to the server, which re-resolves it inside what the signed-in person
   * may reach and then refuses any row naming a different project — so a
   * spreadsheet opened on the Engineering tab cannot quietly file work in
   * Website, whatever its "Project key" column says.
   */
  project?: { id: string; key: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ImportProblem[]>([]);

  /**
   * Writes the empty template and hands it to the browser.
   *
   * Entirely in the browser: `write-excel-file` — the library the export
   * already writes workbooks with — ships a browser build, and a sheet of
   * nine headers needs nothing from the server. So this asks the database
   * nothing, costs a request nothing, and works the same whether or not the
   * import it belongs to ever runs.
   *
   * Imported on demand rather than at the top of the file so the workbook
   * writer is fetched by the people who press the button, not by everyone who
   * opens a list with an Import button on it.
   */
  async function downloadTemplate() {
    setBuilding(true);
    try {
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      /* The browser build hands back the file rather than writing one, so the
         name is given to `toFile` — the node build's `fileName` option does
         not exist here. */
      await writeXlsxFile(templateRows(), {
        columns: templateColumns(),
        sheet: "Work items",
      }).toFile(TEMPLATE_FILENAME);
    } catch {
      /* Said rather than swallowed: a download that silently does nothing is
         indistinguishable from a button that is broken. */
      toast("That template could not be prepared.", "error");
    } finally {
      setBuilding(false);
    }
  }

  async function submit() {
    if (!file) return;

    setBusy(true);
    setError(null);
    setProblems([]);

    const body = new FormData();
    body.set("file", file);
    if (project) body.set("projectId", project.id);

    const result = await importWorkItems(body);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      setProblems(result.problems ?? []);
      return;
    }

    onClose();
    toast(
      `${result.created} work item${result.created === 1 ? "" : "s"} imported`,
    );
    /* The list is server-rendered, so the server has to draw it again. */
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Import work items"
      description={
        project
          ? `An .xlsx spreadsheet — the same shape Export produces. Everything imports into ${project.key}.`
          : "An .xlsx spreadsheet — the same shape Export produces."
      }
      footer={
        <>
          <span className="prio-dialog__footer-note">
            Nothing is created until every row is valid.
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="brand"
            onClick={() => void submit()}
            loading={busy}
            disabled={!file}
          >
            Import
          </Button>
        </>
      }
    >
      {error ? (
        <div style={{ marginBottom: "var(--prio-space-4)" }}>
          <Alert tone="danger" icon={<IconWarning />}>
            {error}
          </Alert>
        </div>
      ) : null}

      <div className="prio-field">
        <label className="prio-label" htmlFor="import-file">
          Spreadsheet
        </label>
        <input
          id="import-file"
          ref={inputRef}
          type="file"
          className="prio-input"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
            setProblems([]);
          }}
        />
        <span className="prio-hint">
          Needs a <strong>Title</strong> column
          {project ? (
            <>
              ; a <strong>Project key</strong> column is optional here and must
              say <strong>{project.key}</strong> where it is present
            </>
          ) : (
            <>
              {" "}and a <strong>Project key</strong> column
            </>
          )}
          . Type, Status, Priority, Assignee, Labels, Due date and Description
          are used when present.
        </span>

        {/* Directly under the sentence that describes the columns, because it
            is the same sentence made into a file. */}
        <div className="prio-importtemplate">
          <button
            type="button"
            className="prio-btn prio-btn--secondary prio-btn--sm"
            onClick={() => void downloadTemplate()}
            disabled={building}
          >
            <IconDownload size={13} />
            {building ? "Preparing…" : "Download Template"}
          </button>
        </div>
      </div>

      {problems.length > 0 ? (
        <div className="prio-field">
          <span className="prio-label">What to correct</span>
          <ul className="prio-importproblems">
            {problems.map((problem, index) => (
              <li key={`${problem.row}-${index}`}>
                <strong>Row {problem.row}</strong>
                {problem.column ? ` · ${problem.column}` : null} —{" "}
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  );
}
