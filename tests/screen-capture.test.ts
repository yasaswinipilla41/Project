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
