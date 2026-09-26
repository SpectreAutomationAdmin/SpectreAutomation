// PAY-1A (2026-09-26) — PaymentEvent recorder.
//
// First-class domain event stream. Complements AuditLog (which
// records user-visible actions). Every material payment state change
// MUST emit an event via `recordPaymentEvent`.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { PaymentEventType } from "./types";

export interface RecordPaymentEventInput {
  clubId: string;
  runId?: string | null;
  instructionId?: string | null;
  eventType: PaymentEventType;
  previousStatus?: string | null;
  newStatus?: string | null;
  actorUserId?: string | null;
  actorSource: "USER" | "PROVIDER" | "SYSTEM";
  providerReference?: string | null;
  meta?: Record<string, unknown> | null;
}

// Overload: when a Prisma transaction handle is provided the event is
// written inside that transaction; otherwise it uses the shared client.
export async function recordPaymentEvent(
  input: RecordPaymentEventInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? prisma;
  await client.paymentEvent.create({
    data: {
      clubId: input.clubId,
      runId: input.runId ?? null,
      instructionId: input.instructionId ?? null,
      eventType: input.eventType,
      previousStatus: input.previousStatus ?? null,
      newStatus: input.newStatus ?? null,
      actorUserId: input.actorUserId ?? null,
      actorSource: input.actorSource,
      providerReference: input.providerReference ?? null,
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
    },
  });
}
