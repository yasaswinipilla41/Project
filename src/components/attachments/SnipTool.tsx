"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  IconClose,
  IconEdit,
  IconImage,
  IconTrash,
} from "@/components/ui/Icon";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";
import { formatBytes } from "@/lib/attachments";
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
 * Capturing a screen is not a single click — it is a small session. You take
 * a shot, look at it, mark it up, maybe take another, and in the middle of
 * that you often need to go and look at something else in Prio to work out
 * what to write. A dropdown cannot survive any of that: it closes on the
 * first click elsewhere and takes the capture with it.
 *
 * So this is a window. It is mounted once, by the application shell, which in
 * the App Router sits outside the routed content and is therefore not
 * unmounted when the page changes. That one placement is what makes every
 * persistence requirement fall out for free: moving between pages, minimising
 * it, or opening a dialog on top of it are all just renders of a component
 * that was never torn down. Nothing is serialised, nothing is restored,
 * because nothing was lost.
 *
 * What it will not do is decide where a capture belongs. It holds the bytes
 * and a `target` describing what asked for them, and the surface that asked
 * supplies the function that consumes them. A capture taken for one issue can
 * therefore never be attached to another: the target is fixed when the window
 * is opened and checked again when it is delivered.
 */

/** Where a finished capture is going. */
export type SnipTarget =
  | { kind: "draft"; label: string }
  | { kind: "issue"; issueId: string; label: string };

/** What a capture carries besides its bytes. */
export interface SnipMeta {
  /** Recordings only, so a staged row can say how long one runs. */
  durationMs?: number;
}

/** What a surface hands over so a capture can reach it. */
type Receiver = (file: File, meta: SnipMeta) => Promise<void> | void;

interface Capture {
  file: File;
  /** Recordings only, so the window can say how long one runs. */
  durationMs?: number;
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

const SnipToolContext = createContext<SnipToolValue | null>(null);

/** The Snip Tool, for a surface that wants to offer it. */
export function useSnipTool(): SnipToolValue {
  const value = useContext(SnipToolContext);
  if (!value) {
    throw new Error("useSnipTool must be used inside SnipToolProvider");
  }
  return value;
}

/**
 * Offers the Snip Tool to a surface, and keeps it reachable while mounted.
 *
 * The receiver is registered for as long as the surface exists, so a capture
 * taken while the user was elsewhere is delivered the moment they come back —
 * the window holds it until then rather than guessing.
 */
export function useSnipReceiver(
  target: SnipTarget | null,
  receive: Receiver,
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

  const key = target
    ? target.kind === "issue"
      ? `issue:${target.issueId}`
      : `draft:${target.label}`
    : null;

  useEffect(() => {
    if (!snip || !target || !key) return;
    return snip.register(target, (file, meta) => receiveRef.current(file, meta));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snip, key]);

  return {
    openSnipTool: (start?: SnipAction) => {
      if (snip && target) snip.open(target, start);
    },
    available: Boolean(snip) && (canCaptureScreen() || canRecordScreen()),
  };
}

export function SnipToolProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();

  const [target, setTarget] = useState<SnipTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);

  const [capture, setCapture] = useState<Capture | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"screenshot" | "record" | "attach" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  /* What is held, readable from `open` without making `open` depend on it. */
  const captureRef = useRef<Capture | null>(null);

  /*
   * Starting a capture, reached through a ref.
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

  /* Receivers by target key. A surface registers while it is mounted; the
     window looks one up only when it is actually delivering. */
  const receivers = useRef(new Map<string, Receiver>());

  const keyOf = (t: SnipTarget) =>
    t.kind === "issue" ? `issue:${t.issueId}` : `draft:${t.label}`;

  const register = useCallback((t: SnipTarget, receive: Receiver) => {
    const key = keyOf(t);
    receivers.current.set(key, receive);
    return () => {
      // Only remove the registration still owned by this surface.
      if (receivers.current.get(key) === receive) receivers.current.delete(key);
    };
  }, []);

  const openFor = useCallback(
    (t: SnipTarget, start?: SnipAction) => {
      setTarget((current) => {
        /* Re-opening for a different target while a capture is still held
           would be the one way a shot could reach the wrong issue. The capture
           is cleared rather than carried across. */
        if (current && keyOf(current) !== keyOf(t)) {
          setCapture(null);
          setError(null);
        }
        return t;
      });
      setOpen(true);
      setMinimized(false);

      // Opening straight into a capture, for the menu entries that name one.
      if (start) startCapture.current(start);
    },
    [],
  );

  const close = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setRecording(false);
    setOpen(false);
    setMinimized(false);
    setCapture(null);
    setEditing(false);
    setError(null);
  }, []);

  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  useEffect(() => {
    startCapture.current = (action) => {
      /* Not while something is already held: a second press should bring the
         window back to the capture waiting there, never take a new one over
         the top of it. */
      if (captureRef.current || recordingRef.current) return;
      if (action === "screenshot") void takeScreenshot();
      else void beginRecording();
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

  const nameFor = (extension: string) =>
    `${extension === ".webm" ? "recording" : "screenshot"}-${Date.now()
      .toString(36)
      .slice(-4)}${extension}`;

  async function takeScreenshot() {
    setError(null);
    setBusy("screenshot");
    /* Minimised while the browser's own picker is up, so the window is not
       sitting over the very screen being chosen. */
    setMinimized(true);
    try {
      const blob = await captureScreenshot();
      setCapture({
        file: new File([blob], nameFor(".png"), { type: "image/png" }),
      });
      setEditing(true);
    } catch (failure) {
      setError(
        failure instanceof CaptureError
          ? failure.message
          : "The screen could not be captured.",
      );
    } finally {
      // Back in view either way: to show the capture, or to explain the refusal.
      setMinimized(false);
      setBusy(null);
    }
  }

  async function beginRecording() {
    setError(null);
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
   * Hands the capture to whatever asked for it.
   *
   * Delivered once and then dropped, which is what stops a second press —
   * or a restore, or a re-open — from attaching the same thing twice. If the
   * surface is not mounted, nothing is delivered and the capture stays put
   * until it is.
   */
  async function attach() {
    if (!capture || !target) return;
    const receive = receivers.current.get(keyOf(target));

    if (!receive) {
      setError(
        target.kind === "draft"
          ? "Open the form you were filling in, and this will attach to it."
          : "Open that issue again, and this will attach to it.",
      );
      return;
    }

    setBusy("attach");
    try {
      await receive(capture.file, { durationMs: capture.durationMs });
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

  return (
    <SnipToolContext.Provider value={value}>
      {children}

      {/* Stood down while the editor is up: the editor is a full modal, and
          this window sits above modals so that a capture stays visible over
          the Create dialog. Both on screen at once would only overlap. */}
      {open && !editing ? (
        <div
          className={styles.window}
          data-minimized={minimized || undefined}
          role="dialog"
          aria-label="Snip Tool"
          /* Not a modal: the whole point is that the rest of Prio stays
             usable while this is open. */
          aria-modal="false"
        >
          <div className={styles.bar}>
            <span className={styles.title}>
              <IconImage size={14} />
              Snip Tool
            </span>
            <span className={styles.target}>{target?.label}</span>

            <button
              type="button"
              className={styles.control}
              aria-label={
                minimized ? "Restore Snip Tool" : "Minimise Snip Tool"
              }
              title={minimized ? "Restore" : "Minimise"}
              onClick={() => setMinimized((m) => !m)}
            >
              <span className={styles.glyph} aria-hidden>
                {minimized ? "▣" : "—"}
              </span>
            </button>
            <button
              type="button"
              className={styles.control}
              /* Closing is the way to throw a capture away, so it says so
                 while there is one to lose. Minimise is the control for
                 getting it out of the way. */
              aria-label={
                capture ? "Discard capture and close Snip Tool" : "Close Snip Tool"
              }
              title={capture ? "Discard and close" : "Close"}
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
                  onEdit={() => setEditing(true)}
                  onDiscard={() => {
                    setCapture(null);
                    setError(null);
                  }}
                  onAttach={() => void attach()}
                />
              ) : (
                <>
                  <p className={styles.hint}>
                    Capture a screen, a window or a tab. It stays here while you
                    look around Prio, and attaches when you are ready.
                  </p>
                  <div className={styles.actions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!captureSupported || busy !== null}
                      onClick={() => void takeScreenshot()}
                    >
                      {busy === "screenshot" ? "Capturing…" : "New snip"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!recordSupported || busy !== null}
                      onClick={() => void beginRecording()}
                    >
                      Record
                    </Button>
                  </div>
                  {!captureSupported && !recordSupported ? (
                    <p className={styles.error}>
                      This browser cannot capture the screen. Use Browse to
                      attach a file instead.
                    </p>
                  ) : null}
                </>
              )}

              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {editing && capture && capture.file.type.startsWith("image/") ? (
        <ScreenshotEditor
          open
          source={capture.file}
          onCancel={() => setEditing(false)}
          onSave={(blob) => {
            /* Written over the capture being held, so marking one up does
               not turn it into two. */
            setCapture((current) =>
              current
                ? {
                    ...current,
                    file: new File([blob], current.file.name, {
                      type: blob.type || "image/png",
                    }),
                  }
                : current,
            );
            setEditing(false);
          }}
        />
      ) : null}
    </SnipToolContext.Provider>
  );
}

/** The held capture, with the three things that can be done to it. */
function CapturePreview({
  capture,
  busy,
  onEdit,
  onDiscard,
  onAttach,
}: {
  capture: Capture;
  busy: boolean;
  onEdit: () => void;
  onDiscard: () => void;
  onAttach: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(capture.file);
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
      URL.revokeObjectURL(next);
    };
  }, [capture.file]);

  const isImage = capture.file.type.startsWith("image/");

  return (
    <>
      <div className={styles.preview}>
        {url && isImage ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={url} alt="The capture waiting to be attached" />
        ) : url ? (
          <video src={url} controls preload="metadata" playsInline />
        ) : null}
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
        {isImage ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onEdit}
            disabled={busy}
          >
            <IconEdit size={13} />
            Annotate
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
          Discard
        </Button>
      </div>
    </>
  );
}
