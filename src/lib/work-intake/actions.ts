// Sprint 2 B4 (2026-07-19) — Work Intake orchestration actions.
//
// Minimum action set the founder called out in §15: mark informational,
// resolve, reopen, defer, assign-to-self. Every action:
//   • is tenant-scoped
//   • enforces personal-mailbox visibility (via the tenant guard from B1)
//   • appends a WorkIntakeActivity row
//   • preserves email evidence
//   • survives a subsequent resync (materialiser will NOT overwrite
//     orchestration state; only display / classification refreshes)
//
// Broad cross-user assignment is intentionally out of scope. B4 supports
// self-assignment only.

import { prisma } from "@/lib/prisma";
import { workIntakeReadableByPrincipal } from "@/lib/work-intake/tenant";
import type { Principal } from "@/lib/rbac";

interface ActionCtx {
  principal: Principal;
  clubId: string;
  workIntakeItemId: string;
}

/**
 * Load the intake and verify the principal is authorised to see it.
 * Throws NotFound-style ForbiddenError otherwise. Used by every
 * action so authorisation is one place.
 */
async function loadAuthorisedIntake(ctx: ActionCtx) {
  const where = workIntakeReadableByPrincipal({
    userId: ctx.principal.id,
    clubId: ctx.clubId,
    isClubAdmin: false,
    isSuperAdmin: false,
  });
  const it = await prisma.workIntakeItem.findFirst({
    where: { AND: [{ id: ctx.workIntakeItemId }, where] },
  });
  if (!it) throw new WorkIntakeActionError("not_visible");
  return it;
}

export class WorkIntakeActionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Work Intake action error: ${code}`);
    this.name = "WorkIntakeActionError";
    this.code = code;
  }
}

export async function resolveIntake(ctx: ActionCtx, note?: string, opts?: { completionType?: "RESOLVED" | "REPLIED_AND_CLOSED" | "OTHER" }): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedByUserId: ctx.principal.id,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "RESOLVED",
        fromValue: it.status,
        toValue: "RESOLVED",
        note: note ?? null,
      },
    }),
  ]);
  // Sprint 3 · Checkpoint 16H — emit canonical completion event
  // AFTER the transaction commits, so the archive worker never
  // races the WI status write. Failure here does NOT roll back
  // the resolve (the worker owns its own retries).
  try {
    const { emitWorkCompletionEvent } = await import("./completion");
    await emitWorkCompletionEvent({
      workIntakeItemId: it.id,
      clubId: it.clubId,
      completedByUserId: ctx.principal.id,
      completionType: opts?.completionType ?? "RESOLVED",
    });
  } catch {
    // Never block resolve on event emission.
  }
}

export async function reopenIntake(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        status: "OPEN",
        resolvedAt: null,
        resolvedByUserId: null,
        deferredUntil: null,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "REOPENED",
        fromValue: it.status,
        toValue: "OPEN",
      },
    }),
  ]);
}

export async function markInformational(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: { status: "INFORMATIONAL", judgmentRequired: false },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "STATUS_CHANGED",
        fromValue: it.status,
        toValue: "INFORMATIONAL",
      },
    }),
  ]);
}

export async function deferIntake(ctx: ActionCtx, until: Date): Promise<void> {
  if (!(until instanceof Date) || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    throw new WorkIntakeActionError("invalid_defer_time");
  }
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: { status: "DEFERRED", deferredUntil: until },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "DEFERRED",
        fromValue: it.status,
        toValue: "DEFERRED",
        note: until.toISOString(),
      },
    }),
  ]);
}

export async function assignToSelf(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        ownerUserId: ctx.principal.id,
        status: it.status === "OPEN" ? "IN_PROGRESS" : it.status,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "ASSIGNED",
        fromValue: it.ownerUserId ?? null,
        toValue: ctx.principal.id,
      },
    }),
  ]);
}

/**
 * Sprint 3 Checkpoint 15I — per-user read state.
 * Upsert a WorkIntakeItemRead row for (workIntakeItemId, userId).
 * Idempotent: repeated calls do NOT bump readAt and do NOT append
 * activity — read is a UI hint, not a domain state change. Absence
 * of a row = unread for that user; presence = read.
 *
 * Tenant guard applies via loadAuthorisedIntake — a user can only
 * mark-read intakes they can already see.
 */
export async function markWorkIntakeRead(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.workIntakeItemRead.upsert({
    where: {
      workIntakeItemId_userId: {
        workIntakeItemId: it.id,
        userId: ctx.principal.id,
      },
    },
    update: {}, // idempotent — do not bump readAt on repeat
    create: {
      workIntakeItemId: it.id,
      userId: ctx.principal.id,
    },
  });
}
