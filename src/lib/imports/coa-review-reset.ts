// COA-UX-2c (2026-09-30) — §6 material-edit review reset.
//
// Pure helper — the "use server" module `_bulk-coa-actions.ts` may
// only export async functions, so this helper lives outside it and
// is imported by both the Inspector action and the bulk action.
//
// When the operator changes a material classification / policy /
// applicability field on a row that was previously acknowledged
// (`reviewed=true`), the prior ack is stale: the proposal has
// changed since the operator ack'd it. Return the reviewed flag
// that should be persisted after this edit.
//
// Semantics:
//   * If `explicitReviewed` is set (e.g. the operator clicked
//     "Mark Reviewed" or "Unmark"), honour it exactly. No override.
//   * Else if the edit actually changes ≥1 material field on a
//     previously-reviewed row → reviewed=false (§6). The founder
//     must re-ack.
//   * Else → keep the DIM-2a default so a first edit of an
//     unreviewed row still implicitly marks it reviewed.
//
// Material fields (per §6): type, categoryKey, fsGroupKey,
// departmentPolicy, departmentApplicabilityCodes, fundPolicy,
// fundApplicabilityKeys.

export type CoaReviewMaterial = {
  type: string | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  departmentPolicy: string | null;
  fundPolicy: string | null;
  departmentCodes: string[];
  fundApplicabilityKeys: string[];
};

export function resolveReviewedAfterMaterialEdit(args: {
  priorReviewed: boolean;
  explicitReviewed?: boolean;
  priorMaterial: CoaReviewMaterial;
  nextMaterial: CoaReviewMaterial;
}): boolean {
  if (args.explicitReviewed !== undefined) return args.explicitReviewed;
  const p = args.priorMaterial;
  const n = args.nextMaterial;
  const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const changed =
    p.type !== n.type ||
    p.categoryKey !== n.categoryKey ||
    p.fsGroupKey !== n.fsGroupKey ||
    p.departmentPolicy !== n.departmentPolicy ||
    p.fundPolicy !== n.fundPolicy ||
    !arrEq(p.departmentCodes.slice().sort(), n.departmentCodes.slice().sort()) ||
    !arrEq(p.fundApplicabilityKeys.slice().sort(), n.fundApplicabilityKeys.slice().sort());
  if (!changed) return args.priorReviewed;
  // §6 preferred rule: material change on an already-reviewed row
  // returns it to NOT REVIEWED. On a not-yet-reviewed row the
  // existing DIM-2a default applies (edit ⇒ implicit ack).
  return args.priorReviewed ? false : true;
}
