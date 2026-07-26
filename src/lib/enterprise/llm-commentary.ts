// Phase 7H — LLM commentary service.
//
// Generates draft commentary for board packages, insights, and other
// governance surfaces. CRITICAL: drafts are *never* auto-finalized and *never*
// auto-distributed. Every output is stored as PENDING → READY and must be
// human-reviewed before becoming a finalized commentary row.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { selectLLMProvider } from "../integrations/llm";

// ---------------------------------------------------------------------------
// Prompt templates — store club-tunable templates as ClubSetting under
// scope=LLM_PROMPTS in a future iteration. For now these defaults are the
// canonical set.
// ---------------------------------------------------------------------------
export const PROMPT_TEMPLATES = {
  package_executive_summary: {
    system: "You are a private-club Chief Financial Officer drafting concise, board-ready commentary. Tone: calm, professional, sophisticated. Never make accounting recommendations or commit to financial actions.",
    template: "Draft an executive summary (5-8 sentences) for the {{periodLabel}} board package of {{clubName}}.\n\nKey figures:\n{{figures}}\n\nNotable trends:\n{{trends}}\n\nWrite in third person, present tense. Do not invent numbers — use only those supplied.",
  },
  variance_explanation: {
    system: "You are a private-club controller drafting brief variance explanations for the management commentary section of a board package. One short paragraph per topic. Cautious tone — flag rather than conclude.",
    template: "Variance: {{subject}}\nDelta: {{delta}}\nBudget: {{budget}}\nActual: {{actual}}\nContext: {{context}}\n\nWrite 3-5 sentences. Do not invent causes — speculate softly with hedges.",
  },
  insight_summary: {
    system: "You are summarizing an automated cross-module insight for a club leadership team. Tone: even-handed, recommend a next action, never alarmist.",
    template: "Insight title: {{title}}\nObservation: {{body}}\nSeverity: {{severity}}\n\nWrite 2-3 sentences that summarize for a non-technical executive and suggest a recommended next action.",
  },
  collections_overview: {
    system: "You are a private-club member-services director drafting a collections overview for the General Manager. Tone: discreet, member-respectful, action-oriented.",
    template: "Collections snapshot for {{periodLabel}}:\n{{stats}}\n\nWrite 3-4 sentences summarizing the state of collections and the recommended posture for the period (gentle outreach, formal notices, etc.).",
  },
} as const;

export type PromptKey = keyof typeof PROMPT_TEMPLATES;

function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = key.split(".").reduce((acc: unknown, part: string) => (acc && typeof acc === "object" && part in (acc as object)) ? (acc as Record<string, unknown>)[part] : undefined, vars as unknown);
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
export const generateSchema = z.object({
  promptKey: z.string(),
  variables: z.record(z.string(), z.unknown()).default({}),
  subjectEntityType: z.string().optional().nullable(),
  subjectEntityId: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
});

export async function generateCommentary(principal: Principal, clubId: string, raw: unknown) {
  // Re-uses "packages:write" as the gate because commentary is a package-level
  // editorial artifact. Insight summaries also flow through this service.
  requirePermission(principal, clubId, "packages:write");
  const parsed = generateSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const tpl = (PROMPT_TEMPLATES as Record<string, { system: string; template: string }>)[d.promptKey];
  if (!tpl) throw new ConflictError(`Unknown prompt template: ${d.promptKey}`);

  const provider = await selectLLMProvider(clubId);
  const prompt = renderPrompt(tpl.template, d.variables);

  const draft = await prisma.lLMCommentaryDraft.create({
    data: {
      clubId, provider: provider.name, model: d.model ?? null,
      subjectEntityType: d.subjectEntityType ?? null, subjectEntityId: d.subjectEntityId ?? null,
      promptTemplate: d.promptKey, promptVariables: JSON.stringify(d.variables),
      status: "GENERATING", requestedByUserId: principal.id,
    },
  });

  try {
    const result = await provider.generate({ system: tpl.system, prompt, model: d.model ?? undefined });
    const updated = await prisma.lLMCommentaryDraft.update({
      where: { id: draft.id },
      data: {
        generatedText: result.text, model: result.model,
        promptTokens: result.promptTokens ?? 0, completionTokens: result.completionTokens ?? 0,
        status: "READY",
      },
    });
    await audit(principal, {
      action: "llm.commentary.generate",
      entityType: "LLMCommentaryDraft", entityId: draft.id, clubId,
      after: { provider: provider.name, model: result.model, promptKey: d.promptKey },
    });
    return updated;
  } catch (err) {
    await prisma.lLMCommentaryDraft.update({
      where: { id: draft.id },
      data: { status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

// Accepting an AI draft creates a finalized ReportingPackageCommentary row
// linked back to the draft. Drafts can be rejected (kept for audit) but their
// content never appears in distributed packages unless explicitly accepted.
export async function acceptDraftAsCommentary(principal: Principal, draftId: string, args: { packageId: string; subject: string; scope?: string; body?: string }) {
  const draft = await prisma.lLMCommentaryDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new NotFoundError("LLMCommentaryDraft", draftId);
  assertTenantOwned(draft, principal);
  requirePermission(principal, draft.clubId, "packages:write");
  if (draft.status !== "READY") throw new ConflictError(`Draft is ${draft.status}`);
  const pkg = await prisma.reportingPackage.findUnique({ where: { id: args.packageId } });
  if (!pkg || pkg.clubId !== draft.clubId) throw new NotFoundError("ReportingPackage", args.packageId);
  if (pkg.status === "APPROVED" || pkg.status === "DISTRIBUTED" || pkg.status === "ARCHIVED") {
    throw new ConflictError(`Cannot attach commentary to ${pkg.status} package`);
  }

  const commentary = await prisma.reportingPackageCommentary.create({
    data: {
      clubId: draft.clubId, packageId: args.packageId,
      subject: args.subject, scope: args.scope ?? "GENERAL",
      body: args.body ?? draft.generatedText ?? "",
      aiDraftId: draft.id, isAIDraft: true,
      authorUserId: principal.id, status: "DRAFT",
    },
  });
  await prisma.lLMCommentaryDraft.update({
    where: { id: draft.id },
    data: { status: "ACCEPTED", reviewedAt: new Date(), reviewedByUserId: principal.id },
  });
  await audit(principal, {
    action: "llm.commentary.accept", entityType: "LLMCommentaryDraft", entityId: draft.id, clubId: draft.clubId,
    after: { commentaryId: commentary.id },
  });
  return commentary;
}

export async function rejectDraft(principal: Principal, draftId: string, notes?: string) {
  const draft = await prisma.lLMCommentaryDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new NotFoundError("LLMCommentaryDraft", draftId);
  assertTenantOwned(draft, principal);
  requirePermission(principal, draft.clubId, "packages:write");
  const updated = await prisma.lLMCommentaryDraft.update({
    where: { id: draftId },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewedByUserId: principal.id, notes: notes ?? draft.notes },
  });
  await audit(principal, { action: "llm.commentary.reject", entityType: "LLMCommentaryDraft", entityId: draftId, clubId: draft.clubId });
  return updated;
}

export async function regenerateDraft(principal: Principal, draftId: string) {
  const draft = await prisma.lLMCommentaryDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new NotFoundError("LLMCommentaryDraft", draftId);
  assertTenantOwned(draft, principal);
  requirePermission(principal, draft.clubId, "packages:write");
  const variables = draft.promptVariables ? JSON.parse(draft.promptVariables) as Record<string, unknown> : {};
  return generateCommentary(principal, draft.clubId, {
    promptKey: draft.promptTemplate, variables,
    subjectEntityType: draft.subjectEntityType, subjectEntityId: draft.subjectEntityId,
  });
}

export async function listDrafts(principal: Principal, clubId: string, opts?: { status?: string }) {
  requirePermission(principal, clubId, "packages:read");
  return prisma.lLMCommentaryDraft.findMany({
    where: { clubId, ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
