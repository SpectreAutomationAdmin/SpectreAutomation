// Payroll-3B-5A (2026-08-31) — Spectre-owned, effective-dated
// statutory calculation packages.
//
// A statutory package pins one CRA formula edition (federal) + one
// provincial rule set (Alberta MVP) to a half-open [effectiveFrom,
// effectiveTo) window on the payroll pay date. The 2026 CRA
// publications demonstrated exactly why calendar-year keying is
// unsafe: T4127 was reissued mid-year (Jan 1 → Jul 1). A single
// package model with pay-date-effective windows keeps the resolver
// deterministic and avoids the "which 2026 file governed this
// payroll?" ambiguity.
//
// Spectre owns these packages. There are NO tenant CRUD routes. New
// packages are installed via internal seed (see
// `installStatutoryPackage`) or SUPER_ADMIN-only migration. Tenant
// users may READ package metadata for transparency (pinned
// packageVersion on the batch, effective-date audit trail) but
// cannot alter values.
//
// The calculator does NOT read paramsJson through this file directly
// — it calls `resolveStatutoryPackage(...)` to obtain a validated
// parameter object typed by `CanadianPayrollStatutoryParamsV1` and
// then invokes the algorithm functions that understand that shape.
// Algorithm implementation lives in `src/lib/payroll/statutory/`
// (added in 3B-5B).

import { z } from "zod";
import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { isSuperAdmin, type Principal } from "../rbac";
import { audit } from "../audit";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "PayrollStatutoryPackage";

// ---------------------------------------------------------------------------
// Zod: CanadianPayrollStatutoryParamsV1 — strict runtime shape
// ---------------------------------------------------------------------------

const DecimalString = z
  .string()
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), { message: "not a decimal string" });

const TaxBracket = z.object({
  /** Lower bound of taxable income for this bracket (inclusive), CAD. */
  from: DecimalString,
  /** Upper bound (exclusive); null for the top bracket. */
  to: DecimalString.nullable(),
  /** Marginal rate as a decimal (e.g. "0.15" for 15%). */
  rate: DecimalString,
  /**
   * Constant K used in the T4127 formula `T3 = R*A - K` where R is
   * the bracket rate and A is annualised taxable income. Encoded per
   * bracket so both federal and provincial tables share one shape.
   */
  constantK: DecimalString,
});

/**
 * CanadianPayrollStatutoryParamsV1 — the ONLY parameter shape the
 * 3B-5B calculator will consume. Adding a field is a breaking change
 * that MUST bump the schema version, because seeded packages carry
 * their paramsJson forever.
 *
 * Every field is documented at the point of declaration so a future
 * contributor cannot add one accidentally without stating its
 * downstream calculation dependency.
 */
export const CanadianPayrollStatutoryParamsV1 = z.object({
  schemaVersion: z.literal(1),
  jurisdictionCountry: z.literal("CA"),
  /** Null for a federal-only package; ISO 2-char code otherwise. */
  jurisdictionProvince: z.enum(["AB"]).nullable(),

  // ---- Canada Pension Plan (T4127 Chapter 6) ----
  //
  // 3B-5B-1b (2026-09-01) — components preserved so the calculator's
  // combined Factor C result can decompose to CRA-reported base +
  // first-additional components exactly (§C decomposition rule).
  //
  // For 2026 the founder-verified values are:
  //   ybe = 3500.00, ympe = 74600.00, ymce = 71100.00, yampe = 85000.00
  //   base:            rate 0.0495, max EE 3519.45, max ER 3519.45
  //   first additional: rate 0.0100, max EE 711.00,  max ER 711.00
  //   combined (C):    rate 0.0595, max EE 4230.45, max ER 4230.45
  //   CPP2:            rate 0.0400, max EE 416.00,  max ER 416.00
  cpp: z.object({
    /** Year's Basic Exemption. */
    ybe: DecimalString,
    /** Year's Maximum Pensionable Earnings — CPP base cap. */
    ympe: DecimalString,
    /**
     * Year's Maximum Contributory Earnings — pensionable band ceiling
     * used in CRA's "maximum contributory earnings" published figure
     * (`ympe − ybe`). Kept explicit to prevent re-deriving.
     */
    ymce: DecimalString,
    /** Year's Additional Maximum Pensionable Earnings — CPP2 cap. */
    yampe: DecimalString,

    /** Base CPP employee contribution rate (decimal). */
    baseRateEE: DecimalString,
    /** Base CPP employer contribution rate (equal to EE by statute). */
    baseRateER: DecimalString,
    /** Base annual maximum contribution — employee side (CAD). */
    baseMaxEE: DecimalString,
    /** Base annual maximum contribution — employer side. */
    baseMaxER: DecimalString,

    /** First-additional CPP employee contribution rate. */
    firstAdditionalRateEE: DecimalString,
    /** First-additional employer rate. */
    firstAdditionalRateER: DecimalString,
    /** First-additional annual maximum — employee. */
    firstAdditionalMaxEE: DecimalString,
    /** First-additional annual maximum — employer. */
    firstAdditionalMaxER: DecimalString,

    /**
     * Combined Factor C rate = base + first-additional. The calculator
     * uses this as the working rate; the base/first-additional split
     * is derived per §C. Storing the combined rate explicitly (rather
     * than adding at read time) avoids per-read float drift.
     */
    combinedRateEE: DecimalString,
    combinedRateER: DecimalString,
    /** Combined annual maximum — employee (CRA Factor C max). */
    combinedMaxEE: DecimalString,
    combinedMaxER: DecimalString,

    /** CPP2 (second-additional) rate — employee. */
    cpp2RateEE: DecimalString,
    /** CPP2 rate — employer (equal to EE by statute). */
    cpp2RateER: DecimalString,
    /** CPP2 annual maximum contribution — employee (CAD). */
    cpp2MaxEE: DecimalString,
    /** CPP2 annual maximum contribution — employer. */
    cpp2MaxER: DecimalString,
  }),

  // ---- Employment Insurance ----
  //
  // Store the CRA-published employer maximum explicitly (§13 rule);
  // do not derive `1.4 × employee` — record the multiplier as
  // documented metadata only.
  ei: z.object({
    /** Maximum Insurable Earnings (MIE), CAD. */
    mie: DecimalString,
    /** Employee EI premium rate (decimal). Quebec has a separate rate. */
    rateEE: DecimalString,
    /** Employer EI premium rate (decimal). Published by CRA. */
    rateER: DecimalString,
    /** Employee annual maximum premium, from CRA. */
    maxAnnualPremiumEE: DecimalString,
    /** Employer annual maximum premium, from CRA. */
    maxAnnualPremiumER: DecimalString,
    /** Employer/employee multiplier documentation (typically 1.4). Metadata only — not used in maximum lookups. */
    employerMultiplier: DecimalString,
  }),

  // ---- Federal income tax (T4127 Chapter 5) ----
  federal: z.object({
    brackets: z.array(TaxBracket).min(1),
    /**
     * Federal BPA is income-tiered (Bill C-30):
     *   • bpaMax applies when annualised income ≤ bpaPhaseOutStart
     *   • bpaMin applies when annualised income ≥ bpaPhaseOutEnd
     *   • Linear phase-out in between per T4127 §K1 (BPAF factor).
     * 2026 verified values: max 16452, min 14829.
     */
    bpaMax: DecimalString,
    bpaMin: DecimalString,
    /** Income threshold below which the maximum BPA applies. */
    bpaPhaseOutStart: DecimalString,
    /** Income threshold above which the minimum BPA applies. */
    bpaPhaseOutEnd: DecimalString,
    /** Non-refundable credit rate applied to BPA + TD1F claim. */
    lowestRate: DecimalString,
    /**
     * CPP2 first-additional deduction rate applied when computing
     * annualised net taxable income. T4127 Chapter 5 factor K3/K3P.
     */
    cpp2DeductionRate: DecimalString,
    /**
     * Payroll-3B-5B-1d (§4) — Canada Employment Amount (CEA)
     * maximum. Consumed by T4127 K4 (federal employment credit):
     *   K4 = min(annualisedEmploymentIncome, canadaEmploymentAmountMax)
     *        × federal.lowestRate
     * 2026: to be line-verified against T4127 122nd/123rd Editions
     * before dollar calculation ships. Founder / operator MUST
     * confirm the exact CRA-published value; the seeded value is
     * flagged in the source citation.
     */
    canadaEmploymentAmountMax: DecimalString,
  }),

  // ---- Provincial (Alberta MVP) ----
  //
  // Alberta 2026 verified brackets (T4032-AB Table 8.1):
  //   0            – 61,200:   V 0.08, KP     0
  //   61,200       – 154,259:  V 0.10, KP  1224
  //   154,259      – 185,111:  V 0.12, KP  4309
  //   185,111      – 246,813:  V 0.13, KP  6160
  //   246,813      – 370,220:  V 0.14, KP  8628
  //   370,220      – ∞:        V 0.15, KP 12331
  // Alberta BPA 2026 = 22,769.
  //
  // Alberta K5P (Payroll-3B-5B-1d §1-2, §B) — CORRECTED formula.
  //
  //   VERIFIED CRA structure (T4127 122nd/123rd Editions, §Alberta):
  //     K5P = max(0, ((K1P + K2P) - threshold) × (supplementalRate / baseRate))
  //
  //   Where:
  //     • K1P = Alberta non-refundable credit for BPA + TD1AB
  //     • K2P = Alberta CPP employee credit
  //     • threshold = $4,800 (CRA-published)
  //     • supplementalRate = 0.02 (the "2%" component)
  //     • baseRate = 0.08 (Alberta first-bracket rate — the "8%")
  //
  // The prior 3B-5B-1c formula (`T_prov_base` × `rate`) was WRONG
  // — K5P depends on K1P + K2P, not on annualised Alberta taxable
  // income directly. The old shape `{triggerBase, rate}` is
  // replaced by `{threshold, supplementalRate, baseRate}` so the
  // statutory relationship remains auditable in the package
  // itself; no opaque precomputed coefficients.
  //
  // If a payroll year has NO K5P applicable, `enabled = false`.
  // The calculator refuses to run against an Alberta package
  // whose k5p block is absent — the value MUST be affirmed
  // present-or-absent, never silently defaulted (§8 rule).
  provincial: z
    .object({
      brackets: z.array(TaxBracket).min(1),
      /** Provincial Basic Personal Amount. */
      bpa: DecimalString,
      /** Provincial lowest rate applied to BPA + TD1P. */
      lowestRate: DecimalString,
      /**
       * Alberta K5P specification (§B). Contract:
       *   • `enabled = true` → apply K5P per the CRA formula above.
       *   • `enabled = false` → explicitly document non-application.
       *   • `threshold` — CRA dollar threshold applied to (K1P+K2P).
       *   • `supplementalRate` — the "2%" numerator.
       *   • `baseRate` — the Alberta first-bracket rate that appears
       *     as the denominator; kept explicit rather than baked into
       *     a precomputed coefficient so a future rate change stays
       *     auditable.
       *   • `sourceCitation` — verbatim CRA citation.
       */
      k5p: z.object({
        enabled: z.boolean(),
        threshold: DecimalString,
        supplementalRate: DecimalString,
        baseRate: DecimalString,
        sourceCitation: z.string(),
      }),
    })
    .nullable(),

  // ---- Rounding rules ----
  //
  // Payroll-3B-5B-1c §9 — separate CRA STATUTORY INSTRUCTION from
  // Spectre IMPLEMENTATION CONVENTION.
  //
  //   Statutory instruction (`statutoryInstruction`): the literal
  //     CRA-published wording (e.g. "nearest cent", "nearest $0.05
  //     or $0.01 for tax"). Recorded for auditor visibility.
  //   Implementation convention (`mode`): Spectre's deterministic
  //     Decimal tie-breaking mode when CRA does not specify one
  //     (Java-style HALF_UP by default).
  //
  // MVP Payroll always rounds to nearest $0.01; nickel-rounding
  // support is out of MVP. Not tenant-configurable — CRA does not
  // permit tenants to select tie-breaking behaviour.
  rounding: z.object({
    /** Deterministic tie-breaking mode Spectre uses when CRA is silent. */
    mode: z.enum(["HALF_UP", "HALF_EVEN", "TRUNCATE"]),
    /** Rounding for total net pay cents. */
    netPayMode: z.enum(["HALF_UP", "HALF_EVEN", "TRUNCATE"]),
    /**
     * Literal CRA-published rounding wording, recorded verbatim for
     * auditor visibility. Never used to select a tie-breaking mode —
     * that comes from `mode` / `netPayMode` above.
     * Example: "T4127 §6: CPP contributions rounded to the nearest
     * cent; nearest $0.05 or $0.01 permitted for final tax."
     */
    statutoryInstruction: z.string(),
  }),
});
export type CanadianPayrollStatutoryParamsV1 = z.infer<typeof CanadianPayrollStatutoryParamsV1>;

export class InvalidStatutoryParamsError extends Error {
  readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = "InvalidStatutoryParamsError";
    this.issues = issues;
  }
}

/** Validate at install AND read time; loud rejection either side. */
export function assertValidCanadianParamsV1(
  raw: unknown,
): asserts raw is CanadianPayrollStatutoryParamsV1 {
  const r = CanadianPayrollStatutoryParamsV1.safeParse(raw);
  if (!r.success) {
    throw new InvalidStatutoryParamsError(
      `CanadianPayrollStatutoryParamsV1 rejected: ${r.error.issues.length} issue(s)`,
      r.error.issues,
    );
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallStatutoryPackageInput {
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  effectiveFrom: Date;
  /** Null for the current-and-forward window. */
  effectiveTo: Date | null;
  packageVersion: string;
  algorithmVersion?: string;
  sourcePublication: string;
  sourceEdition?: string | null;
  sourcePublicationDate?: Date | null;
  sourceUrl?: string | null;
  params: CanadianPayrollStatutoryParamsV1;
}

/**
 * Install a statutory package. SUPER_ADMIN only. Rejects:
 *   • non-SUPER_ADMIN principals (tenant users can never write)
 *   • paramsJson that fails Zod validation
 *   • [effectiveFrom, effectiveTo) that OVERLAPS an existing
 *     non-superseded package for the same jurisdiction
 *
 * On success, previous packages whose effectiveTo was NULL and whose
 * effectiveFrom < the new effectiveFrom are automatically capped at
 * the new effectiveFrom (so the timeline stays a clean partition).
 */
export async function installStatutoryPackage(
  principal: Principal,
  input: InstallStatutoryPackageInput,
): Promise<{ id: string; checksum: string }> {
  if (!isSuperAdmin(principal)) {
    throw new ValidationError([
      { path: "principal", message: "Only SUPER_ADMIN may install statutory packages." },
    ]);
  }
  assertValidCanadianParamsV1(input.params);
  if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) {
    throw new ValidationError([
      { path: "effectiveTo", message: "effectiveTo must be strictly greater than effectiveFrom." },
    ]);
  }

  const paramsJson = JSON.stringify(input.params);
  const checksum = createHash("sha256").update(paramsJson).digest("hex");

  const row = await prisma.$transaction(async (tx) => {
    // Overlap check.
    const overlaps = await tx.payrollStatutoryPackage.findMany({
      where: {
        jurisdictionCountry: input.jurisdictionCountry,
        jurisdictionProvince: input.jurisdictionProvince,
        supersededAt: null,
        effectiveFrom: { lt: input.effectiveTo ?? new Date("9999-12-31") },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gt: input.effectiveFrom } },
        ],
      },
    });

    for (const o of overlaps) {
      if (o.effectiveTo === null && o.effectiveFrom.getTime() < input.effectiveFrom.getTime()) {
        await tx.payrollStatutoryPackage.update({
          where: { id: o.id },
          data: { effectiveTo: input.effectiveFrom },
        });
        continue;
      }
      throw new ValidationError([
        {
          path: "effectiveFrom",
          message: `A statutory package for this jurisdiction already covers ${o.effectiveFrom.toISOString()} → ${o.effectiveTo?.toISOString() ?? "open"}. Explicitly supersede or narrow it before installing another.`,
        },
      ]);
    }

    return tx.payrollStatutoryPackage.create({
      data: {
        jurisdictionCountry: input.jurisdictionCountry,
        jurisdictionProvince: input.jurisdictionProvince,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        packageVersion: input.packageVersion,
        algorithmVersion: input.algorithmVersion ?? "v1",
        sourcePublication: input.sourcePublication,
        sourceEdition: input.sourceEdition ?? null,
        sourcePublicationDate: input.sourcePublicationDate ?? null,
        sourceUrl: input.sourceUrl ?? null,
        checksum,
        paramsJson,
        publishedByUserId: principal.id,
      },
    });
  });

  await audit(principal, {
    action: "payroll.statutory.install",
    entityType: ENTITY,
    entityId: row.id,
    after: {
      jurisdictionCountry: input.jurisdictionCountry,
      jurisdictionProvince: input.jurisdictionProvince,
      effectiveFrom: input.effectiveFrom.toISOString(),
      effectiveTo: input.effectiveTo?.toISOString() ?? null,
      packageVersion: input.packageVersion,
      checksum,
    },
  });

  return { id: row.id, checksum };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolvedStatutoryPackage {
  id: string;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  packageVersion: string;
  algorithmVersion: string;
  sourcePublication: string;
  sourceEdition: string | null;
  sourcePublicationDate: Date | null;
  sourceUrl: string | null;
  checksum: string;
  params: CanadianPayrollStatutoryParamsV1;
}

/**
 * Resolve the statutory package effective on `payDate` for the given
 * jurisdiction. Deterministic — the (country, province, effectiveFrom)
 * unique index + half-open window make exactly one row a valid answer.
 *
 * Throws ValidationError if:
 *   • no package covers the pay date
 *   • multiple non-superseded packages cover the pay date (should be
 *     structurally impossible; the install path enforces
 *     non-overlap, but the resolver treats it as data corruption
 *     and refuses to silently pick one).
 */
export async function resolveStatutoryPackage(input: {
  country: string;
  province: string | null;
  payDate: Date;
}): Promise<ResolvedStatutoryPackage> {
  const rows = await prisma.payrollStatutoryPackage.findMany({
    where: {
      jurisdictionCountry: input.country,
      jurisdictionProvince: input.province,
      supersededAt: null,
      effectiveFrom: { lte: input.payDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.payDate } }],
    },
    orderBy: [{ effectiveFrom: "desc" }],
  });

  if (rows.length === 0) {
    throw new ValidationError([
      {
        path: "payDate",
        message: `No statutory package covers ${input.country}/${input.province ?? "federal"} pay date ${input.payDate.toISOString()}. Install a package before calculating payroll.`,
      },
    ]);
  }
  if (rows.length > 1) {
    throw new ValidationError([
      {
        path: "payDate",
        message: `Multiple non-superseded statutory packages cover ${input.country}/${input.province ?? "federal"} on ${input.payDate.toISOString()}. Data corruption — resolve manually.`,
      },
    ]);
  }
  const row = rows[0];
  const raw = JSON.parse(row.paramsJson);
  assertValidCanadianParamsV1(raw);
  return {
    id: row.id,
    jurisdictionCountry: row.jurisdictionCountry,
    jurisdictionProvince: row.jurisdictionProvince,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    packageVersion: row.packageVersion,
    algorithmVersion: row.algorithmVersion,
    sourcePublication: row.sourcePublication,
    sourceEdition: row.sourceEdition,
    sourcePublicationDate: row.sourcePublicationDate,
    sourceUrl: row.sourceUrl,
    checksum: row.checksum,
    params: raw,
  };
}

// ---------------------------------------------------------------------------
// Read (tenant-visible metadata only)
// ---------------------------------------------------------------------------

export interface StatutoryPackageMetadata {
  id: string;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  packageVersion: string;
  algorithmVersion: string;
  sourcePublication: string;
  sourceEdition: string | null;
  sourcePublicationDate: Date | null;
  sourceUrl: string | null;
  checksum: string;
}

export async function listStatutoryPackages(input: {
  country?: string;
  province?: string | null;
}): Promise<StatutoryPackageMetadata[]> {
  const rows = await prisma.payrollStatutoryPackage.findMany({
    where: {
      jurisdictionCountry: input.country ?? undefined,
      jurisdictionProvince: input.province === undefined ? undefined : input.province,
    },
    orderBy: [{ jurisdictionCountry: "asc" }, { jurisdictionProvince: "asc" }, { effectiveFrom: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    jurisdictionCountry: r.jurisdictionCountry,
    jurisdictionProvince: r.jurisdictionProvince,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    packageVersion: r.packageVersion,
    algorithmVersion: r.algorithmVersion,
    sourcePublication: r.sourcePublication,
    sourceEdition: r.sourceEdition,
    sourcePublicationDate: r.sourcePublicationDate,
    sourceUrl: r.sourceUrl,
    checksum: r.checksum,
  }));
}

export async function getStatutoryPackageById(id: string): Promise<StatutoryPackageMetadata> {
  const row = await prisma.payrollStatutoryPackage.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(ENTITY, id);
  return {
    id: row.id,
    jurisdictionCountry: row.jurisdictionCountry,
    jurisdictionProvince: row.jurisdictionProvince,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    packageVersion: row.packageVersion,
    algorithmVersion: row.algorithmVersion,
    sourcePublication: row.sourcePublication,
    sourceEdition: row.sourceEdition,
    sourcePublicationDate: row.sourcePublicationDate,
    sourceUrl: row.sourceUrl,
    checksum: row.checksum,
  };
}
