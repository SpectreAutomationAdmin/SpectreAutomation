// EP-TRAIN-4A §1 (2026-10-30) — unit tests for the video-upload
// progress/ETA calculation.  Browser-driven byte-based progress is
// covered by the Playwright staging spec; this suite covers the pure
// `computeEtaSeconds` function.

import { describe, it, expect } from "vitest";
import { computeEtaSeconds } from "../src/app/app/admin/people/safety-training/[courseId]/[versionId]/VideoUploader";

describe("EP-TRAIN-4A :: computeEtaSeconds", () => {
  it("returns null before 1s of real transfer has elapsed", () => {
    expect(computeEtaSeconds(1_000_000, 10_000_000, 500, 2_000_000)).toBeNull();
  });

  it("returns null before 2% of the file has transferred", () => {
    expect(computeEtaSeconds(100_000, 100_000_000, 5_000, 2_000_000)).toBeNull();
  });

  it("returns null when bytesPerSecond is unknown", () => {
    expect(computeEtaSeconds(5_000_000, 10_000_000, 5_000, null)).toBeNull();
  });

  it("returns 0 when the transfer is complete", () => {
    expect(computeEtaSeconds(10_000_000, 10_000_000, 5_000, 2_000_000)).toBe(0);
  });

  it("returns remaining bytes / throughput once enough data is in", () => {
    // 5 MB transferred of 10 MB at 2 MB/s → 5 MB / 2 MB/s = 2.5s
    const eta = computeEtaSeconds(5_000_000, 10_000_000, 2_500, 2_000_000);
    expect(eta).toBeCloseTo(2.5, 2);
  });

  it("respects larger file sizes (streaming over slow throughput)", () => {
    // 20 MB of 100 MB at 500 KB/s → 80 MB / 500 KB/s = 160s
    const eta = computeEtaSeconds(20_000_000, 100_000_000, 40_000, 500_000);
    expect(eta).toBeCloseTo(160, 1);
  });

  it("returns null when totalBytes is zero or non-finite", () => {
    expect(computeEtaSeconds(0, 0, 10_000, 1_000_000)).toBeNull();
    expect(computeEtaSeconds(100, Number.NaN, 10_000, 1_000_000)).toBeNull();
  });
});
