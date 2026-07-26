// Founder rule 2026-07-09: the Flags column on Finance →
// Chart of Accounts shows ONLY currently-supported flag types,
// and the Control flag is DERIVED from the 8 accounting-default
// account references on ClubProfile.
//
// Two layers of coverage:
//
//   • Source-contract tests (this is how the existing COA test
//     suites are shaped) — read the page source and assert the
//     derivation, the legacy-badge removal, and the tooltip
//     wiring.
//   • Behavioural tests — exercise the upsertClubProfile service
//     against a real DB to prove that flipping a default
//     reference moves which accounts qualify as Control.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { upsertClubProfile, getClubProfile } from "@/lib/clubs/profile";

beforeAll(async () => {
  await seedRbac();
});
beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

async function adminFor(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

const PAGE = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/coa/page.tsx"),
  "utf8",
);

describe("Source-contract: Control flag is derived from ClubProfile defaults", () => {
  it("page loads the active club's ClubProfile alongside accounts", () => {
    expect(PAGE).toMatch(/prisma\.clubProfile\.findUnique\(\{\s*where:\s*\{\s*clubId\s*\}\s*\}\)/);
  });

  it("page builds a Set of control-account ids from every accounting-default field", () => {
    expect(PAGE).toContain("controlAccountIds");
    expect(PAGE).toMatch(/controlAccountIds\.add\(id\)/);
    // All 8 founder-listed defaults are enumerated.
    for (const field of [
      "defaultArAccountId",
      "defaultApAccountId",
      "defaultRetainedEarningsAccountId",
      "defaultCurrentYearEarningsAccountId",
      "defaultOperatingBankAccountId",
      "defaultReserveBankAccountId",
      "defaultMemberReceivablesAccountId",
      "defaultSalesTaxPayableAccountId",
    ]) {
      expect(PAGE).toContain(field);
    }
  });

  it("Control badge renders only when the account id is in controlAccountIds", () => {
    expect(PAGE).toMatch(/const isControl = controlAccountIds\.has\(a\.id\)/);
    expect(PAGE).toMatch(/isControl \? \(/);
  });

  it("does NOT use the legacy `!allowManualPosting` derivation for Control", () => {
    // The prior page derived Control from allowManualPosting; that
    // path is gone — the Flags cell never reads allowManualPosting now.
    expect(PAGE).not.toMatch(/!a\.allowManualPosting/);
  });
});

describe("Source-contract: relic badges are gone", () => {
  it("no Bank / Cash / Tax / Header badges on the page", () => {
    expect(PAGE).not.toMatch(/isBankAccount/);
    expect(PAGE).not.toMatch(/isCashAccount/);
    expect(PAGE).not.toMatch(/isTaxRelevant/);
    expect(PAGE).not.toMatch(/a\.isHeader/);
    expect(PAGE).not.toMatch(/>Bank</);
    expect(PAGE).not.toMatch(/>Cash</);
    expect(PAGE).not.toMatch(/>Tax</);
    expect(PAGE).not.toMatch(/>Header</);
  });

  it("accounts with no flags render an em dash rather than an empty cell", () => {
    expect(PAGE).toMatch(/<span className="text-stone-400">—<\/span>/);
  });
});

describe("Source-contract: Flags info tooltip", () => {
  it("renders a FlagsInfoTip beside the Flags column header", () => {
    expect(PAGE).toContain("FlagsInfoTip");
    expect(PAGE).toContain('data-testid="coa-flags-info"');
  });

  it("tooltip lists ONLY currently-supported flag types (Control + Inactive)", () => {
    // Collapse whitespace so the source's JSX line wraps don't
    // matter — we're asserting the surfaced text shape.
    const collapsed = PAGE.replace(/\s+/g, " ");
    expect(collapsed).toContain("Flags identify special-purpose accounts used by Spectre.");
    expect(collapsed).toContain("Control");
    expect(collapsed).toContain("Account is used by Spectre as a system control / default account through Club Settings.");
    expect(collapsed).toContain("Inactive");
    expect(collapsed).toContain("Account is not currently active and cannot be selected for new transactions.");
    // Restricted + System are NOT listed (no backing data yet).
    expect(collapsed).not.toMatch(/>Restricted</);
    expect(collapsed).not.toMatch(/>System</);
  });
});

describe("Behaviour: changing a Club Settings default moves the Control derivation", () => {
  it("default A/R account is added to the control set; switching it moves the membership", async () => {
    const c = await bootstrapAPClub("Defaults-Move-AR");
    const p = await adminFor(c.id);
    const [arA, arB] = await db().account.findMany({
      where: { clubId: c.id, type: "ASSET", isActive: true },
      take: 2,
      orderBy: { accountNumber: "asc" },
    });

    await upsertClubProfile(p, c.id, { defaultArAccountId: arA.id });
    let profile = await getClubProfile(p, c.id);
    expect(controlIdsFromProfile(profile)).toContain(arA.id);
    expect(controlIdsFromProfile(profile)).not.toContain(arB.id);

    // Re-point to the second account.
    await upsertClubProfile(p, c.id, { defaultArAccountId: arB.id });
    profile = await getClubProfile(p, c.id);
    expect(controlIdsFromProfile(profile)).toContain(arB.id);
    expect(controlIdsFromProfile(profile)).not.toContain(arA.id);
  });

  it("default Sales Tax Payable account becomes a Control derivation", async () => {
    const c = await bootstrapAPClub("Defaults-Sales-Tax");
    const p = await adminFor(c.id);
    const taxAcct = await db().account.findFirst({
      where: { clubId: c.id, type: "LIABILITY", isActive: true },
    });
    if (!taxAcct) throw new Error("No liability account in seed");
    await upsertClubProfile(p, c.id, { defaultSalesTaxPayableAccountId: taxAcct.id });
    const profile = await getClubProfile(p, c.id);
    expect(controlIdsFromProfile(profile)).toContain(taxAcct.id);
  });

  it("clearing a default removes its account from the control set", async () => {
    // The Club Settings form posts the FULL state on every save,
    // so clearing happens by sending the entire profile with the
    // field set to null. upsertClubProfile preserves `undefined`
    // (treats it as "leave alone"), which is how partial saves
    // work elsewhere — so for this test we write the cleared
    // state directly through prisma to mirror what the form's
    // full-state save lands on the row.
    const c = await bootstrapAPClub("Defaults-Clear");
    const p = await adminFor(c.id);
    const ap = await db().account.findFirst({
      where: { clubId: c.id, type: "LIABILITY", isActive: true },
    });
    if (!ap) throw new Error("no LIABILITY seed");
    await upsertClubProfile(p, c.id, { defaultApAccountId: ap.id });
    let profile = await getClubProfile(p, c.id);
    expect(controlIdsFromProfile(profile)).toContain(ap.id);

    await db().clubProfile.update({
      where: { clubId: c.id },
      data: { defaultApAccountId: null },
    });
    profile = await getClubProfile(p, c.id);
    expect(controlIdsFromProfile(profile)).not.toContain(ap.id);
  });

  it("multiple defaults pointing at the same account → only ONE Control badge would render (Set dedup)", async () => {
    const c = await bootstrapAPClub("Defaults-Dedup");
    const p = await adminFor(c.id);
    const acct = await db().account.findFirst({
      where: { clubId: c.id, type: "ASSET", isActive: true },
    });
    if (!acct) throw new Error("no ASSET seed");
    await upsertClubProfile(p, c.id, {
      defaultArAccountId: acct.id,
      defaultMemberReceivablesAccountId: acct.id,
    });
    const profile = await getClubProfile(p, c.id);
    const ids = controlIdsFromProfile(profile);
    expect(ids.filter((x) => x === acct.id)).toHaveLength(1);
  });

  it("an account that is NOT referenced by any default does not gain a Control derivation", async () => {
    const c = await bootstrapAPClub("Defaults-Other");
    const p = await adminFor(c.id);
    const [chosen, other] = await db().account.findMany({
      where: { clubId: c.id, type: "ASSET", isActive: true },
      take: 2,
      orderBy: { accountNumber: "asc" },
    });
    await upsertClubProfile(p, c.id, { defaultArAccountId: chosen.id });
    const profile = await getClubProfile(p, c.id);
    expect(controlIdsFromProfile(profile)).toContain(chosen.id);
    expect(controlIdsFromProfile(profile)).not.toContain(other.id);
  });
});

// Local mirror of the page's derivation — the test exercises the
// same shape the page uses, so any change to the field list on
// the page must update this helper too.
function controlIdsFromProfile(
  profile: { [k: string]: unknown } | null | undefined,
): string[] {
  if (!profile) return [];
  const fields = [
    "defaultArAccountId",
    "defaultApAccountId",
    "defaultRetainedEarningsAccountId",
    "defaultCurrentYearEarningsAccountId",
    "defaultOperatingBankAccountId",
    "defaultReserveBankAccountId",
    "defaultMemberReceivablesAccountId",
    "defaultSalesTaxPayableAccountId",
  ] as const;
  const out = new Set<string>();
  for (const f of fields) {
    const v = profile[f];
    if (typeof v === "string" && v.length > 0) out.add(v);
  }
  return Array.from(out);
}
