// EP-TRAIN-4Y-H §4 regression — makeSignedTrainingVideoUrl must pass
// `{clubId: string}` to resolveDocumentStorage, NOT the raw string.
//
// The bug (addd3904 and earlier): the caller passed `input.clubId` as
// the args parameter to `resolveDocumentStorage(args: { clubId })`,
// so inside the closure `args.clubId` was undefined (a string has no
// `.clubId` property), which caused the S3 adapter's signUrl to
// prepend "clubs/undefined/" to the presigned URL path. R2 responded
// 404 on every Modal transcription attempt.
//
// This test enforces the call shape by mocking resolveDocumentStorage
// and asserting it was called with an object carrying the real clubId.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaFind, resolve, signUrlFn } = vi.hoisted(() => ({
  prismaFind: vi.fn(),
  resolve: vi.fn(),
  signUrlFn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { trainingCourseVersion: { findUnique: prismaFind } },
}));

vi.mock("@/lib/documents/storage", () => ({
  resolveDocumentStorage: resolve,
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: () => {}, error: () => {}, warn: () => {} },
}));

import { makeSignedTrainingVideoUrl } from "../src/lib/hr/training/video-signed-url";

describe("EP-TRAIN-4Y-H §4 — makeSignedTrainingVideoUrl regression", () => {
  beforeEach(() => {
    prismaFind.mockReset();
    resolve.mockReset();
    signUrlFn.mockReset();
  });

  it("passes `{clubId}` as an object to resolveDocumentStorage (not the raw string)", async () => {
    const CLUB_ID = "club_x";
    const VERSION_ID = "ver_x";
    const STORAGE_KEY = "clubs/club_x/training/ver_x/1/abc";

    prismaFind.mockResolvedValue({
      id: VERSION_ID,
      videoStorageKey: STORAGE_KEY,
      course: { clubId: CLUB_ID },
    });

    signUrlFn.mockResolvedValue("https://signed.example.com/path?X-Amz-Signature=xxx");
    resolve.mockResolvedValue({ signUrl: signUrlFn });

    const url = await makeSignedTrainingVideoUrl({
      clubId: CLUB_ID,
      courseVersionId: VERSION_ID,
      ttlSec: 600,
    });

    // The regression: resolveDocumentStorage must receive {clubId: "club_x"},
    // not the string "club_x".
    expect(resolve).toHaveBeenCalledTimes(1);
    const arg = resolve.mock.calls[0][0];
    expect(typeof arg).toBe("object");
    expect(arg).not.toBe("club_x");                 // NOT the raw string
    expect(arg.clubId).toBe(CLUB_ID);               // object carries clubId

    // signUrl itself was called with the raw storageKey + ttlSec per the
    // adapter wrapper contract.
    expect(signUrlFn).toHaveBeenCalledWith(STORAGE_KEY, 600);
    expect(url).toContain("https://signed");
  });

  it("refuses cross-tenant versions (same-shape 404)", async () => {
    prismaFind.mockResolvedValue({
      id: "ver_y",
      videoStorageKey: "clubs/attacker/training/x/1/abc",
      course: { clubId: "club_attacker" },
    });
    await expect(
      makeSignedTrainingVideoUrl({
        clubId: "club_rightful",
        courseVersionId: "ver_y",
        ttlSec: 600,
      }),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses versions with no videoStorageKey", async () => {
    prismaFind.mockResolvedValue({
      id: "ver_z",
      videoStorageKey: null,
      course: { clubId: "club_x" },
    });
    await expect(
      makeSignedTrainingVideoUrl({
        clubId: "club_x",
        courseVersionId: "ver_z",
        ttlSec: 600,
      }),
    ).rejects.toThrow();
  });
});
