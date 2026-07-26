// Sprint 3 Checkpoint 15F (2026-07-24) — Vendor consolidation reviewer
// actions. Records every decision as WorkIntakeActivity + delegates
// EXECUTE_CONSOLIDATION to the transactional executor.
//
// NEVER auto-merges. NEVER exposes banking details.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import type { VendorConsolidationAction } from "./types";
import { VendorIntelligenceError } from "./types";
import { executeMerge } from "./consolidate";
import type { Principal } from "@/lib/rbac";

export interface ActionArgs {
  principal: Principal;
  clubId: string;
  workIntakeItemId: string;
  kind: VendorConsolidationAction;
  notes?: string;
  payload?: {
    chosenWinnerVendorId?: string;
    acceptInvoiceReferenceCollisions?: boolean;
    keepActiveBanking?: "WINNER" | "LOSER";
  };
}

export interface ActionResult {
  ok: boolean;
  kind: VendorConsolidationAction;
  reason?: string;
  mergeRecordId?: string;
  movedCounts?: unknown;
}

export async function applyVendorAction(args: ActionArgs): Promise<ActionResult> {
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: args.workIntakeItemId, clubId: args.clubId, classification: "VENDOR_CONSOLIDATION_REVIEW" },
    select: { id: true, classificationRuleKey: true },
  });
  if (!intake) return { ok: false, kind: args.kind, reason: "not_found" };

  const pairKey = (intake.classificationRuleKey ?? "").replace(/^vendor-intelligence\.pair\./, "");
  const [aId, bId] = pairKey.split("::");
  if (!aId || !bId) return { ok: false, kind: args.kind, reason: "invalid_pair" };

  switch (args.kind) {
    case "APPROVE_CONSOLIDATION":
    case "REJECT_CONSOLIDATION":
    case "MARK_VENDORS_DISTINCT":
    case "DEFER_REVIEW":
    case "CHOOSE_DIFFERENT_CANONICAL":
      await recordActivity({
        workIntakeItemId: intake.id,
        actorUserId: args.principal.id,
        kind: args.kind,
        notes: args.notes ?? null,
        payload: args.payload,
      });
      logger.info("vendor-intelligence.action.recorded", {
        clubId: args.clubId, intakeIdTail: intake.id.slice(-6), kind: args.kind,
      });
      return { ok: true, kind: args.kind };

    case "EXECUTE_CONSOLIDATION": {
      const winnerId = args.payload?.chosenWinnerVendorId ?? aId;
      const loserId = winnerId === aId ? bId : winnerId === bId ? aId : null;
      if (!loserId) return { ok: false, kind: args.kind, reason: "invalid_winner" };
      try {
        const result = await executeMerge({
          clubId: args.clubId,
          winnerVendorId: winnerId,
          loserVendorId: loserId,
          reason: args.notes ?? "Reviewer approved via Mission Control",
          initiatedByUserId: args.principal.id,
          approvedByUserId: args.principal.id,
          acceptInvoiceReferenceCollisions: !!args.payload?.acceptInvoiceReferenceCollisions,
          keepActiveBanking: args.payload?.keepActiveBanking ?? "WINNER",
        });
        await recordActivity({
          workIntakeItemId: intake.id,
          actorUserId: args.principal.id,
          kind: args.kind,
          notes: `Merged loser ${loserId.slice(-6)} into winner ${winnerId.slice(-6)}; mergeRecord=${result.mergeRecordId}`,
          payload: { mergeRecordId: result.mergeRecordId, movedCounts: result.movedCounts },
        });
        // Auto-resolve the intake once merged.
        await prisma.workIntakeItem.update({
          where: { id: intake.id },
          data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: args.principal.id },
        });
        return {
          ok: true,
          kind: args.kind,
          mergeRecordId: result.mergeRecordId,
          movedCounts: result.movedCounts,
        };
      } catch (err) {
        const category = err instanceof VendorIntelligenceError ? err.category : "UNEXPECTED";
        logger.warn("vendor-intelligence.action.execute_failed", {
          clubId: args.clubId, intakeIdTail: intake.id.slice(-6), category,
          message: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, kind: args.kind, reason: category };
      }
    }

    default:
      return { ok: false, kind: args.kind, reason: "unknown_kind" };
  }
}

async function recordActivity(args: {
  workIntakeItemId: string;
  actorUserId: string | null;
  kind: VendorConsolidationAction;
  notes: string | null;
  payload?: unknown;
}): Promise<void> {
  const payloadStr = args.payload ? JSON.stringify(args.payload) : null;
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: args.workIntakeItemId,
      actorUserId: args.actorUserId,
      action: `VENDOR_${args.kind}`,
      note: [args.notes, payloadStr].filter(Boolean).join(" · ") || null,
    },
  });
}
