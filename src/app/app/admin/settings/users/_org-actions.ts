"use server";

// Organizational Foundation closeout (2026-09-13) — server actions
// invoked from the Organization tab client component. Each maps to a
// canonical service in tenant-admin/org-structure.ts. Zod validation,
// audit + tenant-scope enforcement are done inside those services.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  createPosition,
  updatePosition,
  archivePosition,
  reactivatePosition,
} from "@/lib/tenant-admin/org-structure";

export interface OrgActionResult {
  ok: boolean;
  message?: string;
}

function toMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Present a user-facing hierarchy-error rather than raw stack text.
  if (/cycle/i.test(msg)) {
    return "This reporting relationship would create a circular hierarchy. Pick a different manager Position.";
  }
  if (/itself/i.test(msg)) {
    return "A Position cannot report to itself.";
  }
  if (/Club/i.test(msg) && /different/i.test(msg)) {
    return "Selected department or manager belongs to a different Club.";
  }
  if (/Cannot deactivate/i.test(msg) || /Cannot archive/i.test(msg)) {
    return msg; // already user-facing
  }
  return msg;
}

export async function createPositionAction(input: {
  clubId: string;
  name: string;
  code?: string | null;
  departmentId?: string | null;
  reportsToPositionId?: string | null;
  sortOrder?: number;
  description?: string | null;
}): Promise<OrgActionResult> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return { ok: false, message: "Sign-in required." };
    // Reports-to is set AFTER create via updatePosition so the same
    // cycle-checking path applies.
    const created = await createPosition(principal, {
      clubId: input.clubId,
      name: input.name,
      departmentId: input.departmentId ?? null,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
    });
    if (input.reportsToPositionId || input.code) {
      await updatePosition(principal, created.id, {
        clubId: input.clubId,
        name: input.name,
        reportsToPositionId: input.reportsToPositionId ?? null,
        code: input.code ?? null,
      });
    }
    revalidatePath("/app/admin/settings/users");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: toMessage(e) };
  }
}

export async function updatePositionAction(
  positionId: string,
  input: {
    clubId: string;
    name?: string;
    code?: string | null;
    departmentId?: string | null;
    reportsToPositionId?: string | null;
    sortOrder?: number;
    description?: string | null;
  },
): Promise<OrgActionResult> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return { ok: false, message: "Sign-in required." };
    await updatePosition(principal, positionId, {
      clubId: input.clubId,
      name: input.name,
      departmentId: input.departmentId,
      description: input.description,
      sortOrder: input.sortOrder,
      reportsToPositionId: input.reportsToPositionId,
      code: input.code,
    });
    revalidatePath("/app/admin/settings/users");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: toMessage(e) };
  }
}

export async function deactivatePositionAction(positionId: string): Promise<OrgActionResult> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return { ok: false, message: "Sign-in required." };
    await archivePosition(principal, positionId);
    revalidatePath("/app/admin/settings/users");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: toMessage(e) };
  }
}

export async function reactivatePositionAction(positionId: string): Promise<OrgActionResult> {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return { ok: false, message: "Sign-in required." };
    await reactivatePosition(principal, positionId);
    revalidatePath("/app/admin/settings/users");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: toMessage(e) };
  }
}
