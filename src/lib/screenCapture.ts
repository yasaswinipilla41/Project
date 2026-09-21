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
  /**
   * Ask the browser for sound as well as pictures.
   *
   * A recording of a walkthrough with the narration missing is half a
   * recording, so the recorder asks — but only asks. What arrives depends on
   * the surface somebody picks and on the permission they give: a browser tab
   * can usually share its own audio, a whole screen often cannot, and a
   * refusal here is not a failure of the capture. See `startScreenRecording`,
   * which reports what it actually got.
   */
  audio?: boolean;
  /**
   * Keep the pointer in the picture where the browser can.
   *
   * A recording made to show somebody where to click is worth much less
   * without the cursor in it. `cursor: "always"` is a hint: a browser that
   * does not implement it ignores it, and nothing here depends on it.
   */
  cursor?: boolean;
}

/** The newer picker hints, which not every DOM typing knows about yet. */
type DisplayMediaHints = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  controller?: unknown;
};

/** `cursor` is a display capture constraint the DOM typings do not carry. */
type CursorHint = MediaTrackConstraints & { cursor?: "always" | "motion" | "never" };

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

  const hints: DisplayMediaHints = { video: true, audio: options.audio === true };
  if (options.source === "this-tab") {
    hints.video = { displaySurface: "browser" } as MediaTrackConstraints;
    hints.preferCurrentTab = true;
    hints.selfBrowserSurface = "include";
    hints.surfaceSwitching = "exclude";
  } else if (options.source === "any") {
    hints.selfBrowserSurface = "exclude";
  }

  /* Asked for on top of whatever the source already decided, so a recording
     shows where the pointer went. Merged rather than assigned: `this-tab`
     has already put a constraints object here. */
  if (options.cursor) {
    const video: CursorHint =
      typeof hints.video === "object" && hints.video !== null
        ? { ...(hints.video as MediaTrackConstraints) }
        : {};
    video.cursor = "always";
    hints.video = video;
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
    return await frameFrom(await playing(stream));
  } finally {
    stopStream(stream);
  }
}

/** A video element playing the stream, with a painted frame ready to copy. */
async function playing(stream: MediaStream): Promise<HTMLVideoElement> {
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

  return video;
}

/**
 * Whatever the video is showing right now, as a PNG.
 *
 * The canvas is the source's own pixel dimensions — `videoWidth` and
 * `videoHeight` are the physical resolution the browser is sharing, not a CSS
 * size — so nothing here scales the picture. PNG because a screenshot is going
 * to be annotated: lossless, and the format the editor and the upload
 * allowlist already expect.
 */
async function frameFrom(video: HTMLVideoElement): Promise<Blob> {
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
}

/**
 * A capture source chosen once and kept, so several snips can come from it.
 *
 * `captureScreenshot` opens the browser's picker, takes one frame and stops —
 * right for "this tab", and wrong for anything else: choosing another tab or
 * window would ask the picker again for every snip, and the person would have
 * to re-find their window each time. Worse, the thing they wanted to capture is
 * usually something they have to *navigate to first*, which the one-shot
 * version gives them no opportunity to do.
 *
 * So the stream is kept alive and sampled on demand. The picker appears once,
 * when the source is chosen; after that the person goes wherever they need to
 * and presses New snip, and `grab` copies whatever that surface is showing at
 * that moment.
 *
 * Nothing here reaches into the chosen surface. It is a `MediaStream` the
 * browser handed over because somebody picked it in the browser's own dialog —
 * there is no DOM access, no script injection and no way to capture anything
 * that was not chosen. `onEnded` is how the browser's "Stop sharing" bar gets
 * to end it, which it can do at any time.
 */
export interface RetainedSource {
  /** What the browser calls the shared surface, for saying so on screen. */
  label: string;
  /** One frame of it, as it looks now. */
  grab: () => Promise<Blob>;
  /** Ends the share, and with it the browser's sharing indicator. */
  stop: () => void;
  /** Called if the browser or the person ends the share first. */
  onEnded: (handler: () => void) => void;
}

export async function retainCaptureSource(
  options: CaptureOptions = {},
): Promise<RetainedSource> {
  const stream = await requestDisplayStream(options);

  let video: HTMLVideoElement;
  try {
    video = await playing(stream);
  } catch (error) {
    /* Nothing keeps sharing on account of a failure to start reading it. */
    stopStream(stream);
    throw error instanceof CaptureError ? error : asCaptureError(error);
  }

  const track = stream.getVideoTracks()[0] ?? null;

  return {
    label: track?.label || "the chosen tab or window",
    grab: () => frameFrom(video),
    stop: () => {
      video.srcObject = null;
      stopStream(stream);
    },
    onEnded: (handler) => {
      track?.addEventListener("ended", handler, { once: true });
    },
  };
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
  /**
   * Whether this browser's recorder can pause at all.
   *
   * `pause` and `resume` are optional in the MediaRecorder specification, so
   * this is read from the object rather than assumed. A caller that finds it
   * false should not offer the control, because there is nothing honest to put
   * behind it — see `pause` below.
   */
  canPause: boolean;
  /** Stops writing without ending the recording. False if it could not. */
  pause: () => boolean;
  /** Starts writing again after `pause`. False if it could not. */
  resume: () => boolean;
  /** Whether it is paused right now, asked of the recorder itself. */
  isPaused: () => boolean;
  /**
   * Whether sound is actually being recorded.
   *
   * Asked of the stream rather than of what was requested: a tab usually
   * shares its audio, a whole screen usually cannot, and somebody can untick
   * the box in the picker. The caller uses this to say so plainly instead of
   * producing a silent file that looks like a fault.
   */
  hasAudio: boolean;
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

  /*
   * Another tab, a window or a screen — never this tab.
   *
   * Prio's recording controls are part of the Prio page, so if the page itself
   * is the surface being captured, the controls are captured with it: the
   * compositor records the rendered surface and no amount of z-index, portal
   * or stacking context can opt an element out of it. Leaving this tab out of
   * the picker is therefore the only thing that actually keeps the toolbar out
   * of the file, and it is what `selfBrowserSurface: "exclude"` asks for.
   *
   * It is not absolute, and the limit is the browser's rather than ours: the
   * picker always offers whole screens, and a screen containing the Prio
   * window contains the toolbar too. That case cannot be excluded from inside
   * the page, and is documented rather than papered over.
   */
  const stream = await requestDisplayStream({
    source: "any",
    /* A walkthrough without its narration is half a recording, and one
       without the pointer is hard to follow. Both are asked for; neither is
       required, and `hasAudio` below reports what was actually shared. */
    audio: true,
    cursor: true,
  });

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

  /*
   * Time spent paused, so the duration reported matches the footage.
   *
   * A paused recorder writes nothing, so wall-clock from start to stop counts
   * time that is not in the file. The attachment would then claim a length the
   * video does not have, and the player would disagree with the label beside
   * it. Each pause adds its own span here and `stop` subtracts the total.
   */
  let pausedMs = 0;
  let pausedAt: number | null = null;

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

    if (pausedAt !== null) {
      pausedMs += Date.now() - pausedAt;
      pausedAt = null;
    }

    resolveStop?.({
      blob,
      durationMs: Math.max(0, Date.now() - startedAt - pausedMs),
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

  const canPause =
    typeof recorder.pause === "function" && typeof recorder.resume === "function";

  return {
    canPause,
    /* What the browser actually handed over, not what was asked for. */
    hasAudio: stream.getAudioTracks().length > 0,
    isPaused: () => recorder.state === "paused",
    pause: () => {
      if (!canPause || recorder.state !== "recording") return false;
      recorder.pause();
      /* Re-read as a plain string: the guard above narrowed `state` to
         "recording", and the call that just changed it is invisible to that
         narrowing. Only the pause the recorder actually accepted is counted. */
      const after: string = recorder.state;
      if (after === "paused") {
        pausedAt = Date.now();
        return true;
      }
      return false;
    },
    resume: () => {
      if (!canPause || recorder.state !== "paused") return false;
      recorder.resume();
      const after: string = recorder.state;
      if (after === "recording") {
        if (pausedAt !== null) pausedMs += Date.now() - pausedAt;
        pausedAt = null;
        return true;
      }
      return false;
    },
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
