// EP-TRAIN-4Y-BF — when a queued or running unit of preparation work is
// considered abandoned. One definition, shared by the progress screen,
// the orchestrator and the single-flight claim, so "stalled" means the
// same thing everywhere.
//
// RUNNING work is abandoned when its lease expired and nobody renewed
// it (the worker died). A healthy worker renews well inside the TTL.
//
// QUEUED work is NOT abandoned merely because it has waited: the worker
// processes one job at a time, so a job can legitimately wait behind a
// long one. It is abandoned only when its queue entry is gone (nothing
// will ever run it), or after a very long hard limit.

/** Minimum wait before a queued row is even examined. */
export const MAX_QUEUE_WAIT_MS = 5 * 60 * 1000;

/** A queued row older than this is retired even if a queue entry still
 *  exists: something is wrong with the queue itself. */
export const HARD_QUEUE_WAIT_MS = 60 * 60 * 1000;

/** RUNNING this long past its lease expiry → the worker is considered
 *  dead. A healthy worker renews its lease well inside the TTL. */
export const LEASE_GRACE_MS = 60 * 1000;

export const LIVE_EXECUTION_STATES = ["REQUESTED", "QUEUED", "RUNNING"] as const;

/** Minimal structural type so this works with the Prisma client and
 *  with a transaction client alike. */
interface QueueEntryReader {
  backgroundJob: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/** Is a queue entry still going to run this row? QUEUED entries count;
 *  a RUNNING entry counts only briefly (the worker is about to claim
 *  the row) — one that has been RUNNING for long without claiming
 *  belongs to a worker that died. */
export async function hasLiveQueueEntry(
  db: QueueEntryReader,
  args: {
    readonly clubId: string;
    readonly kind: string;
    readonly idempotencyKeys: readonly string[];
    readonly now: Date;
  },
): Promise<boolean> {
  const entry = await db.backgroundJob.findFirst({
    where: {
      clubId: args.clubId,
      kind: args.kind,
      idempotencyKey: { in: [...args.idempotencyKeys] },
      OR: [
        { status: "QUEUED" },
        { status: "RUNNING", startedAt: { gte: new Date(args.now.getTime() - MAX_QUEUE_WAIT_MS) } },
      ],
    },
    select: { id: true },
  });
  return entry !== null;
}

/** Display-only approximation used by the progress screen (it does not
 *  look at the queue). Decisions use the retire functions instead. */
export function isStalledExecution(
  row: { readonly state: string; readonly requestedAt: Date; readonly leaseExpiresAt: Date | null },
  now: Date,
): boolean {
  if (row.state === "REQUESTED" || row.state === "QUEUED") {
    return now.getTime() - row.requestedAt.getTime() > MAX_QUEUE_WAIT_MS;
  }
  return (
    row.state === "RUNNING" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() + LEASE_GRACE_MS < now.getTime()
  );
}
