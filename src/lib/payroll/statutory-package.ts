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

  // ---- Canada Pension Plan ----
  cpp: z.object({
    /** Year's Maximum Pensionable Earnings (YMPE), CAD. */
    ympe: DecimalString,
    /** Year's Additional Maximum Pensionable Earnings (YAMPE), CAD. */
    yampe: DecimalString,
    /** Year's Basic Exemption (YBE), CAD. */
    ybe: DecimalString,
    /** Base CPP employee contribution rate (decimal). */
    baseRateEE: DecimalString,
    /** Enhanced CPP2 employee contribution rate (decimal). */
    cpp2RateEE: DecimalString,
    /** Employer CPP rate — equals employee CPP by statute. */
    baseRateER: DecimalString,
    cpp2RateER: DecimalString,
  }),

  // ---- Employment Insurance ----
  ei: z.object({
    /** Maximum Insurable Earnings (MIE), CAD. */
    mie: DecimalString,
    /** Employee EI premium rate (decimal). Quebec has a separate rate. */
    rateEE: DecimalString,
    /** Employer EI multiplier applied to employee premium (typically 1.4). */
    employerMultiplier: DecimalString,
  }),

  // ---- Federal income tax (T4127 §5) ----
  federal: z.object({
    brackets: z.array(TaxBracket).min(1),
    /**
     * Federal Basic Personal Amount (BPA). Under Bill C-30 the BPA
     * is tiered by income; a future evolution may split into
     * (bpaLow, bpaHigh, incomeThreshold). For v1 we keep the two
     * BPA values + threshold explicit.
     */
    bpaLow: DecimalString,
    bpaHigh: DecimalString,
    bpaPhaseOutStart: DecimalString,
    bpaPhaseOutEnd: DecimalString,
    /** Non-refundable credit rate applied to BPA + TD1F claim. */
    lowestRate: DecimalString,
    /** CPP2 deduction rate applied to CPP2 EE contributions when computing taxable income. */
    cpp2DeductionRate: DecimalString,
  }),

  // ---- Provincial (Alberta MVP) ----
  provincial: z
    .object({
      brackets: z.array(TaxBracket).min(1),
      /** Provincial Basic Personal Amount. */
      bpa: DecimalString,
      /** Provincial lowest rate applied to BPA + TD1P. */
      lowestRate: DecimalString,
    })
    .nullable(),

  // ---- Rounding rules ----
  rounding: z.object({
    /** Rounding mode for CPP / EI / tax withholding cents. */
    mode: z.enum(["HALF_UP", "HALF_EVEN", "TRUNCATE"]),
    /** Rounding for total net pay cents. */
    netPayMode: z.enum(["HALF_UP", "HALF_EVEN", "TRUNCATE"]),
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
