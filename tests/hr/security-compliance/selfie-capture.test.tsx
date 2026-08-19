/** @vitest-environment jsdom */
// HR-2B.3.2 §3 (2026-08-18) — SelfieCaptureFlow + PhotoUploadFields
// component tests.
//
// Exercises the state machine and DOM-side contract of the in-page
// camera capture flow WITHOUT a real camera. `navigator.mediaDevices`
// is mocked per case; jsdom does not implement getUserMedia or
// HTMLCanvasElement.toBlob, so both are stubbed in beforeEach.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import SelfieCaptureFlow from "@/app/hr/onboarding/about-you/photo/SelfieCaptureFlow";
import PhotoUploadFields from "@/app/hr/onboarding/about-you/photo/PhotoUploadFields";

// ---------------------------------------------------------------------------
// Test-only DOM shims.
// ---------------------------------------------------------------------------

/** Build a mock MediaStream with tracks whose `stop()` is a spy. */
function makeMockStream() {
  const stopSpy = vi.fn();
  const track: Partial<MediaStreamTrack> = {
    stop: stopSpy,
    kind: "video",
    readyState: "live",
    enabled: true,
    label: "mock-camera",
  };
  const tracks = [track as MediaStreamTrack];
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
    getAudioTracks: () => [],
    active: true,
    id: "mock-stream",
  } as unknown as MediaStream;
  return { stream, stopSpy };
}

/** Force HTMLVideoElement to report a stable size + resolve play(). */
function patchVideoElement() {
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => 320,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => 240,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  // jsdom doesn't allow `video.srcObject = stream` — force it to a
  // plain writable property.
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get() {
      return (this as unknown as { _srcObject?: unknown })._srcObject ?? null;
    },
    set(v: unknown) {
      (this as unknown as { _srcObject?: unknown })._srcObject = v;
    },
  });
}

/** Stub canvas so capturePhoto can produce a Blob in jsdom. */
function patchCanvasElement() {
  const fakeCtx = {
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(fakeCtx),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    writable: true,
    value(cb: BlobCallback) {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue("data:image/jpeg;base64,AAAA"),
  });
}

/** jsdom lacks DataTransfer — stub it so PhotoUploadFields can move
 *  the captured File onto its hidden `<input>`. */
class MockDataTransfer {
  private _items: File[] = [];
  items = {
    add: (file: File) => {
      this._items.push(file);
    },
  };
  get files(): FileList {
    const arr = this._items;
    // Duck-typed FileList — jsdom accepts arrays with .length + indices.
    const list = arr as unknown as FileList & { item?: (i: number) => File | null };
    (list as { item: (i: number) => File | null }).item = (i: number) => arr[i] ?? null;
    return list;
  }
}

function patchDataTransfer() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DataTransfer = MockDataTransfer;
}

/** jsdom's HTMLInputElement rejects writes to `files` — make it a
 *  writable property for the duration of the test. */
function patchInputFilesWritable() {
  Object.defineProperty(HTMLInputElement.prototype, "files", {
    configurable: true,
    get() {
      return (this as unknown as { _files?: FileList | null })._files ?? null;
    },
    set(v: FileList | null) {
      (this as unknown as { _files?: FileList | null })._files = v;
    },
  });
}

function mockGetUserMediaSuccess() {
  const { stream, stopSpy } = makeMockStream();
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia } as unknown as MediaDevices,
  });
  return { getUserMedia, stream, stopSpy };
}

function mockGetUserMediaRejects(errName: string) {
  const err = Object.assign(new Error(errName), { name: errName });
  const getUserMedia = vi.fn().mockRejectedValue(err);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia } as unknown as MediaDevices,
  });
  return { getUserMedia };
}

function removeMediaDevices() {
  // Simulate an ancient browser with no mediaDevices at all.
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
}

beforeEach(() => {
  patchVideoElement();
  patchCanvasElement();
  patchDataTransfer();
  patchInputFilesWritable();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// SelfieCaptureFlow — direct state-machine coverage.
// ---------------------------------------------------------------------------

describe("SelfieCaptureFlow", () => {
  it("permission granted → live preview shows video + Take/Cancel", async () => {
    const { getUserMedia } = mockGetUserMediaSuccess();
    const onAccept = vi.fn();
    render(<SelfieCaptureFlow onAccept={onAccept} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("photo-selfie-video")).toBeTruthy();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("photo-selfie-take-button")).toBeTruthy();
    expect(screen.getByTestId("photo-selfie-cancel-button")).toBeTruthy();
  });

  it("Take photo → captured still + Accept/Retake/Cancel buttons", async () => {
    mockGetUserMediaSuccess();
    const onAccept = vi.fn();
    render(<SelfieCaptureFlow onAccept={onAccept} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-video"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-take-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("photo-selfie-still")).toBeTruthy();
    });
    expect(screen.getByTestId("photo-selfie-accept-button")).toBeTruthy();
    expect(screen.getByTestId("photo-selfie-retake-button")).toBeTruthy();
    expect(screen.getByTestId("photo-selfie-cancel-button")).toBeTruthy();
  });

  it("Retake returns to live preview WITHOUT stopping the stream", async () => {
    const { stopSpy } = mockGetUserMediaSuccess();
    render(<SelfieCaptureFlow onAccept={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-video"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-take-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-still"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-retake-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("photo-selfie-video")).toBeTruthy();
    });
    // Stream MUST NOT have been stopped by Retake.
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("Cancel from live preview stops all tracks and returns to Idle", async () => {
    const { stopSpy } = mockGetUserMediaSuccess();
    render(<SelfieCaptureFlow onAccept={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-video"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-cancel-button"));
    });

    await waitFor(() => {
      // Back to Idle — the trigger button re-appears.
      expect(screen.getByTestId("photo-selfie-button")).toBeTruthy();
    });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("unmount while camera is live stops all tracks", async () => {
    const { stopSpy } = mockGetUserMediaSuccess();
    const { unmount } = render(<SelfieCaptureFlow onAccept={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-video"));

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("permission denied → renders permission-denied notice with retry + fallback hint", async () => {
    mockGetUserMediaRejects("NotAllowedError");
    render(<SelfieCaptureFlow onAccept={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("photo-selfie-permission-denied")).toBeTruthy();
    });
    // Fallback message names "Choose a photo" so the user knows the
    // native picker is still available.
    expect(
      screen.getByTestId("photo-selfie-permission-denied").textContent,
    ).toMatch(/Choose a photo/i);
  });

  it("no camera device → renders unsupported (no_device) notice", async () => {
    mockGetUserMediaRejects("NotFoundError");
    render(<SelfieCaptureFlow onAccept={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("photo-selfie-unsupported")).toBeTruthy();
    });
    expect(screen.getByTestId("photo-selfie-unsupported").textContent).toMatch(
      /No camera/i,
    );
  });

  it("mediaDevices API missing → renders unsupported (no_api) notice", async () => {
    removeMediaDevices();
    render(<SelfieCaptureFlow onAccept={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("photo-selfie-unsupported")).toBeTruthy();
    });
    expect(screen.getByTestId("photo-selfie-unsupported").textContent).toMatch(
      /doesn.?t support/i,
    );
  });
});

// ---------------------------------------------------------------------------
// PhotoUploadFields — accept-flow: capture reaches the hidden input +
// submits the enclosing form.
// ---------------------------------------------------------------------------

describe("PhotoUploadFields accept flow", () => {
  it("Use this photo → sets hidden photo input + calls form.requestSubmit", async () => {
    mockGetUserMediaSuccess();
    // Spy on requestSubmit at the prototype so any <form> render picks
    // up the spy.
    const requestSubmit = vi.fn();
    Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", {
      configurable: true,
      writable: true,
      value: requestSubmit,
    });

    render(
      <form
        data-testid="wrapper-form"
        onSubmit={(e) => e.preventDefault()}
      >
        <PhotoUploadFields />
      </form>,
    );

    // Enter the camera flow, take a photo, and accept it.
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-video"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-take-button"));
    });
    await waitFor(() => screen.getByTestId("photo-selfie-still"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-selfie-accept-button"));
    });

    // The hidden selfie input now carries a File.
    await waitFor(() => {
      const selfieInput = screen.getByTestId("photo-selfie-input") as HTMLInputElement;
      expect(selfieInput.files).not.toBeNull();
      expect(selfieInput.files?.length ?? 0).toBe(1);
      expect(selfieInput.files?.[0]?.name).toBe("selfie.jpg");
      expect(selfieInput.files?.[0]?.type).toBe("image/jpeg");
    });
    // And the enclosing form was submitted programmatically.
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});
