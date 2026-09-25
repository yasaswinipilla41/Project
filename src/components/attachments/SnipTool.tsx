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
  IconImage,
  IconMaximize,
  IconMinimize,
  IconPause,
  IconPlay,
  IconPlus,
  IconRestoreWindow,
  IconStopSquare,
  IconTrash,
} from "@/components/ui/Icon";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";
import { annotatedFilename, formatBytes } from "@/lib/attachments";
import {
  replaceAttachment,
  uploadStagedAttachment,
} from "@/lib/uploadAttachment";
import styles from "./SnipTool.module.css";
import { ClickPulse } from "./ClickPulse";
import {
  canCaptureScreen,
  canRecordScreen,
  CaptureError,
  formatDuration,
  retainCaptureSource,
  startScreenRecording,
  type ActiveRecording,
  type RetainedSource,
} from "@/lib/screenCapture";
import { canFloatWindow, openFloatingWindow } from "@/lib/documentPip";

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
  /** Recordings only: whether the browser actually shared any sound. */
  hasAudio?: boolean;
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

/**
 * Where a snip comes from: this tab as it is, or a tab or window chosen in the
 * browser's own picker.
 *
 * Prio's own pages were briefly offered here as a third kind of source — first
 * as a hand-written list of routes, then read from the page's navigation
 * landmarks. Both were the same mistake: a second, worse copy of navigation the
 * application already has. Going to a page is something the person does in the
 * application, in the ordinary way; this window's business is what to point the
 * camera at, which is either the tab they are on or a surface the browser let
 * them pick.
 */
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

  const [target, setTarget] = useState<SnipTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  /**
   * The tab or window chosen in the browser's picker, kept between snips.
   *
   * A ref rather than state: the stream has to survive every re-render
   * untouched, and what the window actually draws is `sharing` below.
   */
  const retained = useRef<RetainedSource | null>(null);
  /** What the browser calls the retained surface, or null when there is none. */
  const [sharing, setSharing] = useState<string | null>(null);
  const [snips, setSnips] = useState<Snip[]>([]);
  /** The snip the editor is open on. */
  const [editing, setEditing] = useState<string | null>(null);
  /** A frame just captured, waiting for its area to be chosen. */
  const [selecting, setSelecting] = useState<Blob | null>(null);

  const [capture, setCapture] = useState<Capture | null>(null);
  /*
   * What is in flight. `screenshot` is the one that hides the window — it is
   * about to be in the picture — which is why arranging a *source* is its own
   * state: the browser's picker is a dialog of its own, and the window
   * vanishing behind it would be a flicker for no reason.
   */
  const [busy, setBusy] = useState<
    "screenshot" | "source" | "record" | "attach" | "save" | null
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
  const [paused, setPaused] = useState(false);
  /** Whether this browser's recorder can pause; false hides the control. */
  const [canPause, setCanPause] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  /*
   * Time already spent paused, and when the current pause began.
   *
   * The clock on screen has to agree with the file that comes out, and a
   * paused recorder writes nothing — so both this and `screenCapture` subtract
   * the same spans rather than reporting wall-clock.
   */
  const pausedTotalRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);

  /*
   * The floating window the recording strip moves into, while one is open.
   *
   * The strip on the page is only visible from the Prio tab, and the thing
   * being recorded is usually another tab. A Document Picture-in-Picture
   * window stays above every tab, so the same strip — same buttons, same
   * handlers, same recorder — is rendered there instead. Null means the strip
   * is on the page, as it always was: no support, refused, or closed by the
   * person, in which case the recording carries on regardless.
   */
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  /* The same window, for the unmount cleanup, which sees only first-render
     state. */
  const pipRef = useRef<Window | null>(null);

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
    /* Closing lets go of the shared tab or window as well: the browser's
       sharing indicator should not outlive the window that asked for it. */
    retained.current?.stop();
    retained.current = null;
    setSharing(null);
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

  /**
   * Ctrl / Cmd + Shift + A takes a snip.
   *
   * The one thing somebody wants a shortcut for here is starting a capture
   * without first finding the window — usually while already looking at the
   * thing they want a picture of. It opens the tool for whatever surface is
   * registered and goes straight into a snip, which is the same path New Snip
   * takes.
   *
   * Three deliberate restraints, all borrowed from the search shortcut:
   *   - **not while typing**, so an `A` inside a comment is an `A`;
   *   - **not while a capture is already in flight**, so a second press
   *     cannot start one over the top of another;
   *   - **`preventDefault` only when it actually acts**, so the combination
   *     is left to the browser in every case this does not handle.
   *
   * `Shift` puts it clear of the browser's own Ctrl+A, and nothing in Prio
   * binds it.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "a") return;

      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true
      ) {
        return;
      }

      /* Nothing to snip into: the tool is opened for a work item or a form,
         and without one there is nowhere for the picture to go. */
      if (!target) return;
      if (captureRef.current || recordingRef.current || selecting) return;

      event.preventDefault();
      /* Brought back first. Closing the window leaves its target behind, so
         the shortcut still knows where a picture would go — but the preview
         it is about to produce lives in the window, and capturing into a
         window that is not on screen is capturing into nowhere. */
      setOpen(true);
      setMinimized(false);
      void newSnip();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  /*
   * Ticks while recording, and not while it is paused.
   *
   * Scheduled on the floating window when there is one. The Prio tab is in
   * the background while another tab is recorded, and the browser slows a
   * background tab's timers down; the floating window is on screen, so its
   * clock keeps pace. It is the same clock either way — only where it is
   * scheduled moves.
   */
  useEffect(() => {
    if (!recording || paused) return;
    const host = pipWindow ?? window;
    const timer = host.setInterval(
      () =>
        setElapsedMs(
          Math.max(
            0,
            Date.now() - (startedAtRef.current ?? Date.now()) - pausedTotalRef.current,
          ),
        ),
      250,
    );
    return () => host.clearInterval(timer);
  }, [recording, paused, pipWindow]);

  /* The floating window lives exactly as long as the recording: stopped,
     discarded, or ended from the browser's own sharing bar, it closes and the
     Snip Tool window comes back with the result as it always has. Closing
     it fires `pagehide`, which is what lets go of it below. */
  useEffect(() => {
    if (!recording) pipWindow?.close();
  }, [recording, pipWindow]);

  useEffect(() => {
    pipRef.current = pipWindow;
  }, [pipWindow]);

  /* Closed by the person, or by the browser: the strip returns to the page
     and the recording carries on. Closing the controls is not stopping. */
  useEffect(() => {
    if (!pipWindow) return;
    const floating = pipWindow;
    const onGone = () =>
      setPipWindow((current) => (current === floating ? null : current));
    floating.addEventListener("pagehide", onGone);
    return () => floating.removeEventListener("pagehide", onGone);
  }, [pipWindow]);

  // Nothing keeps sharing the screen after the window is gone.
  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
      pipRef.current?.close();
      pipRef.current = null;
      retained.current?.stop();
      retained.current = null;
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

  /** Lets go of the shared tab or window, if one is being held. */
  function releaseSource() {
    retained.current?.stop();
    retained.current = null;
    setSharing(null);
  }

  /**
   * Choosing where to capture from.
   *
   * "This tab" shares nothing until a snip is actually taken, which is why it
   * is the one that costs nothing to leave selected.
   *
   * "Another tab or window" opens the browser's own picker *now* and keeps what
   * comes back. That is the whole point: the surface somebody wants a picture
   * of is usually one they have to go and find first, and asking for it at snip
   * time would both prompt again and give them no chance to get there. So the
   * share is arranged once, the person navigates wherever they need to — in
   * that tab, in this one, however they like — and New snip copies whatever the
   * chosen surface is showing by then.
   *
   * Nothing here navigates anything. The picker is the browser's, the choice in
   * it is the person's, and Prio never sees a surface they did not pick.
   */
  /**
   * Gets hold of a surface to capture, asking the browser once.
   *
   * The surface somebody wants a picture of is usually one they have to go and
   * find first, so the share is arranged once and then kept: the person
   * navigates wherever they need to — in that tab, in this one, however they
   * like — and each New Snip copies whatever the chosen surface is showing by
   * then. Asking again per snip would both re-prompt and give them no chance
   * to get there.
   *
   * Nothing here navigates anything. The picker is the browser's, the choice
   * in it is the person's, and Prio never sees a surface they did not pick.
   */
  async function acquireSource(): Promise<RetainedSource> {
    if (retained.current) return retained.current;

    const picked = await retainCaptureSource({ source: "any" });
    retained.current = picked;
    setSharing(picked.label);

    /* The browser's own "Stop sharing" bar can end it at any moment. When it
       does, the window says so and asks again at the next snip rather than
       failing. */
    picked.onEnded(() => {
      retained.current = null;
      setSharing(null);
    });

    return picked;
  }

  /** New Snip: a fresh capture of the shared surface, then the area to keep. */
  async function newSnip() {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setBusy("screenshot");
    try {
      /* The surface already being shared, sampled as it looks right now —
         wherever the person has got to. The first snip of a session asks the
         browser which surface that is, which is also the only way another tab
         can ever be reached. */
      const source = await acquireSource();
      setSelecting(await source.grab());
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

  /** The area chosen — or the whole capture — becomes the capture to review. */
  async function finishSelection(area: Area | null) {
    const frame = selecting;
    setSelecting(null);
    if (!frame) return;

    try {
      const picture = await cropImage(frame, area);
      const name = nameFor(".png");
      /*
       * Straight to the preview, not into the editor.
       *
       * The editor used to sit between every capture and its attachment, so
       * the ordinary case — take a picture of the thing, put it on the work
       * item — cost a crop tool, a Save and a choice about copies. It is
       * still one click away from the attachment itself for the times
       * somebody genuinely wants to draw on a screenshot; it is no longer the
       * toll on the times they do not.
       */
      setCapture({ file: new File([picture], name, { type: "image/png" }) });
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
      pausedTotalRef.current = 0;
      pausedAtRef.current = null;
      setElapsedMs(0);
      setPaused(false);
      /* Asked of the recorder that was actually made, because pausing is
         optional in the specification and a browser without it must not be
         offered a button that would do nothing. */
      setCanPause(recordingRef.current.canPause);
      setRecording(true);
      /* Straight out to a floating window, so the controls follow the person
         to the tab they are about to record. Refused — no support, or the
         click that started this has gone stale while the picker was open —
         and the strip stays on the page, with its own button to try again. */
      void floatControls();
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
        /* Read off the stream when the recording began. Said in the preview
           rather than discovered on playback: a silent file looks like a
           fault, and "no sound was shared" is the truth about the surface
           that was picked. */
        hasAudio: active.hasAudio,
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
      setPaused(false);
      pausedAtRef.current = null;
      setBusy(null);
    }
  }

  /**
   * Moves the recording strip into a floating window, if the browser allows.
   *
   * Nothing about the recording changes: the window is only somewhere else to
   * render the same strip, and every button in it calls the handlers below.
   */
  async function floatControls() {
    if (pipWindow && !pipWindow.closed) return;
    const floating = await openFloatingWindow({ width: 300, height: 56 });
    if (!floating) return;
    /* Stopped while the window was opening: nothing left to control. */
    if (!recordingRef.current) {
      floating.close();
      return;
    }
    setPipWindow(floating);
  }

  function discardRecording() {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setRecording(false);
    setPaused(false);
    pausedAtRef.current = null;
    setError(null);
  }

  /**
   * Holds the recording where it is, or lets it run on again.
   *
   * The recorder is the authority on whether it worked — `pause` returns false
   * on a browser that does not implement it, and on one that does but refused —
   * so the button only changes what it says when the recorder actually moved.
   */
  function togglePause() {
    const active = recordingRef.current;
    if (!active) return;

    if (active.isPaused()) {
      if (!active.resume()) return;
      if (pausedAtRef.current !== null) {
        pausedTotalRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      setPaused(false);
      return;
    }

    if (!active.pause()) return;
    pausedAtRef.current = Date.now();
    setPaused(true);
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
      const [id] = await deliver([
        { file: capture.file, durationMs: capture.durationMs },
      ]);
      /*
       * Kept in the session list once it has landed.
       *
       * The list is what the window has sent for this target — it is how
       * somebody sees that the third snip really did go, and it carries the
       * way back to the work item. Added here, after the upload, so a row
       * only ever describes something that exists.
       */
      setSnips((list) => [
        ...list,
        {
          id: snipId(),
          name: capture.file.name,
          file: capture.file,
          savedAs: id ?? null,
          dirty: false,
        },
      ]);
      setCapture(null);
      setError(null);
      toast(<>Uploaded {capture.file.name}</>);
    } catch (failure) {
      /*
       * Kept rather than lost.
       *
       * The usual reason delivery fails is that the form this was opened for
       * has been closed, and the capture has nowhere to go *yet*. Throwing it
       * away would punish somebody for the order they did things in, so it
       * joins the list unsent, with its own Save, and waits for the form to
       * come back.
       */
      setSnips((list) => [
        ...list,
        {
          id: snipId(),
          name: capture.file.name,
          file: capture.file,
          savedAs: null,
          dirty: true,
        },
      ]);
      setCapture(null);
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

  const floatSupported = canFloatWindow();
  const stopping = recording && busy === "record";

  /* The strip, for wherever it is shown: on the page, or in the floating
     window. One piece of markup and one set of handlers, so the two can never
     disagree about what a button does. */
  function recordingBar(floating: boolean) {
    return (
      <div
        className={styles.recordingBar}
        data-floating={floating || undefined}
        role="status"
        aria-live="polite"
      >
        <span
          className={styles.dot}
          data-paused={paused || undefined}
          aria-hidden
        />
        <span className={styles.elapsed}>
          {stopping ? "Stopping…" : paused ? "Paused" : "Recording"}{" "}
          {formatDuration(elapsedMs)}
        </span>
        {canPause ? (
          <button
            type="button"
            className={styles.barAction}
            onClick={togglePause}
            disabled={busy === "record"}
            aria-label={paused ? "Resume recording" : "Pause recording"}
            title={paused ? "Resume recording" : "Pause recording"}
          >
            {paused ? <IconPlay size={13} /> : <IconPause size={13} />}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.barAction}
          data-stop
          onClick={() => void finishRecording()}
          disabled={busy === "record"}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <IconStopSquare size={13} />
        </button>
        <button
          type="button"
          className={styles.barAction}
          onClick={discardRecording}
          disabled={busy === "record"}
          aria-label="Discard recording"
          title="Discard recording"
        >
          <IconTrash size={13} />
        </button>
        {/* The way back out to a floating window: when opening it with the
            recording was refused, or after it was closed. Only where the
            browser has one to open. */}
        {!floating && floatSupported ? (
          <button
            type="button"
            className={styles.barAction}
            onClick={() => void floatControls()}
            disabled={busy === "record"}
            aria-label="Float recording controls over other tabs"
            title="Float recording controls over other tabs"
          >
            <IconExternal size={13} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <SnipToolContext.Provider value={value}>
      {children}

      {/* Where the pointer was pressed, for as long as a recording is
          running. See `ClickPulse` for what it can and cannot reach. */}
      <ClickPulse active={recording} />

      {/*
       * The one control a running recording needs, and nothing else.
       *
       * The window itself is away while recording — controls sitting over the
       * thing being recorded end up in the file — so this strip is what stops
       * it. Kept to the bottom-right corner, small, and out of the way of the
       * content somebody is demonstrating.
       *
       * It cannot be hidden from every recording: a person who shares their
       * whole screen shares the window Prio is in, and nothing inside a page
       * can opt an element out of the compositor. Recording another tab or
       * another window — what the picker offers first — leaves it out
       * entirely. That limit is the browser's, and is stated rather than
       * papered over.
       */}
      {open && recording
        ? pipWindow
          ? createPortal(recordingBar(true), pipWindow.document.body)
          : recordingBar(false)
        : null}

      {/* Stood down while the capture is being taken, while its area is being
          chosen, while the editor is up, and while a recording is running —
          the window is not part of what is being captured, and the editor is
          a full modal it would only overlap. It is hidden, not closed:
          everything it holds is state up here and comes back with it.

          A recording hides it for the same reason a snip does: controls that
          sit over the thing being recorded end up in the file. What replaces
          them is the small strip below, which is how the recording is stopped
          while the window itself is away. */}
      {open &&
      !editingSnip &&
      !selecting &&
      busy !== "screenshot" &&
      !recording ? (
        <div
          ref={windowRef}
          className={styles.window}
          data-minimized={minimized || undefined}
          data-recording={recording || undefined}
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
              {capture ? (
                <CapturePreview
                  capture={capture}
                  busy={busy === "attach"}
                  onDiscard={() => {
                    setCapture(null);
                    setError(null);
                  }}
                  onAttach={() => void attach()}
                  /* Offered for a recording only: a snip's "again" is New
                     Snip, which is already the first thing on the screen it
                     returns to. */
                  onRecordAgain={
                    capture.file.type.startsWith("video/")
                      ? () => {
                          setCapture(null);
                          setError(null);
                          void beginRecording();
                        }
                      : undefined
                  }
                />
              ) : (
                <>
                  {/*
                   * Two things to choose between, and nothing else.
                   *
                   * This used to open on a choice of capture source — "This
                   * tab" or "Another tab or window" — which asked a question
                   * the browser is about to ask anyway, and asked it before
                   * the person had said what they wanted to do. New Snip now
                   * goes straight to the browser's own picker, which is the
                   * only thing that can offer another tab, so any surface is
                   * reachable without Prio holding an opinion about it.
                   */}
                  <div className={styles.actions}>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={!captureSupported || busy !== null}
                      onClick={() => void newSnip()}
                    >
                      <IconPlus size={13} />
                      New Snip
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!recordSupported || busy !== null}
                      onClick={() => void beginRecording()}
                    >
                      <IconClock size={13} />
                      Recorder
                    </Button>
                  </div>

                  {/*
                   * What Prio is capturing from, and the way out of it.
                   *
                   * Worded as capture rather than sharing. Nothing is being
                   * sent anywhere: the browser hands Prio frames of a surface
                   * the person picked, to put on a work item. "Sharing your
                   * screen" describes a call, and reading it here invites the
                   * reasonable worry that somebody is watching.
                   *
                   * Shown only once a surface is actually being held, so it
                   * reports a fact rather than offering a setting.
                   */}
                  {sharing ? (
                    <p className={styles.sharing}>
                      <span className={styles.sharingName} title={sharing}>
                        Capturing from {sharing}
                      </span>
                      <button
                        type="button"
                        className="prio-btn prio-btn--ghost prio-btn--sm"
                        onClick={releaseSource}
                      >
                        Release source
                      </button>
                    </p>
                  ) : null}

                  <p className={styles.hint}>
                    New Snip hides this window and asks which surface to
                    capture. Go to the page you want, drag over the part that
                    matters, then Upload — it goes to{" "}
                    {destination || "where you opened this"}. Each New Snip is
                    a separate capture.
                  </p>
                  {/* The genuine limit, said plainly rather than worked
                      around. A page cannot enumerate your tabs and should not
                      be able to; what it can do is ask the browser to ask you,
                      which is what the picker is. */}
                  <p className={styles.hint}>
                    A page cannot list your tabs or read one you have not
                    shared, so the choice is made in the browser&rsquo;s own
                    picker, and Prio only ever receives the surface you picked.
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
/**
 * What was just captured, and the two or three things to do with it.
 *
 * One preview for both kinds of capture: a recording plays, a snip is shown
 * as a picture, and in each case the question is the same — is this the thing
 * you wanted, and shall it go on the work item? Upload and Cancel, with
 * Record Again offered for a recording because taking another is the common
 * answer to a recording that came out wrong, and making somebody close this
 * and find Recorder again is a screen for nothing.
 *
 * There is deliberately no Save, no Save as copy and no editing step between
 * here and the attachment. Marking a screenshot up is still possible — the
 * attachment's own Annotate opens the editor — but it is no longer in the way
 * of the ordinary case, which is capture, look, upload.
 */
function CapturePreview({
  capture,
  busy,
  onDiscard,
  onAttach,
  onRecordAgain,
}: {
  capture: Capture;
  busy: boolean;
  onDiscard: () => void;
  onAttach: () => void;
  /** Offered for a recording only; a snip's equivalent is New Snip. */
  onRecordAgain?: () => void;
}) {
  const url = useObjectUrl(capture.file);
  const isVideo = capture.file.type.startsWith("video/");

  return (
    <>
      <div className={styles.preview}>
        {url ? (
          isVideo ? (
            /* `autoPlay` is deliberately absent and `preload` deliberately
               present: the recording is cued at its beginning, ready to be
               played, rather than starting to talk the moment it appears. */
            <video src={url} controls preload="metadata" playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={`Snip: ${capture.file.name}`} />
          )
        ) : null}
      </div>

      <p className={styles.meta}>
        {capture.file.name} · {formatBytes(capture.file.size)}
        {capture.durationMs === undefined
          ? ""
          : ` · ${formatDuration(capture.durationMs)}`}
        {isVideo && capture.hasAudio === false ? (
          <span className={styles.warn}> · no sound was shared</span>
        ) : null}
      </p>

      <div className={styles.actions}>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onAttach}
          disabled={busy}
        >
          {busy ? "Uploading…" : "Upload"}
        </Button>
        {onRecordAgain ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRecordAgain}
            disabled={busy}
          >
            <IconClock size={13} />
            Record Again
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={busy}
        >
          <IconTrash size={13} />
          Cancel
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
