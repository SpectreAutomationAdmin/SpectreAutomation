// Phase 6G — Workflow engine.
//
// A Workflow is a directed sequence of WorkflowSteps. Each step is one of
// APPROVAL | ASSIGNMENT | NOTIFICATION | TASK. The workflow advances when its
// current step completes (approval recorded, task marked done). History is
// append-only for audit.
//
// This engine is broader than the AP ApprovalPolicy engine (single-decision)
// and is intended for governance flows like capital project approvals,
// budget approvals, vendor onboarding, banking changes, etc.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

export const workflowSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  entityType: z.string().optional().nullable(),
  entityId: z.string().optional().nullable(),
  steps: z.array(z.object({
    key: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(160),
    kind: z.enum(["APPROVAL", "ASSIGNMENT", "NOTIFICATION", "TASK"]).default("APPROVAL"),
    requiredApprovals: z.number().int().min(1).default(1),
    approverRoleKey: z.string().optional().nullable(),
    approverUserId: z.string().optional().nullable(),
    dueAt: z.string().or(z.date()).optional().nullable(),
  })).min(1),
});

export async function createWorkflow(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "workflow:write");
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const wf = await prisma.workflow.create({
    data: {
      clubId, key: d.key, name: d.name, description: d.description ?? null,
      entityType: d.entityType ?? null, entityId: d.entityId ?? null,
      status: "DRAFT", createdByUserId: principal.id,
    },
  });
  for (let i = 0; i < d.steps.length; i++) {
    const s = d.steps[i];
    await prisma.workflowStep.create({
      data: {
        clubId, workflowId: wf.id, key: s.key, name: s.name,
        sortOrder: i, kind: s.kind, status: "PENDING",
        requiredApprovals: s.requiredApprovals,
        approverRoleKey: s.approverRoleKey ?? null, approverUserId: s.approverUserId ?? null,
        dueAt: s.dueAt ? new Date(s.dueAt) : null,
      },
    });
  }
  await prisma.workflowHistory.create({
    data: { clubId, workflowId: wf.id, action: "CREATE", byUserId: principal.id },
  });
  await audit(principal, { action: "workflow.create", entityType: "Workflow", entityId: wf.id, clubId, after: { name: d.name, steps: d.steps.length } });
  return wf;
}

export async function startWorkflow(principal: Principal, workflowId: string) {
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId }, include: { steps: { orderBy: { sortOrder: "asc" } } } });
  assertTenantOwned(wf, principal);
  requirePermission(principal, wf.clubId, "workflow:write");
  if (wf.status !== "DRAFT") throw new ConflictError(`Workflow is already ${wf.status}`);
  const firstStep = wf.steps[0];
  if (!firstStep) throw new ConflictError("Workflow has no steps");
  const updated = await prisma.workflow.update({
    where: { id: workflowId },
    data: { status: "ACTIVE", currentStepId: firstStep.id, startedAt: new Date() },
  });
  await prisma.workflowStep.update({ where: { id: firstStep.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
  await prisma.workflowHistory.create({
    data: { clubId: wf.clubId, workflowId, action: "START", byUserId: principal.id },
  });
  await audit(principal, { action: "workflow.start", entityType: "Workflow", entityId: workflowId, clubId: wf.clubId, after: { currentStep: firstStep.key } });
  return updated;
}

export async function decideStep(principal: Principal, stepId: string, args: { decision: "APPROVE" | "REJECT" | "ABSTAIN"; notes?: string }) {
  const step = await prisma.workflowStep.findUnique({ where: { id: stepId }, include: { workflow: { include: { steps: { orderBy: { sortOrder: "asc" } } } } } });
  if (!step) throw new NotFoundError("WorkflowStep", stepId);
  const wf = step.workflow;
  assertTenantOwned(wf, principal);
  requirePermission(principal, wf.clubId, "workflow:approve");
  if (wf.status !== "ACTIVE") throw new ConflictError(`Workflow is ${wf.status}`);
  if (step.status !== "IN_PROGRESS") throw new ConflictError(`Step is ${step.status}`);
  // Self-approval guard: the creator cannot approve their own workflow.
  if (wf.createdByUserId === principal.id) {
    throw new ConflictError("Self-approval is not permitted");
  }
  // Role gate — if approverRoleKey is set, principal must hold that role at the club.
  if (step.approverRoleKey) {
    const hasRole = principal.memberships.some((m) => m.clubId === wf.clubId && m.roleKey === step.approverRoleKey);
    const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
    if (!hasRole && !isSuper) throw new ConflictError(`Step requires role: ${step.approverRoleKey}`);
  }
  if (step.approverUserId && step.approverUserId !== principal.id) {
    throw new ConflictError("Step is assigned to a different approver");
  }

  await prisma.workflowApproval.create({
    data: { clubId: wf.clubId, workflowId: wf.id, stepId, approverUserId: principal.id, decision: args.decision, notes: args.notes ?? null },
  });
  await prisma.workflowHistory.create({
    data: { clubId: wf.clubId, workflowId: wf.id, action: args.decision === "APPROVE" ? "APPROVE" : "REJECT", byUserId: principal.id, metaJson: JSON.stringify({ stepKey: step.key, notes: args.notes }) },
  });

  // Rejection short-circuits the workflow.
  if (args.decision === "REJECT") {
    await prisma.workflowStep.update({ where: { id: stepId }, data: { status: "FAILED", completedAt: new Date() } });
    return prisma.workflow.update({
      where: { id: wf.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
  }

  // Count approvals; advance when threshold met.
  const approvals = await prisma.workflowApproval.count({ where: { stepId, decision: "APPROVE" } });
  if (approvals < step.requiredApprovals) return wf; // still need more

  await prisma.workflowStep.update({ where: { id: stepId }, data: { status: "COMPLETED", completedAt: new Date() } });
  // Find the next step.
  const next = wf.steps.find((s) => s.sortOrder === step.sortOrder + 1);
  if (next) {
    await prisma.workflowStep.update({ where: { id: next.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
    return prisma.workflow.update({ where: { id: wf.id }, data: { currentStepId: next.id } });
  }
  // No next step — workflow complete.
  await prisma.workflowHistory.create({ data: { clubId: wf.clubId, workflowId: wf.id, action: "COMPLETE", byUserId: principal.id } });
  return prisma.workflow.update({ where: { id: wf.id }, data: { status: "COMPLETED", completedAt: new Date(), currentStepId: null } });
}

export async function cancelWorkflow(principal: Principal, workflowId: string, reason?: string) {
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
  assertTenantOwned(wf, principal);
  requirePermission(principal, wf.clubId, "workflow:write");
  if (wf.status === "COMPLETED" || wf.status === "CANCELLED") return wf;
  await prisma.workflowHistory.create({ data: { clubId: wf.clubId, workflowId, action: "CANCEL", byUserId: principal.id, metaJson: reason ? JSON.stringify({ reason }) : null } });
  return prisma.workflow.update({ where: { id: workflowId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}

export async function addComment(principal: Principal, workflowId: string, body: string) {
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
  assertTenantOwned(wf, principal);
  requirePermission(principal, wf.clubId, "workflow:read");
  return prisma.workflowComment.create({
    data: { clubId: wf.clubId, workflowId, authorUserId: principal.id, body },
  });
}

export async function listWorkflows(principal: Principal, clubId: string, opts?: { status?: string }) {
  requirePermission(principal, clubId, "workflow:read");
  return prisma.workflow.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    include: { steps: { orderBy: { sortOrder: "asc" } } },
    take: 100,
  });
}

export async function getWorkflow(principal: Principal, workflowId: string) {
  const wf = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: {
      steps: { include: { approvals: true }, orderBy: { sortOrder: "asc" } },
      comments: { orderBy: { createdAt: "asc" } },
      history: { orderBy: { occurredAt: "asc" } },
    },
  });
  if (!wf) throw new NotFoundError("Workflow", workflowId);
  assertTenantOwned(wf, principal);
  requirePermission(principal, wf.clubId, "workflow:read");
  return wf;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
