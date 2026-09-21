import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canCaptureScreen,
  canRecordScreen,
  CaptureError,
  captureScreenshot,
  formatDuration,
  startScreenRecording,
} from "@/lib/screenCapture";

/**
 * Screen capture, and the ways it declines.
 *
 * The interesting behaviour here is not the happy path — a browser either
 * hands back a stream or it does not. It is that every refusal arrives as a
 * `CaptureError` carrying a reason, because the Create form has to tell a
 * dismissed picker apart from a browser that cannot do this at all, and must
 * never surface either as a crash that costs somebody their draft.
 *
 * The browser APIs are absent under Node, which is exactly what makes the
 * unsupported paths testable without a DOM; the rest are driven by standing
 * in a `getDisplayMedia` that rejects the way a real one would.
 */

const originalNavigator = globalThis.navigator;
const originalWindow = globalThis.window;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalNavigator) vi.stubGlobal("navigator", originalNavigator);
  if (originalWindow) vi.stubGlobal("window", originalWindow);
  vi.unstubAllGlobals();
});

/** A navigator whose `getDisplayMedia` fails the way `name` describes. */
function navigatorRejecting(name: string) {
  const error = new Error("denied");
  error.name = name;
  return {
    mediaDevices: {
      getDisplayMedia: vi.fn().mockRejectedValue(error),
    },
  };
}

describe("knowing what the browser can do", () => {
  it("reports capture unavailable when there is no such API", () => {
    vi.stubGlobal("navigator", {});
    expect(canCaptureScreen()).toBe(false);
  });

  it("reports capture available when the API is present", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: () => undefined },
    });
    expect(canCaptureScreen()).toBe(true);
  });

  it("reports recording unavailable without a recorder, even with capture", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: () => undefined },
    });
    vi.stubGlobal("window", {});
    expect(canRecordScreen()).toBe(false);
  });

  it("reports recording available with both halves present", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: () => undefined },
    });
    vi.stubGlobal("window", { MediaRecorder: function () {} });
    expect(canRecordScreen()).toBe(true);
  });
});

describe("refusing to capture", () => {
  it("says so plainly when the browser has no capture API", async () => {
    vi.stubGlobal("navigator", {});

    await expect(captureScreenshot()).rejects.toMatchObject({
      name: "CaptureError",
      reason: "unsupported",
    });
  });

  it("treats a dismissed picker as a cancellation, not a denial", async () => {
    vi.stubGlobal("navigator", navigatorRejecting("NotAllowedError"));

    const failure = await captureScreenshot().catch((error) => error);
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure.reason).toBe("cancelled");
    // The wording must not accuse somebody of denying permission when they
    // simply changed their mind.
    expect(failure.message).toContain("cancelled");
  });

  it("reports an unavailable source as unsupported", async () => {
    vi.stubGlobal("navigator", navigatorRejecting("NotFoundError"));

    const failure = await captureScreenshot().catch((error) => error);
    expect(failure.reason).toBe("unsupported");
  });

  it("reports an unreadable source as a plain failure", async () => {
    vi.stubGlobal("navigator", navigatorRejecting("NotReadableError"));

    const failure = await captureScreenshot().catch((error) => error);
    expect(failure.reason).toBe("failed");
  });

  it("never throws anything but a CaptureError", async () => {
    vi.stubGlobal("navigator", navigatorRejecting("SomethingNobodyHasHeardOf"));

    const failure = await captureScreenshot().catch((error) => error);
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure.reason).toBe("failed");
  });
});

describe("refusing to record", () => {
  it("says so when there is no recorder", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: () => undefined },
    });
    vi.stubGlobal("window", {});

    const failure = await startScreenRecording().catch((error) => error);
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure.reason).toBe("unsupported");
  });

  it("carries a cancelled picker through as a cancellation", async () => {
    vi.stubGlobal("navigator", navigatorRejecting("NotAllowedError"));
    vi.stubGlobal("window", {
      MediaRecorder: Object.assign(function () {}, {
        isTypeSupported: () => true,
      }),
    });

    const failure = await startScreenRecording().catch((error) => error);
    expect(failure.reason).toBe("cancelled");
  });
});

describe("stating how long a recording ran", () => {
  it("reads as a clock, not a duration format", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(6_000)).toBe("0:06");
    expect(formatDuration(64_000)).toBe("1:04");
    expect(formatDuration(600_000)).toBe("10:00");
  });

  it("does not produce a negative clock", () => {
    expect(formatDuration(-5_000)).toBe("0:00");
  });
});

/**
 * Pausing, and the clock it has to keep honest.
 *
 * A paused recorder writes nothing, so a duration measured from start to stop
 * counts time that is not in the file. The attachment would then claim a
 * length the video does not have. These drive a stand-in recorder rather than
 * a real one, because what is being checked is the bookkeeping around it.
 */
describe("pausing a recording", () => {
  /** A MediaRecorder stand-in that honours state the way the real one does. */
  function recorderStub(options: { pausable: boolean }) {
    const listeners: Record<string, () => void> = {};
    const instance = {
      state: "inactive" as string,
      mimeType: "video/webm",
      ondataavailable: null as ((e: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      onerror: null as (() => void) | null,
      start(_slice?: number) {
        instance.state = "recording";
        void _slice;
      },
      stop() {
        instance.state = "inactive";
        instance.ondataavailable?.({ data: new Blob(["x"]) });
        instance.onstop?.();
      },
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      ...(options.pausable
        ? {
            pause() {
              instance.state = "paused";
            },
            resume() {
              instance.state = "recording";
            },
          }
        : {}),
    };
    return instance;
  }

  function stubEnvironment(recorder: ReturnType<typeof recorderStub>) {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      /* A real MediaStream always answers this. The double did not, and the
         moment the recorder started reporting whether sound was actually
         shared, the gap showed up here rather than in a browser. No audio
         track: this stub shares a picture only. */
      getAudioTracks: () => [],
    };

    const Recorder = function () {
      return recorder;
    } as unknown as {
      new (): unknown;
      isTypeSupported: (t: string) => boolean;
    };
    Recorder.isTypeSupported = () => true;

    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal("window", { MediaRecorder: Recorder });
    vi.stubGlobal("MediaRecorder", Recorder);
  }

  it("is offered only when the recorder implements it", async () => {
    stubEnvironment(recorderStub({ pausable: false }));
    const active = await startScreenRecording();

    expect(active.canPause).toBe(false);
    // And the controls refuse rather than pretending they worked.
    expect(active.pause()).toBe(false);
    expect(active.isPaused()).toBe(false);
  });

  it("pauses and resumes, reporting what the recorder actually did", async () => {
    stubEnvironment(recorderStub({ pausable: true }));
    const active = await startScreenRecording();

    expect(active.canPause).toBe(true);
    expect(active.pause()).toBe(true);
    expect(active.isPaused()).toBe(true);
    // Pausing twice is not a second pause.
    expect(active.pause()).toBe(false);

    expect(active.resume()).toBe(true);
    expect(active.isPaused()).toBe(false);
    expect(active.resume()).toBe(false);
  });

  it("leaves the paused time out of the duration it reports", async () => {
    vi.useFakeTimers();
    try {
      stubEnvironment(recorderStub({ pausable: true }));
      const active = await startScreenRecording();

      vi.advanceTimersByTime(1_000); // recording
      active.pause();
      vi.advanceTimersByTime(5_000); // paused: not in the file
      active.resume();
      vi.advanceTimersByTime(1_000); // recording

      const result = await active.stop();

      /* Two seconds of footage across seven seconds of wall clock. The
         tolerance is for the timer, not for the arithmetic. */
      expect(result.durationMs).toBeGreaterThanOrEqual(1_900);
      expect(result.durationMs).toBeLessThan(2_600);
    } finally {
      vi.useRealTimers();
    }
  });
});
