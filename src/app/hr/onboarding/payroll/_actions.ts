// HR-2B.3 (2026-08-19) — Payroll section server actions.
//
// Every action gates on `EmployeeOnboardingActor` (never `Principal`),
// targets `actor.employeeId` exclusively, and audits with
// actorSource=EMPLOYEE (via the underlying self-service adapters).
//
// All actions follow the same shape as About-you actions: try the
// canonical adapter, on validation/app errors stash a safe message
// via a short-lived cookie and redirect back to the same step.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  attestSelfTd1,
  clearSelfSin,
  getSelfTaxProfileMasked,
  submitSelfBankAccount,
  submitSelfSin,
  submitSelfTaxProfile,
  uploadSelfBankingDocument,
} from "@/lib/hr/employee-self-service";
import {
  getProvincialTd1,
  TD1_FEDERAL_ADDITIONAL_CLAIMS,
  TD1_FEDERAL_CURRENT,
  TD1_PROVINCIAL_ADDITIONAL_CLAIMS,
} from "@/lib/hr/td1-forms";
import { isAppError } from "@/lib/errors";

// Short-lived cookie carrying the just-entered TD1 federal claim total
// forward from the federal step to the provincial step. Necessary
// because `getSelfTaxProfileMasked` deliberately hides plaintext claim
// amounts (they're KMS-encrypted at rest) and the provincial step's
// upsert would otherwise reset federalClaim to the basic amount on
// re-write, silently discarding any "additional claims" the employee
// declared on the federal step. httpOnly + sameSite=strict + short
// lifetime + scoped to /hr keeps the value out of client JS.
const FEDERAL_CLAIM_COOKIE = "spectre_hr_td1_federal_claim";

// HR-2B.3.1 (2026-08-18) — cookie-based stashError removed; errors now flow via `?err=<safe>` search param.
function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

function stashFederalClaim(amount: string) {
  cookies().set(FEDERAL_CLAIM_COOKIE, amount, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 60 * 30, // 30 minutes — comfortably longer than a single
                     // provincial step, well short of a session TTL.
    path: "/hr",
  });
}

function consumeFederalClaim(): string | null {
  const jar = cookies();
  const value = jar.get(FEDERAL_CLAIM_COOKIE)?.value ?? null;
  if (value) jar.delete(FEDERAL_CLAIM_COOKIE);
  if (!value) return null;
  // Loose validate — reject anything that isn't a plausible decimal
  // total. Do not echo the value back into any error.
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  return value;
}

async function beginActionOrRedirect() {
  try {
    return await requireEmployeeOnboardingActor();
  } catch {
    redirect("/hr/onboarding/expired");
  }
}

function firstIssueMessage(err: unknown): string | null {
  if (isAppError(err) && "issues" in err) {
    const issues = (err as unknown as { issues: Array<{ message: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) return issues[0]?.message ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SIN.
// ---------------------------------------------------------------------------
export async function saveSinAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const raw = (formData.get("sin") as string | null) ?? "";
  try {
    await submitSelfSin(actor, raw);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/payroll/sin", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/payroll");
  redirect("/hr/onboarding/payroll/direct-deposit");
}

export async function clearSinAction() {
  const actor = await beginActionOrRedirect();
  try {
    await clearSelfSin(actor);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/payroll/sin", err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/payroll");
  redirect("/hr/onboarding/payroll/sin");
}

// ---------------------------------------------------------------------------
// Direct deposit — banking account.
// ---------------------------------------------------------------------------
export async function saveBankAccountAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  try {
    await submitSelfBankAccount(actor, {
      holderName: (formData.get("holderName") as string | null) ?? "",
      institutionNumber: (formData.get("institutionNumber") as string | null) ?? "",
      transitNumber: (formData.get("transitNumber") as string | null) ?? "",
      accountNumber: (formData.get("accountNumber") as string | null) ?? "",
    });
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/payroll/direct-deposit", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/payroll");
  redirect("/hr/onboarding/payroll/td1-federal");
}

// ---------------------------------------------------------------------------
// Direct deposit — supporting document upload (void cheque / DD form).
// ---------------------------------------------------------------------------
export async function uploadBankingDocumentAction(formData: FormData) {
  const actor = await beginActionOrRedirect();
  const file = formData.get("document");
  const categoryRaw = (formData.get("category") as string | null) ?? "void_cheque";
  const category = categoryRaw === "direct_deposit_form" ? "direct_deposit_form" : "void_cheque";
  if (!(file instanceof File) || file.size === 0) {
    redirect(withErr("/hr/onboarding/payroll/direct-deposit", "Please choose a file to upload."));
  }
  const bytes = Buffer.from(await (file as File).arrayBuffer());
  try {
    await uploadSelfBankingDocument(actor, {
      bytes,
      mimeType: (file as File).type,
      category,
      displayName: (file as File).name || null,
    });
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/payroll/direct-deposit", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/payroll");
  redirect("/hr/onboarding/payroll/direct-deposit");
}

// ---------------------------------------------------------------------------
// TD1 — federal.
// ---------------------------------------------------------------------------
function effectiveFromForCurrentTaxYear(): Date {
  // TD1 forms apply per calendar tax year — anchor to Jan 1 of the
  // current year in UTC so the row is deterministic regardless of the
  // employee's timezone.
  const y = new Date().getUTCFullYear();
  return new Date(Date.UTC(y, 0, 1));
}

function readAdditionalClaimsTotal(
  formData: FormData,
  claimSpecs: ReadonlyArray<{ key: string }>,
): { total: number; hasAny: boolean } {
  const mode = (formData.get("claim_mode") as string | null) ?? "basic";
  if (mode !== "additional") return { total: 0, hasAny: false };
  let total = 0;
  let hasAny = false;
  for (const spec of claimSpecs) {
    const enabled = (formData.get(`claim:${spec.key}:enabled`) as string | null) === "1";
    if (!enabled) continue;
    const raw = ((formData.get(`claim:${spec.key}:amount`) as string | null) ?? "").trim();
    if (!raw) continue;
    // Loose parse — the adapter re-validates the final total.
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    total += n;
    hasAny = true;
  }
  return { total, hasAny };
}

export async function saveFederalTd1Action(formData: FormData) {
  const actor = await beginActionOrRedirect();

  const provinceRaw = ((formData.get("province") as string | null) ?? "").trim().toUpperCase();
  const provincialSpec = getProvincialTd1(provinceRaw);
  if (!provincialSpec) {
    redirect(withErr("/hr/onboarding/payroll/td1-federal", "Please choose the province where you'll be working."));
  }

  const basicFederal = Number(TD1_FEDERAL_CURRENT.basicPersonalAmount);
  const { total: extraFederal } = readAdditionalClaimsTotal(
    formData,
    TD1_FEDERAL_ADDITIONAL_CLAIMS,
  );
  const federalClaim = (basicFederal + extraFederal).toFixed(2);

  const attested = (formData.get("attestation") as string | null) === "1";
  if (!attested) {
    redirect(withErr("/hr/onboarding/payroll/td1-federal", "Please confirm the certification statement to continue."));
  }

  const effectiveFrom = effectiveFromForCurrentTaxYear();
  try {
    // Provincial claim is populated with the province's basic amount
    // as a placeholder — the provincial step lets the employee refine
    // it. federalClaim = basic + any additional the employee checked.
    await submitSelfTaxProfile(actor, {
      province: provinceRaw,
      td1FormVersion: TD1_FEDERAL_CURRENT.version,
      effectiveFrom,
      federalClaim,
      provincialClaim: provincialSpec.basicPersonalAmount,
      additionalDeductions: null,
    });
    await attestSelfTd1(actor, "federal", TD1_FEDERAL_CURRENT.version);
    // Carry the federal claim forward — see comment on FEDERAL_CLAIM_COOKIE.
    stashFederalClaim(federalClaim);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/payroll/td1-federal", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/payroll");
  redirect("/hr/onboarding/payroll/td1-provincial");
}

// ---------------------------------------------------------------------------
// TD1 — provincial.
// ---------------------------------------------------------------------------
export async function saveProvincialTd1Action(formData: FormData) {
  const actor = await beginActionOrRedirect();

  // Read the existing row to preserve federalClaim and effectiveFrom.
  const existing = await getSelfTaxProfileMasked(actor);
  if (!existing) {
    // The federal step didn't run — send them back.
    redirect("/hr/onboarding/payroll/td1-federal");
  }

  const province = existing.province;
  const provincialSpec = getProvincialTd1(province);
  if (!provincialSpec) {
    redirect(withErr("/hr/onboarding/payroll/td1-federal", "Please complete the federal step first — your province is not set."));
  }

  const basicProv = Number(provincialSpec.basicPersonalAmount);
  const { total: extraProv } = readAdditionalClaimsTotal(
    formData,
    TD1_PROVINCIAL_ADDITIONAL_CLAIMS,
  );
  const provincialClaim = (basicProv + extraProv).toFixed(2);

  const additionalDeductionsRaw = ((formData.get("additionalDeductions") as string | null) ?? "").trim();
  let additionalDeductions: string | null = null;
  if (additionalDeductionsRaw.length > 0) {
    const n = Number(additionalDeductionsRaw);
    if (!Number.isFinite(n) || n < 0) {
      redirect(withErr("/hr/onboarding/payroll/td1-provincial", "Additional tax withheld must be a positive dollar amount."));
    }
    additionalDeductions = n.toFixed(2);
  }

  const attested = (formData.get("attestation") as string | null) === "1";
  if (!attested) {
    redirect(withErr("/hr/onboarding/payroll/td1-provincial", "Please confirm the certification statement to continue."));
  }

  // The tax profile row carries both federal + provincial claim
  // ciphertexts. `submitSelfTaxProfile` rewrites both on every call,
  // so to avoid clobbering the federal amount the employee just
  // attested we carry it forward from the federal step via a short-
  // lived signed cookie (see FEDERAL_CLAIM_COOKIE above). If the
  // cookie is absent (e.g. tab kept open past expiry, direct nav)
  // we fall back to the federal basic amount for the current year
  // — the employee can revisit the federal step to re-declare any
  // additional claims.
  const federalClaim = consumeFederalClaim()
    ?? Number(TD1_FEDERAL_CURRENT.basicPersonalAmount).toFixed(2);

  try {
    await submitSelfTaxProfile(actor, {
      province,
      td1FormVersion: provincialSpec.version,
      effectiveFrom: existing.effectiveFrom,
      federalClaim,
      provincialClaim,
      additionalDeductions,
    });
    await attestSelfTd1(actor, "provincial", provincialSpec.version);
  } catch (err) {
    if (isAppError(err)) {
      redirect(withErr("/hr/onboarding/payroll/td1-provincial", firstIssueMessage(err) ?? err.safeMessage));
    }
    throw err;
  }
  revalidatePath("/hr/onboarding/payroll");
  redirect("/hr/onboarding/payroll/review");
}
