// EP-TRAIN-1 §B (2026-10-29) — HTTP Range + streaming delivery for
// training videos.
//
// Replaces the prior `readTrainingVideoBytes` buffer-the-whole-thing
// path with a Cloudflare-R2 ranged GetObject that streams through to
// the HTTP response.  No new paid provider.  No new infra.  The
// upload path + schema + authorization remain unchanged.
//
// What this fixes vs the prior proxy:
//   - First byte arrives in O(1) R2-roundtrip time, not after the
//     whole video is buffered server-side.
//   - `Accept-Ranges: bytes` + `206 Partial Content` enable browser
//     seek, pause/resume, and native Safari playback (which requires
//     Range).
//   - No in-memory `Buffer.from(bytes)` on every request -- the Node
//     process no longer peaks at `videoSize` of resident memory per
//     concurrent viewer.
//
// Falls back to a full-body non-Range read when the backing storage
// adapter is the in-memory one (dev / vitest).

import { prisma } from "@/lib/prisma";

export interface TrainingVideoStreamResponse {
  status: 200 | 206;
  bodyStream: ReadableStream<Uint8Array> | null;
  bodyBuffer: Buffer | null; // populated only on the dev/memory fallback
  contentType: string;
  contentLength: number; // bytes IN THIS RESPONSE (not necessarily the full object)
  contentRange: string | null; // "bytes START-END/TOTAL" when status=206
  totalBytes: number;
  acceptRanges: "bytes";
  sha256: string | null;
}

export interface ParsedRange {
  start: number;
  end: number; // inclusive
}

/** Parse `Range: bytes=X-Y` headers.  Rejects multi-range + malformed
 *  (returns null; caller SHOULD serve a 200 with the full body). */
export function parseRangeHeader(header: string | null, totalBytes: number): ParsedRange | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === "" && endRaw === "") return null;

  // Suffix-length form: `bytes=-N` means the last N bytes.
  if (startRaw === "" && endRaw !== "") {
    const n = Number(endRaw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const start = Math.max(0, totalBytes - n);
    return { start, end: totalBytes - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || start >= totalBytes) return null;
  let end: number;
  if (endRaw === "") {
    end = totalBytes - 1;
  } else {
    end = Number(endRaw);
    if (!Number.isFinite(end) || end < start) return null;
    end = Math.min(end, totalBytes - 1);
  }
  return { start, end };
}

export async function streamTrainingVideo(args: {
  clubId: string;
  versionId: string;
  rangeHeader: string | null;
}): Promise<TrainingVideoStreamResponse | null> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: args.versionId },
    select: {
      videoStorageKey: true, videoMimeType: true, videoSha256: true, videoSizeBytes: true,
    },
  });
  if (!version || !version.videoStorageKey || !version.videoMimeType) return null;

  const totalBytes = Number(version.videoSizeBytes ?? 0);
  if (!(totalBytes > 0)) {
    // Legacy row missing size -- fall through to the full-body
    // path (fetches whole object + computes length).  Rare.
  }

  // The mailboxAttachmentStorageAdapter prepends `clubs/${clubId}/`
  // to the storageKey when it writes.  We replicate the same key
  // composition here so the R2 Get hits the identical object.
  const fullKey = `clubs/${args.clubId}/${version.videoStorageKey}`;
  const mimeType = version.videoMimeType;
  const sha256 = version.videoSha256 ?? null;
  const range = parseRangeHeader(args.rangeHeader, totalBytes);

  const s3 = await resolveR2Client();
  if (s3) {
    try {
      const { GetObjectCommand } = s3.module;
      const getArgs: {
        Bucket: string;
        Key: string;
        Range?: string;
      } = { Bucket: s3.bucket, Key: fullKey };
      if (range) getArgs.Range = `bytes=${range.start}-${range.end}`;
      const result = await s3.client.send(new GetObjectCommand(getArgs));
      // AWS SDK v3 returns a web ReadableStream in the Node runtime.
      const body = result.Body as unknown as ReadableStream<Uint8Array> | null;
      if (!body) return null;
      const contentLength = Number(result.ContentLength ?? (range ? range.end - range.start + 1 : totalBytes));
      const resolvedTotal = Number(result.ContentLength && result.ContentRange
        ? (result.ContentRange.split("/")[1] ?? totalBytes)
        : totalBytes) || totalBytes || contentLength;
      return {
        status: range ? 206 : 200,
        bodyStream: body,
        bodyBuffer: null,
        contentType: mimeType,
        contentLength,
        contentRange: range ? `bytes ${range.start}-${range.end}/${resolvedTotal}` : null,
        totalBytes: resolvedTotal,
        acceptRanges: "bytes",
        sha256,
      };
    } catch {
      return null;
    }
  }

  // Dev / in-memory fallback -- adapter facade owns the key
  // composition in this case (it prepends clubId internally).
  const { resolveDocumentStorage } = await import("@/lib/documents/storage");
  const storage = await resolveDocumentStorage({ clubId: args.clubId });
  const bytes = await storage.get({ storageKey: version.videoStorageKey });
  if (!bytes) return null;
  const total = bytes.length;
  if (range) {
    const slice = bytes.subarray(range.start, range.end + 1);
    return {
      status: 206,
      bodyStream: null,
      bodyBuffer: slice,
      contentType: mimeType,
      contentLength: slice.length,
      contentRange: `bytes ${range.start}-${range.end}/${total}`,
      totalBytes: total,
      acceptRanges: "bytes",
      sha256,
    };
  }
  return {
    status: 200,
    bodyStream: null,
    bodyBuffer: bytes,
    contentType: mimeType,
    contentLength: total,
    contentRange: null,
    totalBytes: total,
    acceptRanges: "bytes",
    sha256,
  };
}

type R2ClientHandle = {
  client: {
    send(cmd: unknown): Promise<{
      Body?: unknown;
      ContentLength?: number;
      ContentRange?: string;
      ETag?: string;
    }>;
  };
  bucket: string;
  module: { GetObjectCommand: new (args: unknown) => unknown };
};

async function resolveR2Client(): Promise<R2ClientHandle | null> {
  // Env-driven resolution mirrors mailboxAttachmentStorageAdapter()
  // in src/lib/integrations/storage.ts.
  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION ?? "auto";
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true";
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  const { optionalImport } = await import("@/lib/integrations/optional-import");
  const S3Module = (await optionalImport("@aws-sdk/client-s3")) as
    | { S3Client: new (args: unknown) => unknown; GetObjectCommand: new (args: unknown) => unknown }
    | null;
  if (!S3Module) return null;
  const client = new S3Module.S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle,
  }) as { send(cmd: unknown): Promise<Record<string, unknown>> };
  return { client, bucket, module: { GetObjectCommand: S3Module.GetObjectCommand } };
}
