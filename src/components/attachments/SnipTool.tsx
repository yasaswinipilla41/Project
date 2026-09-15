"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  IconClock,
  IconClose,
  IconEdit,
  IconExternal,
  IconHome,
  IconImage,
  IconIssues,
  IconMaximize,
  IconMinimize,
  IconMyWork,
  IconPlus,
  IconProjects,
  IconReports,
  IconRestoreWindow,
  IconTrash,
  type IconProps,
} from "@/components/ui/Icon";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";
import { annotatedFilename, formatBytes } from "@/lib/attachments";
import {
  replaceAttachment,
  uploadStagedAttachment,
} from "@/lib/uploadAttachment";
import styles from "./SnipTool.module.css";
import {
  canCaptureScreen,
  canRecordScreen,
  captureScreenshot,
  CaptureError,
  formatDuration,
  startScreenRecording,
  type ActiveRecording,
} from "@/lib/screenCapture";

/**
 * The Snip Tool: a window of its own, not a menu.
 *
 * Capturing a screen is not a single click — it is a small session. You choose
 * what to capture, take a snip, keep the part that matters, mark it up, save
 * it, take another, and in the middle of that you often need to go and look at
 * something else in Prio. A dropdown cannot survive any of that: it closes on
 * the first click elsewhere and takes the capture with it.
 *
 * So this is a window. It is mounted once, by the application shell, which in
 * the App Router sits outside the routed content and is therefore not
 * unmounted when the page changes. That one placement is what makes every
 * persistence requirement fall out for free: moving between pages, minimising
 * or maximising it, or opening a dialog on top of it are all just renders of a
 * component that was never torn down.
 *
 * A snip, start to finish:
 *
 *   1. Choose where to capture from — this tab, one of Prio's own pages (the
 *      tab is taken there first), or another browser tab or window.
 *   2. **+ New snip.** The browser's own picker opens, leading with that
 *      choice. It is the browser's: Prio never sees anything the person did
 *      not pick there, and it cannot be skipped.
 *   3. Drag out the area to keep on the capture. The picker hands back a whole
 *      tab, window or screen — a sub-region is not something it can be asked
 *      for — so the area is chosen here, straight afterwards.
 *   4. The screenshot editor opens on that area, crop armed, every tool there.
 *   5. **Save** puts it on the issue (or the form) the window was opened for;
 *      saving it again after another edit writes over that same attachment.
 *      **Save as copy** leaves the original as it is and adds the marked-up
 *      picture beside it, named "-annotated".
 *
 * Every snip is its own row in the window, so a second and a third never
 * overwrite the first.
 *
 * What it will not do is decide where a capture belongs. The `target` is fixed
 * when the window is opened. An issue's snips are uploaded to that issue's id —
 * not to whatever page happens to be on screen when Save is pressed, which is
 * exactly what lets somebody walk off to another page to take the snip — and
 * the server authorizes every upload. A form's snips are handed to the form
 * that asked, and only while it is open.
 */

/** Where a finished capture is going. */
export type SnipTarget =
  | { kind: "draft"; label: string }
  | { kind: "issue"; issueId: string; label: string; projectName?: string };

/** One file handed to a form. */
export interface SnipDelivery {
  file: File;
  /** Recordings only, so a staged row can say how long one runs. */
  durationMs?: number;
  /** The row this writes over — a snip saved again after another edit. */
  replaces?: string;
}

/**
 * What a form hands over so a capture can reach it. Returns the id of the row
 * each delivery landed in, in order, so a later Save can name its own.
 */
type Receiver = (deliveries: SnipDelivery[]) => Promise<string[]> | string[];

/** A recording, held until it is attached or discarded. */
interface Capture {
  file: File;
  durationMs?: number;
}

/** One snip taken in this session. */
interface Snip {
  id: string;
  name: string;
  /** What it is now: the area chosen, or the latest edit of it. */
  file: File;
  /** The attachment (issue) or staged row (form) it was saved as. */
  savedAs: string | null;
  /** Holds changes that are not saved — never saved, or a save that failed. */
  dirty: boolean;
}

/** What the window should do the moment it opens, if anything. */
export type SnipAction = "screenshot" | "record";

interface SnipToolValue {
  /** Opens the window for a target, or brings it back if already open. */
  open: (target: SnipTarget, start?: SnipAction) => void;
  close: () => void;
  /** The surface currently able to receive a capture, if it is mounted. */
  register: (target: SnipTarget, receive: Receiver) => () => void;
  isOpen: boolean;
  target: SnipTarget | null;
}

/** This tab as it is, another tab or window, or one of Prio's own pages. */
type SourceChoice = "this-tab" | "other" | `/${string}`;

/**
 * Prio's own pages, offered as places to capture from.
 *
 * The browser cannot list other tabs to a web page, and would be right not to.
 * What Prio can offer is itself: choosing one of these takes this tab there,
 * and the snip is then of that page. Every one of them is a page every
 * signed-in person already has in the sidebar.
 */
const APP_PAGES: {
  href: `/${string}`;
  label: string;
  Icon: ComponentType<IconProps>;
}[] = [
  { href: "/", label: "Home", Icon: IconHome },
  { href: "/my-work", label: "My Work", Icon: IconMyWork },
  { href: "/projects", label: "Projects", Icon: IconProjects },
  { href: "/issues", label: "Issues", Icon: IconIssues },
  { href: "/reports", label: "Reports", Icon: IconReports },
];

const SnipToolContext = createContext<SnipToolValue | null>(null);

function keyOf(target: SnipTarget): string {
  return target.kind === "issue"
    ? `issue:${target.issueId}`
    : `draft:${target.label}`;
}

let nextSnip = 0;
const snipId = () => `snip-${(nextSnip += 1)}`;

/** The Snip Tool, for a surface that wants to offer it. */
export function useSnipTool(): SnipToolValue {
  const value = useContext(SnipToolContext);
  if (!value) {
    throw new Error("useSnipTool must be used inside SnipToolProvider");
  }
  return value;
}

/**
 * Offers the Snip Tool to a surface.
 *
 * A form passes `receive`, and is registered for as long as it is mounted, so
 * a snip saved while the person was elsewhere reaches it the moment they come
 * back — the window holds it until then rather than guessing. An issue passes
 * nothing: it already exists, so the window uploads to it directly.
 */
export function useSnipReceiver(
  target: SnipTarget | null,
  receive?: Receiver,
): { openSnipTool: (start?: SnipAction) => void; available: boolean } {
  const snip = useContext(SnipToolContext);

  /* The receiver is read through a ref so re-registering is not forced every
     time the surface re-renders with a new closure. Written after the render
     rather than during it; the ref already holds a usable function from the
     first one, so nothing is ever called through an empty slot. */
  const receiveRef = useRef(receive);
  useEffect(() => {
    receiveRef.current = receive;
  }, [receive]);

  const key = target ? keyOf(target) : null;
  const receives = Boolean(receive);

  useEffect(() => {
    if (!snip || !target || !key || !receives) return;
    return snip.register(target, (deliveries) =>
      receiveRef.current ? receiveRef.current(deliveries) : [],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snip, key, receives]);

  return {
    openSnipTool: (start?: SnipAction) => {
      if (snip && target) snip.open(target, start);
    },
    available: Boolean(snip) && (canCaptureScreen() || canRecordScreen()),
  };
}

export function SnipToolProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNavigation] = useTransition();

  const [target, setTarget] = useState<SnipTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const [source, setSource] = useState<SourceChoice>("this-tab");
  const [snips, setSnips] = useState<Snip[]>([]);
  /** The snip the editor is open on. */
  const [editing, setEditing] = useState<string | null>(null);
  /** A frame just captured, waiting for its area to be chosen. */
  const [selecting, setSelecting] = useState<Blob | null>(null);

  const [capture, setCapture] = useState<Capture | null>(null);
  const [busy, setBusy] = useState<
    "screenshot" | "record" | "attach" | "save" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* What is held, readable from `open` without making `open` depend on it. */
  const captureRef = useRef<Capture | null>(null);

  /*
   * Starting a recording, reached through a ref.
   *
   * `open` has to stay a callback that never changes — it goes into the
   * context value, and a context value that changed every render would
   * re-register every surface every render for nothing. Holding the entry
   * point in a ref rewritten after each render keeps `open` stable while
   * still calling the current one.
   */
  const startCapture = useRef<(action: SnipAction) => void>(() => {});

  const recordingRef = useRef<ActiveRecording | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  /*
   * Where the person has dragged the window to.
   *
   * Null until they move it, which is what keeps the default corner a
   * stylesheet decision rather than a number duplicated in here. Once it is
   * set the window is placed from the top left, because that is the corner
   * that stays still while the body grows and shrinks -- anchored bottom
   * right, taking a capture would shove the window up the screen.
   *
   * Deliberately not reset by close: a window put somewhere out of the way
   * stays there next time, which is the whole reason somebody moved it.
   */
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const windowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  /* Receivers by target key. A surface registers while it is mounted; the
     window looks one up only when it is actually delivering. */
  const receivers = useRef(new Map<string, Receiver>());

  const register = useCallback((t: SnipTarget, receive: Receiver) => {
    const key = keyOf(t);
    receivers.current.set(key, receive);
    return () => {
      // Only remove the registration still owned by this surface.
      if (receivers.current.get(key) === receive) receivers.current.delete(key);
    };
  }, []);

  const openFor = useCallback((t: SnipTarget, start?: SnipAction) => {
    setTarget((current) => {
      /* Re-opening for a different target while something is still held
         would be the one way a snip could reach the wrong issue. The session
         is cleared rather than carried across; what was saved is already on
         the issue it was saved to. */
      if (current && keyOf(current) !== keyOf(t)) {
        setCapture(null);
        setSnips([]);
        setEditing(null);
        setSelecting(null);
        setError(null);
        setNotice(null);
      }
      return t;
    });
    setOpen(true);
    setMinimized(false);

    /* Record starts straight away, as it always has. Screenshot does not: it
       opens on the choice of what to capture, and the snip starts from + New
       snip once that choice is made. */
    if (start === "record") startCapture.current("record");
  }, []);

  const close = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setRecording(false);
    setOpen(false);
    setMinimized(false);
    setMaximized(false);
    setCapture(null);
    setSnips([]);
    setEditing(null);
    setSelecting(null);
    setError(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  useEffect(() => {
    startCapture.current = (action) => {
      /* Not while something is already held: a second press should bring the
         window back to the recording waiting there, never start a new one
         over the top of it. */
      if (captureRef.current || recordingRef.current) return;
      if (action === "record") void beginRecording();
    };
  });

  // Ticks while recording, and only while recording.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now())),
      250,
    );
    return () => clearInterval(timer);
  }, [recording]);

  // Nothing keeps sharing the screen after the window is gone.
  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
    };
  }, []);

  const floating = !(maximized && !minimized);

  /**
   * Moving the window, by its title bar.
   *
   * Kept on screen rather than merely followed: a window dragged off the edge
   * is a window that cannot be brought back, and the session it is holding
   * goes with it. The pointer is captured on the bar so a fast drag that
   * outruns the cursor does not drop the window halfway.
   *
   * Only the bar itself starts a move. The buttons in it are controls, and a
   * press that wandered a pixel should still press them. A maximised window
   * fills the screen and does not move.
   */
  function clampToViewport(x: number, y: number): { x: number; y: number } {
    const box = windowRef.current?.getBoundingClientRect();
    const width = box?.width ?? 0;
    /* A margin of the bar's own height stays reachable at every edge, so the
       handle can always be grabbed again. The height is deliberately not
       subtracted from the bottom: the bar is at the top of the window, and
       keeping *that* reachable is what matters -- a tall window whose body
       runs past the fold is still perfectly usable. */
    const edge = 32;
    return {
      x: Math.min(Math.max(x, edge - width), window.innerWidth - edge),
      y: Math.min(Math.max(y, 0), window.innerHeight - edge),
    };
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !floating) return;
    // A control in the bar is being pressed, not the bar itself.
    if ((event.target as HTMLElement).closest("button")) return;

    const box = windowRef.current?.getBoundingClientRect();
    if (!box) return;

    dragRef.current = {
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    /* Fixed where it already is, so the first move does not jump the window
       from its bottom-right anchor to wherever the pointer happens to be. */
    setPosition(clampToViewport(box.left, box.top));
  }

  function onDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const offset = dragRef.current;
    if (!offset) return;
    event.preventDefault();
    setPosition(
      clampToViewport(event.clientX - offset.dx, event.clientY - offset.dy),
    );
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  /* A window parked against an edge should not end up off screen when the
     window it floats over is made smaller. */
  useEffect(() => {
    if (!position) return;
    const settle = () => setPosition((at) => (at ? clampToViewport(at.x, at.y) : at));
    window.addEventListener("resize", settle);
    return () => window.removeEventListener("resize", settle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position !== null]);

  const nameFor = (extension: string) =>
    `${extension === ".webm" ? "recording" : "screenshot"}-${Date.now()
      .toString(36)
      .slice(-4)}${extension}`;

  /** Where saved snips go, in words: "ENG-12 (Engineering)" or "New issue". */
  const destination =
    target?.kind === "issue" && target.projectName
      ? `${target.label} (${target.projectName})`
      : (target?.label ?? "");

  /**
   * Choosing where to capture from.
   *
   * One of Prio's own pages takes this tab there, so the snip is of that page;
   * the window and the issue it is for come along unchanged, because the
   * window is not part of the page.
   */
  function chooseSource(choice: SourceChoice) {
    setSource(choice);
    setError(null);
    if (choice !== "this-tab" && choice !== "other" && pathname !== choice) {
      startNavigation(() => router.push(choice));
    }
  }

  /* A page stays chosen while this tab is on it (or on its way there). Once
     the person has gone somewhere else, what a snip captures is this tab. */
  const selectedSource: SourceChoice =
    source === "this-tab" || source === "other"
      ? source
      : pathname === source || navigating
        ? source
        : "this-tab";

  /** + New snip: a fresh capture, then the area to keep. */
  async function newSnip() {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setBusy("screenshot");
    try {
      const frame = await captureScreenshot({
        source: selectedSource === "other" ? "any" : "this-tab",
      });
      setSelecting(frame);
    } catch (failure) {
      setError(
        failure instanceof CaptureError
          ? failure.message
          : "The screen could not be captured.",
      );
    } finally {
      // Back in view either way: to choose an area, or to explain the refusal.
      setBusy(null);
    }
  }

  /** The area chosen — or the whole capture — becomes a snip, into the editor. */
  async function finishSelection(area: Area | null) {
    const frame = selecting;
    setSelecting(null);
    if (!frame) return;

    try {
      const picture = await cropImage(frame, area);
      const name = nameFor(".png");
      const snip: Snip = {
        id: snipId(),
        name,
        file: new File([picture], name, { type: "image/png" }),
        savedAs: null,
        dirty: true,
      };
      setSnips((list) => [...list, snip]);
      setEditing(snip.id);
    } catch {
      setError("That area could not be captured. Please try again.");
    }
  }

  function updateSnip(id: string, patch: Partial<Snip>) {
    setSnips((list) =>
      list.map((snip) => (snip.id === id ? { ...snip, ...patch } : snip)),
    );
  }

  /**
   * Hands files to wherever this window is for.
   *
   * An issue gets them uploaded straight to its own id — `replaces` writes
   * over an attachment already there — so where the person happens to be
   * when they save changes nothing about where the files go. A form gets
   * them through its receiver, and only while it is open.
   */
  async function deliver(deliveries: SnipDelivery[]): Promise<string[]> {
    if (!target) throw new Error("The Snip Tool is not open for anything.");

    if (target.kind === "issue") {
      const ids: string[] = [];
      for (const { file, replaces } of deliveries) {
        if (replaces) {
          await replaceAttachment(replaces, file, file.name);
          ids.push(replaces);
        } else {
          const created = await uploadStagedAttachment(
            { issueId: target.issueId },
            file,
            file.name,
          );
          ids.push(created.id);
        }
      }
      /* Shows it on the issue's Attachments at once when that is the page on
         screen; any other page is left as it is. */
      router.refresh();
      return ids;
    }

    const receive = receivers.current.get(keyOf(target));
    if (!receive) {
      throw new Error(
        "Open the form you were filling in, and this will save to it.",
      );
    }
    return await receive(deliveries);
  }

  /** Runs a save, and says how it went in the window and as a toast. */
  async function persist(work: () => Promise<string>) {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      setNotice(message);
      toast(<>{message}</>);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "That snip could not be saved.",
      );
      setMinimized(false);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Save: this snip, as it now is, on the issue or form.
   *
   * The first save adds it. Every save after that writes over the same
   * attachment — one snip is one attachment however often it is edited. The
   * edit is kept on the snip even if the save fails, so nothing is lost and
   * Save can simply be pressed again.
   */
  async function saveSnip(snip: Snip, blob: Blob) {
    const file = new File([blob], snip.name, { type: blob.type || "image/png" });
    setEditing(null);
    updateSnip(snip.id, { file, dirty: true });

    await persist(async () => {
      const [id] = await deliver([
        { file, replaces: snip.savedAs ?? undefined },
      ]);
      updateSnip(snip.id, { file, savedAs: id ?? snip.savedAs, dirty: false });
      return snip.savedAs
        ? `Updated ${snip.name} on ${destination}`
        : `Saved ${snip.name} to ${destination}`;
    });
  }

  /**
   * Save as copy: the marked-up picture beside the original, which is left
   * exactly as it was.
   *
   * A snip not saved yet has no original on the issue to leave alone, so its
   * unmarked area goes up first and the copy beside it — both in one delivery,
   * so a form stages both rows rather than one overwriting the other.
   */
  async function saveSnipAsCopy(snip: Snip, blob: Blob) {
    const copyName = annotatedFilename(snip.name);
    const copyFile = new File([blob], copyName, {
      type: blob.type || "image/png",
    });
    setEditing(null);

    await persist(async () => {
      const deliveries: SnipDelivery[] = snip.savedAs
        ? [{ file: copyFile }]
        : [{ file: snip.file }, { file: copyFile }];
      const ids = await deliver(deliveries);

      const originalId = snip.savedAs ?? ids[0] ?? null;
      const copyId = ids[ids.length - 1] ?? null;
      setSnips((list) => [
        ...list.map((entry) =>
          entry.id === snip.id
            ? {
                ...entry,
                savedAs: originalId,
                dirty: snip.savedAs ? entry.dirty : false,
              }
            : entry,
        ),
        {
          id: snipId(),
          name: copyName,
          file: copyFile,
          savedAs: copyId,
          dirty: false,
        },
      ]);
      return `Saved a copy, ${copyName}, to ${destination}`;
    });
  }

  function discardSnip(id: string) {
    setSnips((list) => list.filter((snip) => snip.id !== id));
  }

  async function beginRecording() {
    setError(null);
    setNotice(null);
    setBusy("record");
    try {
      recordingRef.current = await startScreenRecording();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
    } catch (failure) {
      setError(
        failure instanceof CaptureError
          ? failure.message
          : "The screen could not be recorded.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function finishRecording() {
    const active = recordingRef.current;
    if (!active) return;
    setBusy("record");
    try {
      const result = await active.stop();
      setCapture({
        file: new File([result.blob], nameFor(".webm"), {
          type: result.mimeType || "video/webm",
        }),
        durationMs: result.durationMs,
      });
    } catch (failure) {
      setError(
        failure instanceof CaptureError
          ? failure.message
          : "The recording could not be saved.",
      );
    } finally {
      recordingRef.current = null;
      setRecording(false);
      setBusy(null);
    }
  }

  function discardRecording() {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setRecording(false);
    setError(null);
  }

  /**
   * Hands a finished recording to whatever asked for it.
   *
   * Delivered once and then dropped, which is what stops a second press —
   * or a restore, or a re-open — from attaching the same thing twice. If a
   * form is not open, nothing is delivered and the recording stays put until
   * it is.
   */
  async function attach() {
    if (!capture || !target) return;

    setBusy("attach");
    try {
      await deliver([{ file: capture.file, durationMs: capture.durationMs }]);
      setCapture(null);
      setError(null);
      toast(<>Attached {capture.file.name}</>);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "That capture could not be attached.",
      );
    } finally {
      setBusy(null);
    }
  }

  const value = useMemo<SnipToolValue>(
    () => ({ open: openFor, close, register, isOpen: open, target }),
    [openFor, close, register, open, target],
  );

  const captureSupported = canCaptureScreen();
  const recordSupported = canRecordScreen();

  const editingSnip = editing
    ? (snips.find((snip) => snip.id === editing) ?? null)
    : null;
  const holdsUnsaved = Boolean(capture) || snips.some((snip) => snip.dirty);
  const issuePath =
    target?.kind === "issue" ? `/issues/${target.label.toLowerCase()}` : null;

  return (
    <SnipToolContext.Provider value={value}>
      {children}

      {/* Stood down while the capture is being taken, while its area is being
          chosen and while the editor is up — the window is not part of what
          is being captured, and the editor is a full modal it would only
          overlap. It is hidden, not closed: everything it holds is state up
          here and comes back with it. */}
      {open && !editingSnip && !selecting && busy !== "screenshot" ? (
        <div
          ref={windowRef}
          className={styles.window}
          data-minimized={minimized || undefined}
          data-maximized={!floating || undefined}
          /* Placed from the top left once it has been moved; until then the
             stylesheet's own corner applies and these are simply absent. */
          style={
            position && floating
              ? { left: position.x, top: position.y, right: "auto", bottom: "auto" }
              : undefined
          }
          role="dialog"
          aria-label="Snip Tool"
          /* Not a modal: the whole point is that the rest of Prio stays
             usable while this is open. */
          aria-modal="false"
        >
          <div
            className={styles.bar}
            data-draggable={floating || undefined}
            onPointerDown={startDrag}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className={styles.title}>
              <IconImage size={14} />
              Snip Tool
            </span>
            <span className={styles.target} title={destination}>
              {destination}
            </span>

            <button
              type="button"
              className={styles.control}
              aria-label={minimized ? "Restore Snip Tool" : "Minimise Snip Tool"}
              title={minimized ? "Restore" : "Minimise"}
              onClick={() => setMinimized((m) => !m)}
            >
              {minimized ? (
                <IconRestoreWindow size={14} />
              ) : (
                <IconMinimize size={14} />
              )}
            </button>
            <button
              type="button"
              className={styles.control}
              aria-label={floating ? "Maximise Snip Tool" : "Restore Snip Tool size"}
              title={floating ? "Maximise" : "Restore size"}
              onClick={() => {
                setMaximized(floating);
                setMinimized(false);
              }}
            >
              {floating ? (
                <IconMaximize size={14} />
              ) : (
                <IconRestoreWindow size={14} />
              )}
            </button>
            <button
              type="button"
              className={styles.control}
              /* Closing is the way to throw away what is not saved, so it
                 says so while there is something to lose. Minimise is the
                 control for getting it out of the way. */
              aria-label={
                holdsUnsaved
                  ? "Discard unsaved and close Snip Tool"
                  : "Close Snip Tool"
              }
              title={holdsUnsaved ? "Discard unsaved and close" : "Close"}
              onClick={close}
            >
              <IconClose size={14} />
            </button>
          </div>

          {minimized ? null : (
            <div className={styles.body}>
              {recording ? (
                <div
                  className={styles.recording}
                  role="status"
                  aria-live="polite"
                >
                  <span className={styles.dot} aria-hidden />
                  <span className={styles.elapsed}>
                    Recording {formatDuration(elapsedMs)}
                  </span>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => void finishRecording()}
                    disabled={busy === "record"}
                  >
                    Stop recording
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={discardRecording}
                  >
                    Discard
                  </Button>
                </div>
              ) : capture ? (
                <CapturePreview
                  capture={capture}
                  busy={busy === "attach"}
                  onDiscard={() => {
                    setCapture(null);
                    setError(null);
                  }}
                  onAttach={() => void attach()}
                />
              ) : (
                <>
                  <fieldset className={styles.section}>
                    <legend className={styles.sectionLabel}>Capture from</legend>
                    <div className={styles.sourceGrid}>
                      <SourceOption
                        label="This tab"
                        hint="The page on screen now"
                        Icon={IconImage}
                        selected={selectedSource === "this-tab"}
                        onChoose={() => chooseSource("this-tab")}
                      />
                      {APP_PAGES.map((page) => (
                        <SourceOption
                          key={page.href}
                          label={page.label}
                          hint="Opens here, then snip"
                          Icon={page.Icon}
                          selected={selectedSource === page.href}
                          onChoose={() => chooseSource(page.href)}
                        />
                      ))}
                      <SourceOption
                        label="Another tab or window"
                        hint="Choose in the browser"
                        Icon={IconExternal}
                        selected={selectedSource === "other"}
                        onChoose={() => chooseSource("other")}
                      />
                    </div>
                  </fieldset>

                  <div className={styles.actions}>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={!captureSupported || busy !== null}
                      onClick={() => void newSnip()}
                    >
                      <IconPlus size={13} />
                      New snip
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!recordSupported || busy !== null}
                      onClick={() => void beginRecording()}
                    >
                      <IconClock size={13} />
                      Record
                    </Button>
                  </div>
                  <p className={styles.hint}>
                    Pick what to capture, then New snip. Drag over the capture
                    to keep the part that matters, mark it up, and Save — it
                    goes to {destination || "where you opened this"}. Each New
                    snip is a separate capture.
                  </p>
                  {!captureSupported && !recordSupported ? (
                    <p className={styles.error}>
                      This browser cannot capture the screen. Use Browse to
                      attach a file instead.
                    </p>
                  ) : null}
                </>
              )}

              {snips.length > 0 ? (
                <section className={styles.section} aria-label="Snips">
                  <p className={styles.sectionLabel}>
                    <span>Snips ({snips.length})</span>
                    {issuePath && pathname !== issuePath ? (
                      <Link href={issuePath} className={styles.backLink}>
                        Open {target?.label}
                      </Link>
                    ) : null}
                  </p>
                  <ul className={styles.snipList}>
                    {snips.map((snip) => (
                      <SnipRow
                        key={snip.id}
                        snip={snip}
                        destination={destination}
                        busy={busy !== null}
                        onEdit={() => setEditing(snip.id)}
                        onSave={() => void saveSnip(snip, snip.file)}
                        onDiscard={() => discardSnip(snip.id)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {notice ? (
                <p className={styles.notice} role="status">
                  {notice}
                </p>
              ) : null}

              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {selecting ? (
        <SnipAreaSelector
          source={selecting}
          onSelect={(area) => void finishSelection(area)}
          onCancel={() => setSelecting(null)}
        />
      ) : null}

      {editingSnip ? (
        <ScreenshotEditor
          open
          source={editingSnip.file}
          /*
           * Opened on the crop tool, as it always has been for a snip: the
           * area is already chosen, and the crop is there to tighten it
           * further. Every other tool is one click away as usual.
           */
          initialTool="crop"
          onCancel={() => setEditing(null)}
          onSave={(blob) => void saveSnip(editingSnip, blob)}
          onSaveAs={(blob) => void saveSnipAsCopy(editingSnip, blob)}
        />
      ) : null}
    </SnipToolContext.Provider>
  );
}

/** One place to capture from, as a card with a real radio in it. */
function SourceOption({
  label,
  hint,
  Icon,
  selected,
  onChoose,
}: {
  label: string;
  hint: string;
  Icon: ComponentType<IconProps>;
  selected: boolean;
  onChoose: () => void;
}) {
  return (
    <label className={styles.source} data-selected={selected || undefined}>
      <input
        type="radio"
        name="prio-snip-source"
        className="prio-visually-hidden"
        checked={selected}
        onChange={onChoose}
      />
      <span className={styles.sourceIcon} aria-hidden>
        <Icon size={15} />
      </span>
      <span className={styles.sourceName}>{label}</span>
      <span className={styles.sourceHint}>{hint}</span>
    </label>
  );
}

/** A snip in the session list: what it is, where it went, what can be done. */
function SnipRow({
  snip,
  destination,
  busy,
  onEdit,
  onSave,
  onDiscard,
}: {
  snip: Snip;
  destination: string;
  busy: boolean;
  onEdit: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const url = useObjectUrl(snip.file);

  const status = snip.savedAs
    ? snip.dirty
      ? "Changes not saved"
      : `Saved to ${destination}`
    : "Not saved yet";

  return (
    <li
      className={styles.snipRow}
      data-saved={(snip.savedAs && !snip.dirty) || undefined}
    >
      <span className={styles.snipThumb}>
        {url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={url} alt="" />
        ) : null}
      </span>
      <span className={styles.snipMeta}>
        <span className={styles.snipName} title={snip.name}>
          {snip.name}
        </span>
        <span className={styles.snipStatus}>
          {status} · {formatBytes(snip.file.size)}
        </span>
      </span>
      <span className={styles.snipActions}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onEdit}
          disabled={busy}
          aria-label={`Edit ${snip.name}`}
        >
          <IconEdit size={13} />
        </Button>
        {snip.dirty ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSave}
            disabled={busy}
            aria-label={`Save ${snip.name}`}
          >
            Save
          </Button>
        ) : null}
        {snip.savedAs ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={busy}
            aria-label={`Discard ${snip.name}`}
          >
            <IconTrash size={13} />
          </Button>
        )}
      </span>
    </li>
  );
}

/** The held recording, with the two things that can be done to it. */
function CapturePreview({
  capture,
  busy,
  onDiscard,
  onAttach,
}: {
  capture: Capture;
  busy: boolean;
  onDiscard: () => void;
  onAttach: () => void;
}) {
  const url = useObjectUrl(capture.file);

  return (
    <>
      <div className={styles.preview}>
        {url ? <video src={url} controls preload="metadata" playsInline /> : null}
      </div>

      <p className={styles.meta}>
        {capture.file.name} · {formatBytes(capture.file.size)}
        {capture.durationMs === undefined
          ? ""
          : ` · ${formatDuration(capture.durationMs)}`}
      </p>

      <div className={styles.actions}>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onAttach}
          disabled={busy}
        >
          {busy ? "Attaching…" : "Attach"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={busy}
        >
          <IconTrash size={13} />
          Discard
        </Button>
      </div>
    </>
  );
}

/** An object URL for a blob, revoked when the blob changes or the owner goes. */
function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(blob);
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
      URL.revokeObjectURL(next);
    };
  }, [blob]);

  return url;
}

/* ------------------------------------------------------- choosing an area */

/** A rectangle in the capture's own pixels. */
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smaller than this, on screen, is a click rather than an area. */
const MIN_AREA = 6;

/**
 * The capture, full screen, with an area dragged out on it.
 *
 * Releasing the drag takes that area. "Use full capture" (or Enter) keeps the
 * whole frame, and Cancel (or Escape) drops it without making a snip. The keys
 * are taken ahead of any dialog underneath — Create, say — which listens on the
 * document and would otherwise treat Escape as "close the form".
 */
function SnipAreaSelector({
  source,
  onSelect,
  onCancel,
}: {
  source: Blob;
  onSelect: (area: Area | null) => void;
  onCancel: () => void;
}) {
  const url = useObjectUrl(source);
  const imageRef = useRef<HTMLImageElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const selectRef = useRef(onSelect);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    selectRef.current = onSelect;
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") cancelRef.current();
      else selectRef.current(null);
    };
    // The window's capture phase runs before the document's.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function pointOf(event: ReactPointerEvent) {
    const rect = imageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    };
  }

  function boxFrom(start: { x: number; y: number }, end: { x: number; y: number }) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
    };
  }

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !imageRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointOf(event);
    startRef.current = point;
    setBox({ x: point.x, y: point.y, w: 0, h: 0 });
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current;
    if (!start || !imageRef.current) return;
    setBox(boxFrom(start, pointOf(event)));
  }

  function up(event: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current;
    startRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const image = imageRef.current;
    if (!start || !image) return;

    const shown = boxFrom(start, pointOf(event));
    if (shown.w < MIN_AREA || shown.h < MIN_AREA) {
      setBox(null);
      return;
    }

    /* On screen the capture is scaled to fit; the area is taken in the
       capture's own pixels, so nothing is lost to the scaling. */
    const rect = image.getBoundingClientRect();
    const scaleX = image.naturalWidth / rect.width;
    const scaleY = image.naturalHeight / rect.height;
    onSelect({
      x: shown.x * scaleX,
      y: shown.y * scaleY,
      width: shown.w * scaleX,
      height: shown.h * scaleY,
    });
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={styles.selector}
      role="dialog"
      aria-modal="true"
      aria-label="Select area to snip"
    >
      <div className={styles.selectorBar}>
        <span className={styles.selectorHint}>
          Drag to select the area to snip. Enter keeps the whole capture;
          Escape cancels.
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onSelect(null)}
        >
          Use full capture
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className={styles.selectorStage}>
        {url ? (
          <div
            className={styles.selectorFrame}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              startRef.current = null;
              setBox(null);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imageRef}
              src={url}
              alt="The capture to select an area from"
              className={styles.selectorImage}
              draggable={false}
            />
            {box ? (
              <div
                className={styles.selection}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** The chosen area of a capture as its own PNG, or the capture itself. */
async function cropImage(source: Blob, area: Area | null): Promise<Blob> {
  if (!area) return source;

  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("The capture could not be read."));
      element.src = url;
    });

    const x = Math.max(0, Math.round(area.x));
    const y = Math.max(0, Math.round(area.y));
    const width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(area.width)));
    const height = Math.max(
      1,
      Math.min(image.naturalHeight - y, Math.round(area.height)),
    );

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The area could not be prepared.");
    context.drawImage(image, x, y, width, height, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("The area came back empty.")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
