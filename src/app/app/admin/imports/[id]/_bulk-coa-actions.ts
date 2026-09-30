"use server";

// DIM-2b (2026-09-29) — Bulk COA-review server actions.
//
// The client component (BulkCoaReviewControls) submits filter +
// selection state via a form; these server actions apply the
// requested bulk change and route through the EXISTING
// `saveCoaRowMappings` pipeline. There is NO second commit path;
// bulk actions modify import-preview mappings only. The final
// Account / AccountDepartment / AccountFund persistence still
// happens in `applyPostValidationCreate` at commit time.
//
// Section 14/15 invariants:
//   * Selected rows only — no cross-row leakage.
//   * REPLACE and ADD semantics are explicit.
//   * Policy change never touches applicability; applicability
//     change never touches policy.
//   * Bulk changes mark affected rows reviewed.
//   * All changes flow through saveCoaRowMappings, so tenant
//     guards + unknown-fund blocking + normal validation apply.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { prisma } from "@/lib/prisma";
import { isAppError, NotFoundError } from "@/lib/errors";
import { saveCoaRowMappings } from "@/lib/imports";
import { normaliseCoaRow } from "@/lib/imports/coa-mapping";
import { readReviewState } from "@/lib/imports/coa-review-state";
import { resolveReviewedAfterMaterialEdit } from "@/lib/imports/coa-review-reset";
import { getCurrentPrincipal } from "@/lib/services/principal";

type DimensionPolicy = "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE";

type BulkAction =
  | { kind: "SET_DEPARTMENT_APPLICABILITY"; mode: "REPLACE" | "ADD"; departmentCodes: string[] }
  | { kind: "SET_FUND_APPLICABILITY"; mode: "REPLACE" | "ADD"; fundKeys: string[] }
  | { kind: "SET_DEPARTMENT_POLICY"; value: DimensionPolicy }
  | { kind: "SET_FUND_POLICY"; value: DimensionPolicy }
  // COA-UX-2b (2026-09-29) — bulk Classification. Each field is
  // INDEPENDENTLY optional: the caller sends only what should change.
  // Applied field-by-field so a Category-only change or FS-Group-only
  // change doesn't disturb the untouched fields on selected rows.
  | { kind: "SET_CLASSIFICATION"; type?: string; categoryKey?: string | null; fsGroupKey?: string | null }
  | { kind: "MARK_REVIEWED" };

function parseJsonSafe<T>(s: string, fallback: T): T {
  try { const p = JSON.parse(s) as T; return p ?? fallback; } catch { return fallback; }
}

/**
 * Apply a bulk edit to the selected preview rows in a COA batch.
 * Reuses saveCoaRowMappings so tenant + unknown-fund guards still fire.
 */
export async function applyBulkCoaEditAction(
  batchId: string,
  rowIds: ReadonlyArray<string>,
  action: BulkAction,
): Promise<
  | { ok: true; rowsAffected: number }
  | { ok: false; message: string }
> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  if (rowIds.length === 0) {
    return { ok: false, message: "No rows selected." };
  }

  // Fetch the current rawJson + confirm every row belongs to this batch.
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, domain: true, status: true },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  if (batch.domain !== "COA") {
    return { ok: false, message: "Bulk COA edit is only valid for COA batches." };
  }
  if (batch.status === "COMMITTED" || batch.status === "ROLLED_BACK") {
    return { ok: false, message: `Batch is ${batch.status}; mapping can no longer be edited.` };
  }

  const rows = await prisma.importRow.findMany({
    where: { batchId, id: { in: [...rowIds] } },
    select: { id: true, rawJson: true },
  });
  if (rows.length !== rowIds.length) {
    return { ok: false, message: "One or more selected rows do not belong to this batch." };
  }

  const mappings = rows.map((r) => {
    const raw = parseJsonSafe<Record<string, unknown>>(r.rawJson, {});
    const current = normaliseCoaRow(raw);
    const priorReviewed = readReviewState(raw).reviewed === true;
    // Base mapping preserves every non-touched field.
    const base = {
      rowId: r.id,
      type: current.type ?? null,
      categoryKey: current.categoryKey ?? null,
      fsGroupKey: current.fsGroupKey ?? null,
      departmentCodes: current.departmentCodes ?? [],
      fundApplicabilityKeys: current.fundApplicabilityKeys ?? [],
      departmentPolicy: current.departmentPolicy ?? undefined,
      fundPolicy: current.fundPolicy ?? undefined,
    } as Parameters<typeof saveCoaRowMappings>[1]["mappings"][number];
    const priorMaterial = {
      type: current.type ?? null,
      categoryKey: current.categoryKey ?? null,
      fsGroupKey: current.fsGroupKey ?? null,
      departmentPolicy: (current.departmentPolicy as string | undefined) ?? null,
      fundPolicy: (current.fundPolicy as string | undefined) ?? null,
      departmentCodes: current.departmentCodes ?? [],
      fundApplicabilityKeys: current.fundApplicabilityKeys ?? [],
    };
    // Helper: compose the next mapping + resolve reviewed via §6 rules.
    function withReviewed(next: typeof base, opts: { explicitReviewed?: boolean } = {}) {
      const nextMaterial = {
        type: next.type ?? null,
        categoryKey: next.categoryKey ?? null,
        fsGroupKey: next.fsGroupKey ?? null,
        departmentPolicy: (next.departmentPolicy as string | undefined) ?? null,
        fundPolicy: (next.fundPolicy as string | undefined) ?? null,
        departmentCodes: next.departmentCodes ?? [],
        fundApplicabilityKeys: next.fundApplicabilityKeys ?? [],
      };
      const reviewed = resolveReviewedAfterMaterialEdit({
        priorReviewed,
        explicitReviewed: opts.explicitReviewed,
        priorMaterial,
        nextMaterial,
      });
      return { ...next, reviewed };
    }

    switch (action.kind) {
      case "SET_DEPARTMENT_APPLICABILITY": {
        const priorSet = new Set(current.departmentCodes ?? []);
        const next = action.mode === "REPLACE"
          ? action.departmentCodes.slice()
          : [
              ...(current.departmentCodes ?? []),
              ...action.departmentCodes.filter((c) => !priorSet.has(c)),
            ];
        return withReviewed({ ...base, departmentCodes: next });
      }
      case "SET_FUND_APPLICABILITY": {
        const priorSet = new Set(current.fundApplicabilityKeys ?? []);
        const next = action.mode === "REPLACE"
          ? action.fundKeys.slice()
          : [
              ...(current.fundApplicabilityKeys ?? []),
              ...action.fundKeys.filter((k) => !priorSet.has(k)),
            ];
        return withReviewed({ ...base, fundApplicabilityKeys: next });
      }
      case "SET_DEPARTMENT_POLICY":
        // Policy change MUST NOT touch applicability (Section 7 +
        // Section 15). Only the policy field changes.
        return withReviewed({ ...base, departmentPolicy: action.value });
      case "SET_FUND_POLICY":
        return withReviewed({ ...base, fundPolicy: action.value });
      case "SET_CLASSIFICATION": {
        // Each of type / categoryKey / fsGroupKey is independently
        // optional — undefined means "leave alone", null means
        // "clear on this row". Cascade invariants (§10) are enforced
        // client-side before the action fires; here we just persist
        // exactly what the operator asked for. saveCoaRowMappings +
        // downstream DIM validation will still reject an incompatible
        // combination.
        const next: typeof base = { ...base };
        if (action.type !== undefined) next.type = action.type;
        if (action.categoryKey !== undefined) next.categoryKey = action.categoryKey;
        if (action.fsGroupKey !== undefined) next.fsGroupKey = action.fsGroupKey;
        return withReviewed(next);
      }
      case "MARK_REVIEWED":
        // MARK_REVIEWED is an explicit ack — no material change,
        // reviewed=true regardless of prior.
        return { ...base, reviewed: true };
    }
  });

  try {
    const result = await saveCoaRowMappings(principal, { batchId, mappings });
    revalidatePath(`/app/admin/imports/${batchId}`);
    return { ok: true, rowsAffected: result.rowsUpdated };
  } catch (err) {
    if (isAppError(err)) {
      cookies().set("spectre_import_error", err.safeMessage, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30,
      });
      return { ok: false, message: err.safeMessage };
    }
    throw err;
  }
}

/**
 * COA-UX-2 (2026-09-29) — single-row Inspector edit action.
 *
 * Applies a partial edit to a single ImportRow. Unlike the bulk
 * action, this one accepts arbitrary field-level edits (Type,
 * Category, FS Group, Dept/Fund Policy, applicability, reviewed).
 * It routes through the SAME `saveCoaRowMappings` pipeline, so
 * tenant scoping, UNKNOWN_FUND blocking, and normal validation
 * still apply.
 *
 * The `reviewed` bit is set to `true` by default on any Inspector
 * edit (so an edit implicitly marks the row reviewed), unless the
 * caller explicitly passes `reviewed: false` (i.e. "Unmark").
 */
export type InspectorEditInput = {
  type?: string | null;
  categoryKey?: string | null;
  fsGroupKey?: string | null;
  departmentCodes?: string[];
  fundApplicabilityKeys?: string[];
  departmentPolicy?: DimensionPolicy;
  fundPolicy?: DimensionPolicy;
  reviewed?: boolean;
};

export async function applyInspectorEditAction(
  batchId: string,
  rowId: string,
  edits: InspectorEditInput,
): Promise<
  | { ok: true }
  | { ok: false; message: string }
> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, domain: true, status: true },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  if (batch.domain !== "COA") return { ok: false, message: "Inspector edit is only valid for COA batches." };
  if (batch.status === "COMMITTED" || batch.status === "ROLLED_BACK") {
    return { ok: false, message: `Batch is ${batch.status}; mapping can no longer be edited.` };
  }

  const row = await prisma.importRow.findFirst({
    where: { id: rowId, batchId },
    select: { id: true, rawJson: true },
  });
  if (!row) return { ok: false, message: "Row does not belong to this batch." };

  const raw = parseJsonSafe<Record<string, unknown>>(row.rawJson, {});
  const current = normaliseCoaRow(raw);
  const priorReviewed = readReviewState(raw).reviewed === true;

  const nextType = edits.type !== undefined ? edits.type : (current.type ?? null);
  const nextCategoryKey = edits.categoryKey !== undefined ? edits.categoryKey : (current.categoryKey ?? null);
  const nextFsGroupKey = edits.fsGroupKey !== undefined ? edits.fsGroupKey : (current.fsGroupKey ?? null);
  const nextDepartmentCodes = edits.departmentCodes !== undefined ? edits.departmentCodes : (current.departmentCodes ?? []);
  const nextFundApplicabilityKeys = edits.fundApplicabilityKeys !== undefined ? edits.fundApplicabilityKeys : (current.fundApplicabilityKeys ?? []);
  const nextDepartmentPolicy = edits.departmentPolicy !== undefined ? edits.departmentPolicy : current.departmentPolicy;
  const nextFundPolicy = edits.fundPolicy !== undefined ? edits.fundPolicy : current.fundPolicy;

  // COA-UX-2c (2026-09-30) — §6 material-edit review reset. If the
  // caller explicitly passed `reviewed`, honour it (Mark Reviewed /
  // Unmark buttons). Otherwise: on a reviewed row whose material
  // fields actually changed, return to NOT REVIEWED; otherwise
  // preserve the DIM-2a default (edit ⇒ implicit ack).
  const resolvedReviewed = resolveReviewedAfterMaterialEdit({
    priorReviewed,
    explicitReviewed: edits.reviewed,
    priorMaterial: {
      type: current.type ?? null,
      categoryKey: current.categoryKey ?? null,
      fsGroupKey: current.fsGroupKey ?? null,
      departmentPolicy: (current.departmentPolicy as string | undefined) ?? null,
      fundPolicy: (current.fundPolicy as string | undefined) ?? null,
      departmentCodes: current.departmentCodes ?? [],
      fundApplicabilityKeys: current.fundApplicabilityKeys ?? [],
    },
    nextMaterial: {
      type: nextType,
      categoryKey: nextCategoryKey,
      fsGroupKey: nextFsGroupKey,
      departmentPolicy: (nextDepartmentPolicy as string | undefined) ?? null,
      fundPolicy: (nextFundPolicy as string | undefined) ?? null,
      departmentCodes: nextDepartmentCodes,
      fundApplicabilityKeys: nextFundApplicabilityKeys,
    },
  });

  const merged: Parameters<typeof saveCoaRowMappings>[1]["mappings"][number] = {
    rowId: row.id,
    type: nextType,
    categoryKey: nextCategoryKey,
    fsGroupKey: nextFsGroupKey,
    departmentCodes: nextDepartmentCodes,
    fundApplicabilityKeys: nextFundApplicabilityKeys,
    departmentPolicy: nextDepartmentPolicy,
    fundPolicy: nextFundPolicy,
    reviewed: resolvedReviewed,
  };

  try {
    await saveCoaRowMappings(principal, { batchId, mappings: [merged] });
    revalidatePath(`/app/admin/imports/${batchId}`);
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) {
      cookies().set("spectre_import_error", err.safeMessage, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30,
      });
      return { ok: false, message: err.safeMessage };
    }
    throw err;
  }
}
