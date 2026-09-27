// PAY-1C/1 (2026-09-26) — Payment incident architecture.
//
// A Payment INCIDENT is distinct from a Payment OPERATIONAL EXCEPTION:
//
//   Operational exception (PAY-1B/4):
//     A single payment-level condition that needs human review — a
//     return, an amount mismatch, a verification failure. Rides
//     WorkIntakeItem. One exception ≠ one incident.
//
//   Payment incident (PAY-1C/1):
//     A wider operational or security event that spans multiple
//     payments, a whole connection, or a whole tenant — a provider
//     outage, a suspected duplicate execution, a callback-verification
//     attack pattern, a reconciliation discrepancy. Incidents exist
//     for CONTAINMENT, RECONSTRUCTION, and REGULATORY-ASSESSMENT
//     coordination by humans.
//
// Invariants:
//   1. An incident NEVER mutates linked financial evidence
//      (PaymentRun / PaymentInstruction / PaymentAuthorization /
//      PaymentEvent / ExternalPaymentEvent / JournalEntry). It only
//      references them.
//   2. Containment actions go through EXISTING controls
//      (setConnectionStatus, kill switch, etc.). This service never
//      cancels, deletes, or recreates a payment.
//   3. regulatoryAssessmentRequired is an OPERATOR HINT for humans /
//      legal counsel — it is never an automatic reporting decision.

import { prisma } from "@/lib/prisma";

export type PaymentIncidentCategory =
  | "PROVIDER_OUTAGE"
  | "WIDESPREAD_SUBMISSION_FAILURE"
  | "SUSPECTED_DUPLICATE_EXECUTION"
  | "UNAUTHORIZED_ATTEMPT"
  | "CREDENTIAL_COMPROMISE"
  | "CALLBACK_VERIFICATION_ATTACK"
  | "RECONCILIATION_DISCREPANCY"
  | "ACCOUNTING_INTEGRITY_FAILURE"
  | "CROSS_TENANT_EVENT"
  | "DATA_INTEGRITY_EVENT"
  | "SETTLEMENT_ANOMALY";

export type PaymentIncidentSeverity = "SEV_1" | "SEV_2" | "SEV_3" | "SEV_4";

export type PaymentIncidentStatus =
  | "DETECTED"
  | "TRIAGED"
  | "CONTAINED"
  | "INVESTIGATING"
  | "RECOVERED"
  | "RESOLVED";

export type PaymentIncidentLinkEntity =
  | "TENANT"
  | "PROVIDER_CONNECTION"
  | "PAYMENT_RUN"
  | "PAYMENT_INSTRUCTION"
  | "EXTERNAL_EVENT"
  | "WORK_INTAKE_ITEM";

export type PaymentIncidentSource =
  | "AUTOMATED_HEALTH"
  | "OPERATOR"
  | "CALLBACK_VERIFICATION"
  | "RECONCILIATION";

export interface PaymentIncidentTimelineEntry {
  ts: string;
  actor: string;
  event: string;
  note?: string;
}

export interface OpenIncidentInput {
  clubId: string | null;
  category: PaymentIncidentCategory;
  severity: PaymentIncidentSeverity;
  summary: string;
  detectedByUserId?: string | null;
  detectedSource: PaymentIncidentSource;
  regulatoryAssessmentRequired?: boolean;
  links?: { entityType: PaymentIncidentLinkEntity; entityId: string }[];
}

async function nextIncidentNumber(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `INC-${year}-`;
  const highest = await prisma.paymentIncident.findFirst({
    where: { incidentNumber: { startsWith: prefix } },
    orderBy: { incidentNumber: "desc" },
    select: { incidentNumber: true },
  });
  const nextSeq = highest ? Number(highest.incidentNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(nextSeq).padStart(6, "0")}`;
}

export async function openIncident(input: OpenIncidentInput): Promise<{ id: string; incidentNumber: string }> {
  const timeline: PaymentIncidentTimelineEntry[] = [
    {
      ts: new Date().toISOString(),
      actor: input.detectedByUserId ?? input.detectedSource,
      event: "DETECTED",
      note: input.summary,
    },
  ];
  const incidentNumber = await nextIncidentNumber();
  const created = await prisma.paymentIncident.create({
    data: {
      clubId: input.clubId,
      incidentNumber,
      category: input.category,
      severity: input.severity,
      status: "DETECTED",
      summary: input.summary,
      detectedByUserId: input.detectedByUserId ?? null,
      detectedSource: input.detectedSource,
      regulatoryAssessmentRequired: input.regulatoryAssessmentRequired ?? false,
      timelineJson: JSON.stringify(timeline),
      links: input.links?.length
        ? {
            create: input.links.map((l) => ({
              entityType: l.entityType,
              entityId: l.entityId,
            })),
          }
        : undefined,
    },
    select: { id: true, incidentNumber: true },
  });
  return created;
}

export async function linkIncidentEntities(
  incidentId: string,
  links: { entityType: PaymentIncidentLinkEntity; entityId: string }[],
): Promise<void> {
  if (!links.length) return;
  for (const l of links) {
    await prisma.paymentIncidentLink.upsert({
      where: {
        incidentId_entityType_entityId: {
          incidentId,
          entityType: l.entityType,
          entityId: l.entityId,
        },
      },
      update: {},
      create: { incidentId, entityType: l.entityType, entityId: l.entityId },
    });
  }
}

async function appendTimeline(
  incidentId: string,
  entry: PaymentIncidentTimelineEntry,
): Promise<void> {
  const cur = await prisma.paymentIncident.findUniqueOrThrow({
    where: { id: incidentId },
    select: { timelineJson: true },
  });
  const arr: PaymentIncidentTimelineEntry[] = JSON.parse(cur.timelineJson);
  arr.push(entry);
  await prisma.paymentIncident.update({
    where: { id: incidentId },
    data: { timelineJson: JSON.stringify(arr) },
  });
}

const NEXT_STATUSES: Record<PaymentIncidentStatus, PaymentIncidentStatus[]> = {
  DETECTED: ["TRIAGED", "CONTAINED", "INVESTIGATING", "RECOVERED", "RESOLVED"],
  TRIAGED: ["CONTAINED", "INVESTIGATING", "RECOVERED", "RESOLVED"],
  CONTAINED: ["INVESTIGATING", "RECOVERED", "RESOLVED"],
  INVESTIGATING: ["RECOVERED", "RESOLVED"],
  RECOVERED: ["RESOLVED"],
  RESOLVED: [],
};

const STATUS_TIMESTAMP_FIELD: Partial<Record<PaymentIncidentStatus, "triagedAt" | "containedAt" | "investigatedAt" | "recoveredAt" | "resolvedAt">> = {
  TRIAGED: "triagedAt",
  CONTAINED: "containedAt",
  INVESTIGATING: "investigatedAt",
  RECOVERED: "recoveredAt",
  RESOLVED: "resolvedAt",
};

export async function transitionIncident(
  incidentId: string,
  next: PaymentIncidentStatus,
  actor: string,
  note?: string,
): Promise<void> {
  const cur = await prisma.paymentIncident.findUniqueOrThrow({
    where: { id: incidentId },
    select: { status: true },
  });
  const allowed = NEXT_STATUSES[cur.status as PaymentIncidentStatus] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(
      `PAY-1C: cannot transition incident ${incidentId} from ${cur.status} to ${next}`,
    );
  }
  const tsField = STATUS_TIMESTAMP_FIELD[next];
  const data: Record<string, Date | string> = { status: next };
  if (tsField) data[tsField] = new Date();
  await prisma.paymentIncident.update({ where: { id: incidentId }, data });
  await appendTimeline(incidentId, {
    ts: new Date().toISOString(),
    actor,
    event: next,
    note,
  });
}

export async function readIncidentTimeline(
  incidentId: string,
): Promise<PaymentIncidentTimelineEntry[]> {
  const row = await prisma.paymentIncident.findUniqueOrThrow({
    where: { id: incidentId },
    select: { timelineJson: true },
  });
  return JSON.parse(row.timelineJson) as PaymentIncidentTimelineEntry[];
}
