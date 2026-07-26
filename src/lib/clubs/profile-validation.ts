// Zod schema for the Admin → Club Settings form.
//
// Shared between the service (src/lib/clubs/profile.ts) and the
// server action (src/app/app/admin/club-settings/_actions.ts) so the
// same validation rules apply on every entry path.
//
// Conventions:
//   - Every field is optional at the schema level — the table is upsert
//     and partial saves are legal (e.g. an admin filling tax fields
//     before the bank fields).
//   - String fields trim and coerce empty string → undefined so the
//     stored value is null, not "".
//   - Year, month, day fields use number coercion so FormData entries
//     (always strings) round-trip cleanly.
//   - GST rate is a Prisma Decimal — Zod handles it as a string in
//     transit and the service casts on write.

import { z } from "zod";

// ---- helpers --------------------------------------------------------

const emptyToUndef = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.unknown(),
);

const optionalTrimmedString = (max = 255) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      // Empty-string inputs from form fields must collapse to
      // `undefined` so they round-trip cleanly through `.optional()`.
      // Without this, an empty optional field (e.g. mailingAddress on
      // a profile where that field is genuinely blank) fails
      // `z.string().min(1)` and rejects the WHOLE save — silently
      // blocking unrelated edits like a fiscal-year-end change.
      return trimmed === "" ? undefined : trimmed;
    },
    z.string().min(1).max(max).optional(),
  );

const optionalInt = (min: number, max: number) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "string") {
        if (v.trim() === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      }
      return v;
    },
    z.number().int().min(min).max(max).optional(),
  );

const optionalEmail = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().email("Invalid email address").max(255).optional().or(z.literal("").transform(() => undefined)),
);

const optionalUrl = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (!t) return undefined;
    // Allow bare domain entries by auto-prefixing https:// so the form
    // doesn't fight the user who types "silversprings.club".
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  },
  z.string().url("Invalid URL").max(500).optional(),
);

// Canadian business number — 9 digits, optionally followed by program
// + reference like RP0001. We accept both 123456789 and 123456789RT0001
// styles and only reject obvious garbage.
const optionalBusinessNumber = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, "") : v),
  z.string().regex(/^\d{9}([A-Z]{2}\d{4})?$/i, "Use 9 digits, optionally followed by a program/reference (e.g. 123456789 RT0001)").optional()
    .or(z.literal("").transform(() => undefined)),
);

// Canadian GST/HST number — same shape: 9 digits + optional RT0001.
const optionalGstNumber = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, "") : v),
  z.string().regex(/^\d{9}(RT\d{4})?$/i, "Use 9 digits, optionally followed by RT and 4 digits (e.g. 123456789 RT0001)").optional()
    .or(z.literal("").transform(() => undefined)),
);

const currentYear = new Date().getUTCFullYear();
const optionalFoundedYear = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string") {
      if (v.trim() === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  },
  z.number().int().min(1800, "Year must be 1800 or later")
    .max(currentYear, `Year cannot be in the future (max ${currentYear})`)
    .optional(),
);

// Tax-registration enum strings — open enum so future statuses don't
// require a migration.
const GST_STATUS_VALUES = ["REGISTERED", "NOT_REGISTERED", "SMALL_SUPPLIER"] as const;
const GST_FILING_VALUES = ["MONTHLY", "QUARTERLY", "ANNUAL"] as const;

const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(values).optional(),
  );

// GST rate as decimal string. Service casts to Prisma Decimal on write.
const optionalDecimalString = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number") return v.toString();
    if (typeof v === "string") {
      const t = v.trim();
      return t === "" ? undefined : t;
    }
    return v;
  },
  z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Use a percentage like 5 or 12.50").optional(),
);

// Currency code — 3 uppercase ISO 4217 letters.
const optionalCurrency = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code (e.g. CAD, USD)").optional()
    .or(z.literal("").transform(() => undefined)),
);

// CUID account references (Prisma default cuid() prefix is "c…"). We
// accept any string here; the tenant-isolation check in the service
// verifies the account actually belongs to the current club.
const optionalAccountId = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).max(64).optional(),
);

// ---- schema --------------------------------------------------------

export const clubProfileInputSchema = z.object({
  // Identity
  legalName: optionalTrimmedString(255),
  operatingName: optionalTrimmedString(255),
  yearFounded: optionalFoundedYear,
  businessNumber: optionalBusinessNumber,
  gstNumber: optionalGstNumber,

  // Fiscal year end as month/day; sanity-check that the pair forms a
  // valid calendar day. We tolerate one being set and the other missing
  // (form-in-progress) at the schema layer; the service layer treats
  // "neither set" as "fiscal period not configured" and falls back.
  fiscalYearEndMonth: optionalInt(1, 12),
  fiscalYearEndDay: optionalInt(1, 31),

  // Address & contact
  mailingAddress: optionalTrimmedString(500),
  physicalAddress: optionalTrimmedString(500),
  city: optionalTrimmedString(120),
  provinceState: optionalTrimmedString(120),
  mainPhone: optionalTrimmedString(40),
  generalEmail: optionalEmail,
  websiteUrl: optionalUrl,
  primaryContactName: optionalTrimmedString(255),
  primaryContactTitle: optionalTrimmedString(255),
  primaryContactEmail: optionalEmail,
  primaryContactPhone: optionalTrimmedString(40),

  // Tax registration
  gstStatus: optionalEnum(GST_STATUS_VALUES),
  gstFilingFrequency: optionalEnum(GST_FILING_VALUES),
  defaultGstRatePct: optionalDecimalString,

  // Reporting
  defaultCurrency: optionalCurrency,

  // Accounting defaults — Account.id values. Each one is tenant-asserted
  // by the service before write.
  defaultArAccountId: optionalAccountId,
  defaultApAccountId: optionalAccountId,
  defaultRetainedEarningsAccountId: optionalAccountId,
  defaultCurrentYearEarningsAccountId: optionalAccountId,
  defaultOperatingBankAccountId: optionalAccountId,
  defaultReserveBankAccountId: optionalAccountId,
  defaultMemberReceivablesAccountId: optionalAccountId,
  defaultSalesTaxPayableAccountId: optionalAccountId,
}).superRefine((val, ctx) => {
  // Cross-field: if EITHER fiscalYearEndMonth OR fiscalYearEndDay is
  // set, BOTH must be set AND they must form a valid calendar day.
  const m = val.fiscalYearEndMonth;
  const d = val.fiscalYearEndDay;
  if ((m === undefined) !== (d === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Set both fiscal-year-end month and day, or leave both empty.",
      path: [m === undefined ? "fiscalYearEndMonth" : "fiscalYearEndDay"],
    });
    return;
  }
  if (m !== undefined && d !== undefined) {
    // Use leap-year 2024 so Feb 29 is allowed.
    const trial = new Date(Date.UTC(2024, m - 1, d));
    if (trial.getUTCMonth() !== m - 1 || trial.getUTCDate() !== d) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Fiscal year end ${m}/${d} is not a valid calendar day.`,
        path: ["fiscalYearEndDay"],
      });
    }
  }
});

export type ClubProfileInput = z.infer<typeof clubProfileInputSchema>;

// Marker re-export used by the type sanity check in profile.ts.
export type _SchemaShapeMarker = ClubProfileInput;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _emptyToUndefUnused = emptyToUndef;
