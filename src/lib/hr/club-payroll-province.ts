// HR-2B.3.5 (2026-08-19) — Canonical Club payroll-province resolver.
//
// Founder-mandated model: Spectre is built for private Clubs whose
// employees work on-site at the Club. Payroll province of employment
// is therefore a CLUB property, not an employee input. The employee-
// facing TD1 flow reads this resolver's output; it MUST NEVER read a
// province out of browser FormData.
//
// Resolution chain:
//   1. Club.payrollProvince      (explicit, canonical)
//   2. ClubProfile.provinceState (fallback — the physical/operating
//      province the Club records for its own address; kept as a
//      bridge so pre-HR clubs work without a data migration)
//   3. unconfigured              (fail-safe — no employee is asked
//      to guess the applicable province)
//
// Accepted inputs are normalised to a 2-letter Canadian
// province/territory code (AB, BC, MB, NB, NL, NS, NT, NU, ON, PE,
// QC, SK, YT). Full-name variants ("Alberta", "British Columbia")
// map to their codes. Unknown / unsupported values return unconfigured
// rather than throwing so the TD1 UI can render a neutral
// configuration message.
//
// Security invariants:
//   * This module is server-only. It reads the DB directly and MUST
//     be called with an `actor.clubId` already established by the
//     EmployeeOnboardingActor resolver.
//   * Never exposes internal detail to the employee — the caller
//     surfaces `unconfigured` as a neutral "we need one Club payroll
//     setting" message.

import { prisma } from "@/lib/prisma";
import { getProvincialTd1, type Td1FormSpec } from "./td1-forms";

export type CanadianProvinceCode =
  | "AB" | "BC" | "MB" | "NB" | "NL" | "NS"
  | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT";

const SUPPORTED_CODES: ReadonlySet<CanadianProvinceCode> = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

// Names accepted as fallback input. Canonical spellings only — this
// is a normaliser, not a fuzzy match. Longer / official variants are
// present so ClubProfile.provinceState values written as full names
// (e.g. "Alberta") resolve cleanly.
const NAME_TO_CODE: Readonly<Record<string, CanadianProvinceCode>> = {
  ALBERTA: "AB",
  "BRITISH COLUMBIA": "BC",
  MANITOBA: "MB",
  "NEW BRUNSWICK": "NB",
  "NEWFOUNDLAND AND LABRADOR": "NL",
  NEWFOUNDLAND: "NL",
  "NOVA SCOTIA": "NS",
  "NORTHWEST TERRITORIES": "NT",
  NUNAVUT: "NU",
  ONTARIO: "ON",
  "PRINCE EDWARD ISLAND": "PE",
  QUEBEC: "QC",
  "QUÉBEC": "QC",
  SASKATCHEWAN: "SK",
  YUKON: "YT",
};

const CODE_TO_NAME: Readonly<Record<CanadianProvinceCode, string>> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

/** Pure normalisation: string → CanadianProvinceCode or null.
 *  Exposed for tests + admin-side settings validation. */
export function normaliseProvinceCode(raw: string | null | undefined): CanadianProvinceCode | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (SUPPORTED_CODES.has(upper as CanadianProvinceCode)) {
    return upper as CanadianProvinceCode;
  }
  const named = NAME_TO_CODE[upper];
  return named ?? null;
}

export type ClubPayrollProvinceResolution =
  | {
      configured: true;
      /** 2-letter Canadian code. */
      code: CanadianProvinceCode;
      /** Display name ("Alberta"). */
      name: string;
      /** Which field the value came from (for diagnostics + audit). */
      source: "club.payrollProvince" | "clubProfile.provinceState";
      /** Applicable provincial TD1 spec for this code. */
      provincialSpec: Td1FormSpec;
    }
  | {
      configured: false;
      /** Diagnostic reason for the neutral "unconfigured" outcome.
       *  Never rendered to the employee — only surfaced to the caller
       *  so an audit trail / admin-alert can distinguish "field is
       *  empty" from "field holds an unsupported value". */
      reason:
        | "no_club_row"
        | "no_field_set"
        | "unsupported_value"
        | "no_td1_catalogue_entry";
    };

/**
 * Resolve the applicable payroll province for a Club, along with the
 * canonical TD1 provincial form spec. Reads the DB directly; the
 * caller is responsible for having established `clubId` via the
 * EmployeeOnboardingActor resolver.
 *
 * Never throws for a data-shape reason — always returns
 * `{configured: false, reason}` so the calling UI can render the
 * neutral fail-safe copy without leaking internal state.
 */
export async function resolveClubPayrollProvince(
  clubId: string,
): Promise<ClubPayrollProvinceResolution> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true,
      payrollProvince: true,
      profile: {
        select: { provinceState: true },
      },
    },
  });
  if (!club) return { configured: false, reason: "no_club_row" };

  // Prefer the explicit canonical field. Fall back to the address
  // province from ClubProfile so pre-HR clubs (and Coulee Ridge
  // before the post-deploy stamp) keep working automatically.
  const explicit = normaliseProvinceCode(club.payrollProvince);
  const fallback = explicit ? null : normaliseProvinceCode(club.profile?.provinceState ?? null);
  const code = explicit ?? fallback;
  if (!code) {
    // Distinguish "neither field is set" from "a field is set but
    // holds an unsupported value" so the admin-alert can be more
    // useful than a generic error.
    if ((club.payrollProvince ?? "").trim().length > 0 || (club.profile?.provinceState ?? "").trim().length > 0) {
      return { configured: false, reason: "unsupported_value" };
    }
    return { configured: false, reason: "no_field_set" };
  }

  const provincialSpec = getProvincialTd1(code);
  if (!provincialSpec) {
    // The code is a valid CA province but Spectre's TD1 catalogue
    // doesn't have an entry for it. Should not happen for supported
    // provinces, but if the catalogue is ever pruned this preserves
    // the fail-safe behaviour.
    return { configured: false, reason: "no_td1_catalogue_entry" };
  }

  return {
    configured: true,
    code,
    name: CODE_TO_NAME[code],
    source: explicit ? "club.payrollProvince" : "clubProfile.provinceState",
    provincialSpec,
  };
}
