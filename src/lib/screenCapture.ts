/**
 * Capturing the screen: one frame, or a recording of it.
 *
 * Both sit on the browser's own screen-capture API, which is what makes the
 * Snip Tool possible without a native helper: the browser shows its own
 * picker for the screen, window or tab, and hands back a stream. Prio never
 * sees anything the person did not choose there.
 *
 * Everything that can go wrong here is something a person did or something a
 * browser lacks — they dismissed the picker, they denied permission, the
 * browser has no such API, the recording came back empty. None of those is a
 * fault worth an exception trace in a bug report, so each is reported as a
 * `CaptureError` carrying a `reason` the interface can act on and a sentence
 * it can show. Nothing here touches the Create form: a failed capture must
 * cost somebody their screenshot, never the issue they were writing.
 */

export type CaptureFailure =
  | "unsupported"
  | "denied"
  | "cancelled"
  | "empty"
  | "failed";

export class CaptureError extends Error {
  readonly reason: CaptureFailure;

  constructor(reason: CaptureFailure, message: string) {
    super(message);
    this.name = "CaptureError";
    this.reason = reason;
  }
}

/** Is screen capture available at all in this browser, in this context? */
export function canCaptureScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/** Is recording available? Capture plus a recorder to write it with. */
export function canRecordScreen(): boolean {
  return canCaptureScreen() && typeof window.MediaRecorder === "function";
}

/**
 * Dismissing the picker and refusing permission arrive as the same class of
 * error and differ only by name, so they are separated here — being told "you
 * denied permission" after deliberately pressing Cancel is confusing, and the
 * two need different advice.
 */
function asCaptureError(error: unknown): CaptureError {
  const name = error instanceof Error ? error.name : "";

  if (name === "NotAllowedError") {
    /* Chrome reports both the deliberate Cancel and a policy block this way.
       The message is the only thing that distinguishes them, and it is not
       stable, so the kinder reading is taken: assume they changed their mind. */
    return new CaptureError(
      "cancelled",
      "Screen capture was cancelled. Nothing has been attached.",
    );
  }
  if (name === "NotFoundError" || name === "NotSupportedError") {
    return new CaptureError(
      "unsupported",
      "This browser cannot capture the screen. You can attach a file instead.",
    );
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new CaptureError(
      "failed",
      "The screen could not be captured. Please try again.",
    );
  }
  return new CaptureError(
    "failed",
    "The screen could not be captured. Please try again.",
  );
}

/** Stops every track, which is what removes the browser's sharing indicator. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * What the browser's picker should lead with.
 *
 *   this-tab  the Prio tab itself — the browser offers it first ("share this
 *             tab"), which is what "capture this page" means;
 *   any       another tab, a window or a whole screen, with this tab left out
 *             of the list because it has its own choice.
 *
 * Both are hints. The picker is the browser's, the person still chooses in it,
 * and a browser that does not know a hint ignores it — which is why neither
 * can be used to capture anything the person did not pick.
 */
export type CaptureSource = "this-tab" | "any";

export interface CaptureOptions {
  source?: CaptureSource;
}

/** The newer picker hints, which not every DOM typing knows about yet. */
type DisplayMediaHints = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  controller?: unknown;
};

interface FocusController {
  setFocusBehavior?: (behavior: "focus-captured-surface" | "no-focus-change") => void;
}

async function requestDisplayStream(
  options: CaptureOptions = {},
): Promise<MediaStream> {
  if (!canCaptureScreen()) {
    throw new CaptureError(
      "unsupported",
      "This browser cannot capture the screen. You can attach a file instead.",
    );
  }

  const hints: DisplayMediaHints = { video: true, audio: false };
  if (options.source === "this-tab") {
    hints.video = { displaySurface: "browser" } as MediaTrackConstraints;
    hints.preferCurrentTab = true;
    hints.selfBrowserSurface = "include";
    hints.surfaceSwitching = "exclude";
  } else if (options.source === "any") {
    hints.selfBrowserSurface = "exclude";
  }

  /* Capturing another tab would normally switch the browser to it. A snip
     is one frame, taken for the Prio tab, so focus stays here where the
     capture is going — where the browser supports saying so. */
  const Controller = (globalThis as { CaptureController?: new () => FocusController })
    .CaptureController;
  const controller = options.source === "any" && Controller ? new Controller() : null;
  if (controller) hints.controller = controller;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(hints);
    try {
      controller?.setFocusBehavior?.("no-focus-change");
    } catch {
      /* Too late or unsupported: the browser simply keeps its default. */
    }
    return stream;
  } catch (error) {
    throw asCaptureError(error);
  }
}

/**
 * One frame of whatever the person chose to share, as a PNG.
 *
 * The stream is opened, a single frame is drawn, and the stream is stopped
 * immediately — the sharing indicator should not outlive the snap. PNG
 * because this is a screenshot destined for annotation: lossless, and the
 * format the editor and the upload allowlist already expect.
 */
export async function captureScreenshot(
  options: CaptureOptions = {},
): Promise<Blob> {
  const stream = await requestDisplayStream(options);

  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    await video.play();

    /* One rendered frame. Without this the first frame is occasionally blank:
       `play()` resolves when playback starts, not when there is a painted
       picture to copy. */
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      throw new CaptureError(
        "empty",
        "The capture came back empty. Please try again.",
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new CaptureError("failed", "The screenshot could not be prepared.");
    }
    context.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!blob || blob.size === 0) {
      throw new CaptureError(
        "empty",
        "The capture came back empty. Please try again.",
      );
    }

    return blob;
  } finally {
    stopStream(stream);
  }
}

export interface ScreenRecording {
  blob: Blob;
  /** How long it ran, measured here rather than read back from the file. */
  durationMs: number;
  /** The container actually produced, for naming the attachment. */
  mimeType: string;
}

export interface ActiveRecording {
  /** Ends the recording and resolves with it. */
  stop: () => Promise<ScreenRecording>;
  /** Abandons it, keeping nothing. */
  cancel: () => void;
}

/**
 * The container to record into.
 *
 * WebM is what browsers that can record produce, and it is on Prio's upload
 * allowlist. The list is tried in order and the first supported entry wins;
 * an empty string lets the browser choose, which is the correct last resort
 * rather than a failure.
 */
const RECORDING_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function preferredRecordingType(): string {
  for (const type of RECORDING_TYPES) {
    if (window.MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/**
 * Starts recording the screen, and hands back the two ways it can end.
 *
 * The promise returned by `stop` is what carries the result, so a caller
 * awaits one thing rather than subscribing to events. Two endings are handled
 * that a caller cannot see coming: the recorder erroring mid-way, and the
 * person ending the share from the browser's own "Stop sharing" bar — the
 * second is not an error at all and produces the recording made so far.
 */
export async function startScreenRecording(): Promise<ActiveRecording> {
  if (!canRecordScreen()) {
    throw new CaptureError(
      "unsupported",
      "This browser cannot record the screen. You can attach a video file instead.",
    );
  }

  const stream = await requestDisplayStream();

  let recorder: MediaRecorder;
  try {
    const mimeType = preferredRecordingType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stopStream(stream);
    throw new CaptureError(
      "unsupported",
      "This browser cannot record the screen. You can attach a video file instead.",
    );
  }

  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let settled = false;

  let resolveStop: ((recording: ScreenRecording) => void) | null = null;
  let rejectStop: ((error: unknown) => void) | null = null;

  const finished = new Promise<ScreenRecording>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onerror = () => {
    if (settled) return;
    settled = true;
    stopStream(stream);
    rejectStop?.(
      new CaptureError("failed", "The recording failed. Nothing was attached."),
    );
  };

  recorder.onstop = () => {
    if (settled) return;
    settled = true;
    stopStream(stream);

    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    if (blob.size === 0) {
      rejectStop?.(
        new CaptureError(
          "empty",
          "That recording was empty. Nothing was attached.",
        ),
      );
      return;
    }

    resolveStop?.({
      blob,
      durationMs: Date.now() - startedAt,
      mimeType: recorder.mimeType || "video/webm",
    });
  };

  /* Ending the share from the browser's own bar is a legitimate way to
     finish, not a fault. The recorder is asked to stop, and its `onstop`
     produces the recording exactly as the button would have. */
  for (const track of stream.getVideoTracks()) {
    track.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop();
    });
  }

  /* A timeslice, so data is delivered as it goes rather than only at the end.
     A recording that ends unexpectedly then still has everything up to that
     moment instead of nothing at all. */
  recorder.start(1000);

  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
      return finished;
    },
    cancel: () => {
      settled = true;
      if (recorder.state !== "inactive") recorder.stop();
      stopStream(stream);
    },
  };
}

/** `PT1M04S` is nobody's idea of a caption. `1:04` is. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
