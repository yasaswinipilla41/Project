"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  IconCheck,
  IconClose,
  IconDownload,
  IconSpreadsheetDown,
  IconWarning,
} from "@/components/ui/Icon";
import { TEMPLATE_FILENAME } from "@/lib/importTemplate";
import {
  importWorkItems,
  validateWorkItemsImport,
  type ImportValidation,
} from "@/server/issueImport";

/** A file that got as far as being read: its rows, counted and judged. */
type Checked = Extract<ImportValidation, { ok: true }>;

/**
 * Bringing work items in from a spreadsheet.
 *
 * A file, a verdict, and a button that only lights when the verdict is good.
 * The moment a file is chosen it is sent to the server to be *checked* — every
 * row read and judged, nothing written — and what comes back is shown before
 * anybody is offered Import: how many rows there are, how many would go in,
 * and for each that would not, which row and why. Import stays disabled until
 * every row is valid, and even then the server checks the file again before it
 * writes, because this screen's opinion is not what protects the database.
 *
 * The errors are shown in full rather than summarised. "Import failed" sends
 * somebody back to a spreadsheet with nothing to look for; "Row 7: Parent
 * Issue does not exist" sends them to row 7.
 *
 * Download Template answers the question before it is asked: the columns the
 * parser matches on, spelled the way it spells them, in an empty sheet. See
 * `lib/importTemplate`, the single list both sides read.
 */
export function ImportIssuesDialog({
  project,
  projectChoices,
  onClose,
}: {
  /**
   * The project this import belongs to, on a surface that is one project's.
   *
   * Sent to the server, which re-resolves it inside what the signed-in person
   * may reach. It is the only thing that says where the rows go: the
   * spreadsheet has no project column, and nothing in it could override this.
   */
  project?: { id: string; key: string };
  /**
   * Where the choice is the person's, on a surface that belongs to no project.
   *
   * The spreadsheet has no project column, so an import opened from the
   * all-projects list has to be told where to put the rows, and the dialog
   * asks — once, here, never in the file. Ignored when `project` is set,
   * because there the route has already answered.
   */
  projectChoices?: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  /* Where the rows go when the surface does not say. */
  const [chosenProject, setChosenProject] = useState("");
  /* The file has been sent to be read and judged, and no answer yet. */
  const [checking, setChecking] = useState(false);
  /* The file is being written. */
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  /* Something wrong with the file as a whole, as opposed to with its rows. */
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [dragging, setDragging] = useState(false);

  /* The project the rows are for: the surface's own, or the one picked. */
  const projectId = project?.id ?? chosenProject;

  /* Stamps each check, so an answer that arrives after the file or the project
     has been changed again is thrown away rather than shown against the wrong
     file. */
  const checkRun = useRef(0);

  /**
   * Takes a file from whichever way it arrived — picker, drop or paste.
   *
   * One path for all three, so a dropped file is the same file the picker
   * would have produced and the server sees no difference between them.
   *
   * The extension is checked here only so that dropping a PDF says so at once
   * rather than after a round trip; the same rule is enforced on the server,
   * which is where it counts.
   */
  const accept = useCallback(
    (chosen: File | null | undefined) => {
      if (!chosen || busy) return;

      /* A new file starts from nothing: the last one's verdict is not this
         one's. */
      checkRun.current += 1;
      setChecked(null);
      setChecking(false);

      if (!/\.xlsx$/i.test(chosen.name)) {
        setFile(null);
        setError(
          "Import expects an .xlsx spreadsheet — the format Export produces.",
        );
        return;
      }

      setError(null);
      setFile(chosen);
    },
    [busy],
  );

  /**
   * Sends the chosen file to be checked, whenever the file or the project
   * changes.
   *
   * Nothing is created by this. It is a question — would this import work? —
   * and its answer is what decides whether the button lights.
   */
  useEffect(() => {
    if (!file || !projectId) return;

    const run = (checkRun.current += 1);
    const body = new FormData();
    body.set("file", file);
    body.set("projectId", projectId);

    /* From a microtask, so the effect does not set state in its own body. */
    queueMicrotask(() => {
      if (run === checkRun.current) setChecking(true);
    });

    validateWorkItemsImport(body)
      .then((result) => {
        if (run !== checkRun.current) return;
        setChecking(false);
        if (result.ok) {
          setError(null);
          setChecked(result);
        } else {
          setChecked(null);
          setError(result.error);
        }
      })
      .catch(() => {
        if (run !== checkRun.current) return;
        setChecking(false);
        setChecked(null);
        setError("That file could not be checked. Please try again.");
      });
  }, [file, projectId]);

  /*
   * Pasting a file, where the browser offers one.
   *
   * The drop zone advertises paste, so it has to work from the moment the
   * dialog opens rather than only once something has been focused — hence the
   * listener on the document, exactly as the attachment field does it. A paste
   * carrying no file at all is somebody copying text, and is left alone.
   */
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const pasted = event.clipboardData?.files?.[0];
      if (!pasted) return;
      event.preventDefault();
      accept(pasted);
    }

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [accept]);

  /*
   * A file dropped next to the zone rather than on it does nothing.
   *
   * Without this the browser navigates away to the dropped file, taking the
   * half-finished import with it — the same guard the issue attachments drop
   * zone already installs, and for the same reason.
   */
  useEffect(() => {
    const swallow = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  /**
   * Fetches the empty template and hands it to the browser.
   *
   * The file is built on the server (`api/issues/import-template`) because it
   * carries drop-downs, which the browser-side writer this used to use cannot
   * express. It is a plain download — nothing about the database is asked —
   * and it is fetched and saved from here rather than linked to, so that a
   * failure can say so instead of navigating the person to an error page.
   */
  async function downloadTemplate() {
    setBuilding(true);
    try {
      const response = await fetch("/api/issues/import-template");
      if (!response.ok) throw new Error(String(response.status));

      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = TEMPLATE_FILENAME;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* Said rather than swallowed: a download that silently does nothing is
         indistinguishable from a button that is broken. */
      toast("That template could not be prepared.", "error");
    } finally {
      setBuilding(false);
    }
  }

  async function submit() {
    if (!file || !projectId || !checked || checked.invalidCount > 0) return;

    setBusy(true);
    setError(null);

    const body = new FormData();
    body.set("file", file);
    body.set("projectId", projectId);

    let result;
    try {
      result = await importWorkItems(body);
    } catch {
      setBusy(false);
      setError("Nothing was imported. Please try again.");
      return;
    }
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      /* The server judged the file again and found rows to fix — the data
         changed since it was checked. Show them. */
      setChecked(result.validation ?? null);
      return;
    }

    onClose();
    toast(
      `${result.created} work item${result.created === 1 ? "" : "s"} imported successfully.`,
    );
    /* The list is server-rendered, so the server has to draw it again. */
    router.refresh();
  }

  /*
   * Where the import is, in one sentence.
   *
   * The same sentence is what explains the button, so the two cannot
   * disagree: disabled while a file is being checked, disabled with rows to
   * fix, enabled only on "Ready to import".
   */
  const invalidCount = checked?.invalidCount ?? 0;
  const canImport =
    Boolean(file) && Boolean(checked) && invalidCount === 0 && !checking && !busy;

  let status: string | null = null;
  if (file) {
    if (busy) status = "Importing…";
    else if (checking) status = "Checking your work items…";
    else if (checked && invalidCount === 0)
      status = `All ${checked.total} row${checked.total === 1 ? " is" : "s are"} valid. Ready to import.`;
    else if (checked)
      status = `${invalidCount} row${invalidCount === 1 ? " needs" : "s need"} attention before importing.`;
    else if (!projectId) status = "Ready to validate. Choose a project first.";
    else if (!error) status = "Ready to validate.";
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Import work items"
      description={
        project
          ? `An .xlsx spreadsheet based on the template. Everything imports into ${project.key}.`
          : "An .xlsx spreadsheet based on the template."
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
            disabled={!canImport}
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

      {/* Only where nothing has said which project this is. */}
      {!project && projectChoices ? (
        <div className="prio-field">
          <label className="prio-label" htmlFor="import-project">
            Project
          </label>
          <select
            id="import-project"
            className="prio-select"
            value={chosenProject}
            onChange={(event) => setChosenProject(event.target.value)}
            disabled={busy}
          >
            <option value="">Choose a project…</option>
            {projectChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="prio-field">
        {/*
          * The file input itself, kept and hidden.
          *
          * It is still the thing that opens the picker and still the thing
          * that holds the chosen file — the zone below only clicks it. A
          * custom control that reimplemented any of that would be a second
          * way in for the same file, and the one the browser gives us already
          * handles the parts nobody should rewrite.
          */}
        <input
          id="import-file"
          ref={inputRef}
          type="file"
          className="prio-visually-hidden"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            accept(e.target.files?.[0] ?? null);
            /* Cleared so choosing the same file twice in a row still fires a
               change — after a failed import that is the common case. */
            e.target.value = "";
          }}
        />

        {/*
          * One target for all three ways in: click, drop and paste.
          *
          * A button rather than a bare div, because it does what a button
          * does, and a reader who cannot see the dashed rectangle still gets
          * told it can be pressed.
          */}
        <button
          type="button"
          className="prio-importdrop"
          data-dragging={dragging || undefined}
          data-chosen={file ? true : undefined}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={(event) => {
            /* Moving onto a child is not leaving. */
            if (event.currentTarget.contains(event.relatedTarget as Node | null))
              return;
            setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            accept(event.dataTransfer.files?.[0]);
          }}
        >
          <IconSpreadsheetDown size={36} className="prio-importdrop__icon" />
          <span className="prio-importdrop__text">
            Drag &amp; drop or paste Excel template file here
          </span>
          {file ? (
            <span className="prio-importdrop__file">{file.name}</span>
          ) : null}
        </button>

        <span className="prio-hint">
          Needs a <strong>Summary</strong> column. Description, Issue Type,
          Status, Priority, Assignee, Severity and Parent Issue
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

      {/* The verdict: what is happening, then what was found. */}
      {status ? (
        <p
          className="prio-importstatus"
          data-state={
            checked ? (invalidCount === 0 ? "valid" : "invalid") : undefined
          }
          role="status"
          aria-live="polite"
        >
          {status}
        </p>
      ) : null}

      {checked ? (
        <div className="prio-field">
          <div className="prio-importsummary">
            <span className="prio-importsummary__file">
              File: {checked.fileName}
            </span>
            <span>
              {checked.total} row{checked.total === 1 ? "" : "s"} detected
            </span>
            <span className="prio-importsummary__valid">
              <IconCheck size={13} />
              {checked.valid} valid row{checked.valid === 1 ? "" : "s"}
            </span>
            {invalidCount > 0 ? (
              <span className="prio-importsummary__invalid">
                <IconClose size={13} />
                {invalidCount} invalid row{invalidCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {checked.invalid.length > 0 ? (
            <ul className="prio-importproblems">
              {checked.invalid.map((row) => (
                <li key={row.row}>
                  <strong>Row {row.row}</strong>
                  <span className="prio-importproblems__summary">
                    Summary: {row.summary}
                  </span>
                  {row.errors.map((problem, index) => (
                    <span
                      key={`${problem.column ?? ""}-${index}`}
                      className="prio-importproblems__error"
                    >
                      Error: {problem.message}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}

          {invalidCount > checked.invalid.length ? (
            <span className="prio-hint">
              Showing the first {checked.invalid.length} of {invalidCount}{" "}
              rows that need attention.
            </span>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
