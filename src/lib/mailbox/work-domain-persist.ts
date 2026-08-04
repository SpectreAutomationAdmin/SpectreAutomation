// Sprint 3 · Checkpoint 16G Stage B (2026-08-04) — persistence layer
// for work-domain classification. One authoritative writer; consumed
// by the email materialiser and by the backfill CLI.

import { prisma } from "@/lib/prisma";
import {
  classifyWorkDomain,
  type WorkDomainClassifierInput,
  type WorkDomainDecision,
} from "./work-domain-classifier";

/**
 * Classify + persist the workDomain fields on an existing
 * WorkIntakeItem. Reads the email (via emailOrigins), reads its
 * primary AP attachments (via apIntakeSourcesForCanonical), assembles
 * a normalised classifier input, calls the classifier, writes the
 * result idempotently.
 *
 * Idempotent: re-running against the same evidence writes the same
 * fields. Does not touch orchestration state (status / owner /
 * defer / resolved / judgmentRequired) — those live on user actions.
 */
export async function classifyAndPersistWorkDomain(args: {
  workIntakeItemId: string;
  clubId: string;
}): Promise<WorkDomainDecision> {
  const wi = await prisma.workIntakeItem.findUnique({
    where: { id: args.workIntakeItemId },
    select: {
      id: true, clubId: true,
      classification: true, classificationRuleKey: true, classificationConfidence: true,
      displaySubject: true, displaySender: true,
      emailOrigins: {
        select: {
          emailMessage: {
            select: {
              subject: true, bodyTextExtract: true, preview: true,
              senderName: true, senderAddress: true, importance: true, hasAttachments: true,
              attachments: { select: { filename: true } },
            },
          },
        },
      },
      apIntakeSourcesForCanonical: {
        select: { ingestedDocument: { select: { filename: true, classification: true } } },
      },
    },
  });
  if (!wi) throw new Error(`WorkIntakeItem ${args.workIntakeItemId} not found`);
  if (wi.clubId !== args.clubId) throw new Error(`clubId mismatch: ${wi.clubId} vs ${args.clubId}`);

  const em = wi.emailOrigins[0]?.emailMessage;
  const senderDomain = em?.senderAddress?.split("@")[1] ?? null;
  const attachments = [
    ...(em?.attachments?.map((a) => ({ filename: a.filename, classification: null as string | null })) ?? []),
    ...wi.apIntakeSourcesForCanonical.map((s) => ({
      filename: s.ingestedDocument?.filename ?? null,
      classification: s.ingestedDocument?.classification ?? null,
    })),
  ];
  const linkedToApWorkflow = wi.apIntakeSourcesForCanonical.length > 0;

  const input: WorkDomainClassifierInput = {
    ingestionClassification: wi.classification,
    ingestionClassificationRuleKey: wi.classificationRuleKey,
    ingestionClassificationConfidence: wi.classificationConfidence,
    subject: em?.subject ?? wi.displaySubject,
    bodyText: em?.bodyTextExtract ?? em?.preview ?? "",
    senderName: em?.senderName,
    senderAddress: em?.senderAddress,
    senderDomain,
    importance: em?.importance,
    hasAttachments: !!em?.hasAttachments || attachments.length > 0,
    attachments,
    linkedToApWorkflow,
  };
  const decision = classifyWorkDomain(input);

  await prisma.workIntakeItem.update({
    where: { id: wi.id },
    data: {
      workDomain: decision.selectedDomain,
      workIntent: decision.selectedIntent,
      workSubtype: decision.selectedSubtype ?? null,
      workDomainConfidence: decision.confidence,
      workDomainSupportingEvidenceJson: JSON.stringify(decision.supportingEvidence),
      workDomainAlternativesJson: JSON.stringify(decision.alternatives),
      workDomainRequiresReview: decision.requiresReview,
      workDomainClassifiedAt: new Date(),
      workDomainClassifierVersion: decision.classifierVersion,
    },
  });

  return decision;
}
