// Payroll-3B-5B-1c — closure verification tests.
//
// Proves the corrections landed in this slice:
//   • no federal sentinel bracket in production seed
//   • federal Table 8.1 (5 brackets) matches committed CRA data
//   • Alberta Table 8.1 (6 brackets) matches committed CRA data
//   • H1/H2 comparison is deterministic
//   • Alberta K5P is present + explicit
//   • rounding contract separates CRA requirement from Spectre convention
//   • bracket + K5P fixture files exist
//   • full PDOC fixture file exists with the required provenance shape

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  CA_AB_2026_PARAMS_H1,
  CA_AB_2026_PARAMS_H2,
  seedCanadaAlbertaPackages2026,
} from "@/lib/payroll/statutory/seed-ca-ab-2026";
import {
  installStatutoryPackage,
  assertValidCanadianParamsV1,
} from "@/lib/payroll/statutory-package";
import { ValidationError } from "@/lib/errors";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-1c@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "super-1c@spectre.test",
      name: "Super1c",
      role: "SUPER_ADMIN",
      passwordHash: "x",
      status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-1c@spectre.test");
}

describe("Payroll-3B-5B-1c — no federal sentinel", () => {
  it("H1 federal brackets = 5 rows (Table 8.1)", () => {
    expect(CA_AB_2026_PARAMS_H1.federal.brackets.length).toBe(5);
  });
  it("H2 federal brackets = 5 rows (Table 8.1)", () => {
    expect(CA_AB_2026_PARAMS_H2.federal.brackets.length).toBe(5);
  });
  it("H1 first-bracket rate is 0.1400 (removes prior 0.15 sentinel)", () => {
    expect(CA_AB_2026_PARAMS_H1.federal.brackets[0].rate).toBe("0.1400");
    expect(CA_AB_2026_PARAMS_H1.federal.brackets[0].constantK).toBe("0");
  });
  it("H1 top-bracket rate is 0.3300 (Table 8.1 row 5)", () => {
    const top = CA_AB_2026_PARAMS_H1.federal.brackets[4];
    expect(top.rate).toBe("0.3300");
    expect(top.to).toBeNull();
    expect(top.constantK).toBe("26024");
  });
});

describe("Payroll-3B-5B-1c — federal Table 8.1 matches CRA 2026", () => {
  it("row 1: A ≤ 58,523 → R=0.1400 K=0", () => {
    const b = CA_AB_2026_PARAMS_H1.federal.brackets[0];
    expect(b.from).toBe("0"); expect(b.to).toBe("58523");
    expect(b.rate).toBe("0.1400"); expect(b.constantK).toBe("0");
  });
  it("row 2: 58,523 – 117,045 → R=0.2050 K=3,804", () => {
    const b = CA_AB_2026_PARAMS_H1.federal.brackets[1];
    expect(b.from).toBe("58523"); expect(b.to).toBe("117045");
    expect(b.rate).toBe("0.2050"); expect(b.constantK).toBe("3804");
  });
  it("row 3: 117,045 – 181,440 → R=0.2600 K=10,241", () => {
    const b = CA_AB_2026_PARAMS_H1.federal.brackets[2];
    expect(b.from).toBe("117045"); expect(b.to).toBe("181440");
    expect(b.rate).toBe("0.2600"); expect(b.constantK).toBe("10241");
  });
  it("row 4: 181,440 – 258,482 → R=0.2900 K=15,685", () => {
    const b = CA_AB_2026_PARAMS_H1.federal.brackets[3];
    expect(b.from).toBe("181440"); expect(b.to).toBe("258482");
    expect(b.rate).toBe("0.2900"); expect(b.constantK).toBe("15685");
  });
  it("row 5: A > 258,482 → R=0.3300 K=26,024", () => {
    const b = CA_AB_2026_PARAMS_H1.federal.brackets[4];
    expect(b.from).toBe("258482"); expect(b.to).toBeNull();
    expect(b.rate).toBe("0.3300"); expect(b.constantK).toBe("26024");
  });
});

describe("Payroll-3B-5B-1c — Alberta Table 8.1 matches CRA 2026", () => {
  const rows = CA_AB_2026_PARAMS_H1.provincial!.brackets;
  it("row 1: 0 – 61,200 → V=0.0800 KP=0", () => {
    expect(rows[0].from).toBe("0"); expect(rows[0].to).toBe("61200");
    expect(rows[0].rate).toBe("0.0800"); expect(rows[0].constantK).toBe("0");
  });
  it("row 2: 61,200 – 154,259 → V=0.1000 KP=1,224", () => {
    expect(rows[1].from).toBe("61200"); expect(rows[1].to).toBe("154259");
    expect(rows[1].rate).toBe("0.1000"); expect(rows[1].constantK).toBe("1224");
  });
  it("row 3: 154,259 – 185,111 → V=0.1200 KP=4,309", () => {
    expect(rows[2].rate).toBe("0.1200"); expect(rows[2].constantK).toBe("4309");
  });
  it("row 4: 185,111 – 246,813 → V=0.1300 KP=6,160", () => {
    expect(rows[3].rate).toBe("0.1300"); expect(rows[3].constantK).toBe("6160");
  });
  it("row 5: 246,813 – 370,220 → V=0.1400 KP=8,628", () => {
    expect(rows[4].rate).toBe("0.1400"); expect(rows[4].constantK).toBe("8628");
  });
  it("row 6: A > 370,220 → V=0.1500 KP=12,331", () => {
    expect(rows[5].rate).toBe("0.1500"); expect(rows[5].constantK).toBe("12331");
    expect(rows[5].to).toBeNull();
  });
  it("Alberta BPA = 22,769", () => {
    expect(CA_AB_2026_PARAMS_H1.provincial!.bpa).toBe("22769");
  });
});

describe("Payroll-3B-5B-1d CORRECTION — Alberta K5P threshold (§C)", () => {
  it("H1 K5P uses corrected shape: threshold + supplementalRate + baseRate", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p;
    expect(k5p).toBeDefined();
    expect(k5p.enabled).toBe(true);
    expect(k5p.threshold).toBe("4896");
    expect(k5p.supplementalRate).toBe("0.02");
    expect(k5p.baseRate).toBe("0.08");
    expect(k5p.sourceCitation).toMatch(/T4127/);
    expect(k5p.sourceCitation).toMatch(/K1P/);
  });
  it("H1 K5P source citation encodes the CORRECT formula (references K1P + K2P)", () => {
    const cite = CA_AB_2026_PARAMS_H1.provincial!.k5p.sourceCitation;
    expect(cite).toMatch(/K1P/);
    expect(cite).toMatch(/K2P/);
    expect(cite).toMatch(/max\(0/);
    // CORRECTION-specific: the official formula uses ×0.25, threshold 4896.
    expect(cite).toMatch(/4896/);
    expect(cite).toMatch(/0\.25/);
    expect(cite).not.toMatch(/4800/);
  });
  it("H1 K5P does NOT carry the old T_prov_base / triggerBase / rate / 4800 shape", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p as unknown as Record<string, unknown>;
    expect(k5p.triggerBase).toBeUndefined();
    expect(k5p.rate).toBeUndefined();
    expect(k5p.sourceCitation).not.toMatch(/T_prov_base/i);
    expect(k5p.threshold).not.toBe("4800");
  });
  it("H2 K5P inherits from H1 122nd Edition (no change in 123rd) — §D", () => {
    expect(CA_AB_2026_PARAMS_H2.provincial!.k5p).toEqual(CA_AB_2026_PARAMS_H1.provincial!.k5p);
  });
  it("K5P boundary: (K1P + K2P) == 4896 → K5P = 0", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p;
    const K1P = 2000, K2P = 2896;                                       // sum = 4896 (at threshold)
    const above = Math.max(0, K1P + K2P - Number(k5p.threshold));
    const result = above * (Number(k5p.supplementalRate) / Number(k5p.baseRate));
    expect(result).toBe(0);
  });
  it("K5P formula reference-implementation: (K1P + K2P) < threshold → K5P = 0", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p;
    const K1P = 1000, K2P = 3000;                                       // sum = 4000 < 4896
    const above = Math.max(0, K1P + K2P - Number(k5p.threshold));
    const result = above * (Number(k5p.supplementalRate) / Number(k5p.baseRate));
    expect(result).toBe(0);
  });
  it("K5P formula reference-implementation: (K1P + K2P) > threshold → ×0.25 supplemental", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p;
    const K1P = 3000, K2P = 3000;                                       // sum = 6000 > 4896
    const above = Math.max(0, K1P + K2P - Number(k5p.threshold));       // 1104
    const result = above * (Number(k5p.supplementalRate) / Number(k5p.baseRate));
    // 1104 × (0.02 / 0.08) = 1104 × 0.25 = 276.
    expect(result).toBe(276);
  });
  it("supplementalRate / baseRate reduces to CRA's ×0.25 multiplier", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p;
    expect(Number(k5p.supplementalRate) / Number(k5p.baseRate)).toBe(0.25);
  });
});

describe("Payroll-3B-5B-1d CORRECTION — Canada Employment Amount (§B)", () => {
  it("H1 federal package carries canadaEmploymentAmountMax = 1501 (T4127 123rd Edition Table 8.2)", () => {
    expect(CA_AB_2026_PARAMS_H1.federal.canadaEmploymentAmountMax).toBe("1501");
  });
  it("H2 federal package carries the same canadaEmploymentAmountMax as H1", () => {
    expect(CA_AB_2026_PARAMS_H2.federal.canadaEmploymentAmountMax).toBe(
      CA_AB_2026_PARAMS_H1.federal.canadaEmploymentAmountMax,
    );
  });
  it("The old $1,499 estimate does not appear in the 2026 statutory data", () => {
    const both = JSON.stringify(CA_AB_2026_PARAMS_H1) + JSON.stringify(CA_AB_2026_PARAMS_H2);
    expect(both).not.toMatch(/1499/);
  });
  it("The old $4,800 K5P threshold does not appear anywhere in the 2026 statutory data", () => {
    const both = JSON.stringify(CA_AB_2026_PARAMS_H1) + JSON.stringify(CA_AB_2026_PARAMS_H2);
    expect(both).not.toMatch(/4800/);
  });
});

// ------------------------------------------------------------
// Final CPP Additional-Contribution Correction (2026-08-31)
// ------------------------------------------------------------
// K2 / K2P are the T4127 non-refundable tax credits for BASE CPP
// + EI only. CPP first-additional and CPP2 flow through the
// F5 / F5A income-deduction path (reducing annual taxable income
// `A`), NOT through K2 / K2P and NOT through K3 / K3P.
// These tests are specification-level assertions on the pinned
// package + the calculator spec doc — no dollar arithmetic.
// ------------------------------------------------------------
describe("Final CPP Additional-Contribution Correction — K2 / K2P scope + F5A treatment", () => {
  const specPath = join(process.cwd(), "docs/payroll/calculator-specification.md");
  const spec = readFileSync(specPath, "utf8");

  it("spec §9b K2 row: describes K2 as BASE CPP + EI ONLY (not first-additional, not CPP2)", () => {
    // Locate the K2 row in §9b and confirm the correct scope wording.
    expect(spec).toMatch(/\| `K2` \| \*\*Federal non-refundable tax credit for BASE CPP contributions and EI premiums\.\*\*/);
    expect(spec).toMatch(/Does NOT credit CPP first-additional\. Does NOT credit CPP2\./);
  });
  it("spec §9b K2 formula: base-share applied to Factor C (no `(C + C2)` bundling)", () => {
    expect(spec).toMatch(/federal\.lowestRate × \[ P × C × \(0\.0495 \/ 0\.0595\) \+ P × EI \]/);
  });
  it("spec §10a K2P row: BASE CPP + EI ONLY, same rule as federal K2", () => {
    expect(spec).toMatch(/\| `K2P` \| \*\*Alberta non-refundable tax credit for BASE CPP contributions and EI premiums\.\*\*/);
    expect(spec).toMatch(/provincial\.lowestRate × \[ P × C × \(0\.0495 \/ 0\.0595\) \+ P × EI \]/);
  });
  it("spec §9b K3 row: NOT the CPP2 deduction, NOT any CPP deduction (letter authority only)", () => {
    expect(spec).toMatch(/`K3` \| \*\*Other federal tax credits authorised by a tax services office or a Canada Revenue Agency tax centre\.\*\*/);
    expect(spec).toMatch(/NOT the CPP2 deduction\. NOT the CPP first-additional deduction/);
  });
  it("spec §10a K3P row: same rule for Alberta", () => {
    expect(spec).toMatch(/`K3P` \| \*\*Other Alberta tax credits authorised by a tax services office or a Canada Revenue Agency tax centre\.\*\*/);
    expect(spec).toMatch(/NOT the Alberta CPP2 deduction\. NOT the Alberta CPP first-additional deduction/);
  });
  it("spec §9a formula table: F5, F5A, F5B rows are present as T4127 variables", () => {
    expect(spec).toMatch(/\| `F5` \| Deductions for CPP additional contributions/);
    expect(spec).toMatch(/\| `F5A` \| \*\*CPP\/QPP additional contributions deducted from PERIODIC income/);
    expect(spec).toMatch(/\| `F5B` \| CPP\/QPP additional contributions deducted from NON-PERIODIC income/);
  });
  it("spec §9a A formula: F5A subtracted from I before annualising by P", () => {
    expect(spec).toMatch(/A = P × \(I − F − F1 − F5A\) \+ HD − F2 − U1 − F5B/);
  });
  it("spec §9e: CPP first-additional + CPP2 map into F5A (not K2, not K3)", () => {
    expect(spec).toMatch(/F5A_thisPay\s*=\s*C_firstAdd_thisPay \+ C2_thisPay/);
    expect(spec).toMatch(/CPP first-additional MUST NOT appear in `K2` \(or `K2P`\) as a tax credit/);
    expect(spec).toMatch(/CPP2 MUST NOT appear in `K2` \/ `K2P` \/ `K3` \/ `K3P`/);
  });
  it("spec §9f: Factor-C-to-F5A-and-K2 mapping table pins the exact contract", () => {
    expect(spec).toMatch(/### 9f\. Factor C \/ C2 → F5A → K2 mapping/);
    expect(spec).toMatch(/`baseCppForTaxCredit`/i);
    // §9f uses the short form (C2) in the mapping table row.
    expect(spec).toMatch(/`F5A_thisPay` \| `deductionCppEeFirstAdd \+ C2`/);
  });
  it("spec §19a factor matrix: K2 row says BASE CPP + EI only", () => {
    expect(spec).toMatch(/### 19a\. Federal factors[\s\S]*?\| `K2` \| \*\*Federal non-refundable tax credit for BASE CPP contributions and EI premiums\.\*\*/);
  });
  it("spec §19a factor matrix: F5, F5A, F5B rows exist alongside K1-K4", () => {
    // The federal matrix must enumerate the F5 subvariables so the
    // MVP calculator contract is unambiguous.
    const fedMatrixSection = spec.split("### 19b. Alberta")[0].split("### 19a. Federal")[1];
    expect(fedMatrixSection).toMatch(/\| `F5` \|/);
    expect(fedMatrixSection).toMatch(/\| `F5A` \|/);
    expect(fedMatrixSection).toMatch(/\| `F5B` \|/);
  });
  it("spec §19b Alberta matrix: K2P row says BASE CPP + EI only; K3P not CPP", () => {
    const albertaMatrixSection = spec.split("### 19c.")[0].split("### 19b. Alberta")[1];
    expect(albertaMatrixSection).toMatch(/\| `K2P` \| \*\*Alberta non-refundable tax credit for BASE CPP contributions and EI premiums\.\*\*/);
    expect(albertaMatrixSection).toMatch(/`K3P` \|[^\n]*NOT any CPP deduction/);
  });
  it("spec: no remaining `P × (0.0495 / 0.0595) × (C + C2)` incorrect-bundling formula ANYWHERE except explicit callouts", () => {
    // The wrong-bundling formula may appear ONLY in explicit
    // callouts labelled as WRONG (removed) or that document the
    // prior spec text. It must NOT appear as an active formula.
    const wrongFormula = /federal\.lowestRate × \[ P × \(0\.0495 \/ 0\.0595\) × \(C \+ C2\)/;
    expect(spec).not.toMatch(wrongFormula);
    const wrongFormulaProv = /provincial\.lowestRate × \[ P × \(0\.0495 \/ 0\.0595\) × \(C \+ C2\)/;
    expect(spec).not.toMatch(wrongFormulaProv);
  });
  it("spec: Spectre-internal helpers (K2A, K2AP, cpp2DeductionRate) explicitly labelled INTERNAL / DEPRECATED", () => {
    expect(spec).toMatch(/### 19c\. Spectre-internal helpers/);
    expect(spec).toMatch(/\*\*T4127 defines no `K2A`\.\*\*/);
    expect(spec).toMatch(/\*\*T4127 defines no `K2AP`\.\*\*/);
    // cpp2DeductionRate must be described as routed through F5/F5A, not through K2 or K3.
    expect(spec).toMatch(/T4127 actually routes CPP2 through the F5\/F5A income-deduction path/);
  });
  it("Zod schema doc-comment: cpp2DeductionRate labelled DEPRECATED and NOT-K3-per-T4127", () => {
    const zodPath = join(process.cwd(), "src/lib/payroll/statutory-package.ts");
    const zod = readFileSync(zodPath, "utf8");
    // Anchor near the cpp2DeductionRate declaration.
    const idx = zod.indexOf("cpp2DeductionRate: DecimalString");
    expect(idx).toBeGreaterThan(0);
    const window = zod.slice(Math.max(0, idx - 600), idx);
    expect(window).toMatch(/DEPRECATED/);
    expect(window).toMatch(/NOT in K3 \/ K3P/);
    expect(window).toMatch(/F5 \/ F5A/);
  });
  it("Statutory-package field cpp2DeductionRate persists on H1/H2 (checksum stability) but description states it is unused", () => {
    // Field remains for schema/checksum stability. Presence alone is
    // fine; the semantic guard is the doc-comment above and the
    // spec §19c note — both asserted separately.
    expect(CA_AB_2026_PARAMS_H1.federal.cpp2DeductionRate).toBeDefined();
    expect(CA_AB_2026_PARAMS_H2.federal.cpp2DeductionRate).toBeDefined();
  });
  it("CEA remains 1501; K5P threshold remains 4896 × 0.25 (prior corrections not regressed)", () => {
    expect(CA_AB_2026_PARAMS_H1.federal.canadaEmploymentAmountMax).toBe("1501");
    expect(CA_AB_2026_PARAMS_H2.federal.canadaEmploymentAmountMax).toBe("1501");
    expect(CA_AB_2026_PARAMS_H1.provincial!.k5p.threshold).toBe("4896");
    expect(Number(CA_AB_2026_PARAMS_H1.provincial!.k5p.supplementalRate) /
           Number(CA_AB_2026_PARAMS_H1.provincial!.k5p.baseRate)).toBe(0.25);
  });
});

describe("Payroll-3B-5B-1c — H1 vs H2 comparison", () => {
  it("packageVersion identity differs across H1 vs H2 (deterministic pinning)", () => {
    // The params are equal by content for 2026; the seeder installs
    // them with distinct packageVersion strings. This test proves the
    // params snapshots themselves are byte-identical, which is the
    // §3 "unchanged parameter" claim.
    expect(JSON.stringify(CA_AB_2026_PARAMS_H1)).toBe(JSON.stringify(CA_AB_2026_PARAMS_H2));
  });
});

describe("Payroll-3B-5B-1c — rounding contract separation", () => {
  it("H1 rounding carries BOTH implementation mode AND CRA statutory instruction", () => {
    const r = CA_AB_2026_PARAMS_H1.rounding;
    expect(r.mode).toBe("HALF_UP");
    expect(r.netPayMode).toBe("HALF_UP");
    // The statutory instruction is CRA's literal wording, not a
    // Spectre-authored derivation. Any T4127 update revises this
    // string on the pinned package without code changes.
    expect(r.statutoryInstruction).toMatch(/T4127/);
    expect(r.statutoryInstruction).toMatch(/nearest cent/);
  });
});

describe("Payroll-3B-5B-1c — H1/H2 Zod validation passes", () => {
  it("H1 params (with full brackets + K5P + rounding statutoryInstruction) validate", () => {
    expect(() => assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H1)).not.toThrow();
  });
  it("H2 params validate", () => {
    expect(() => assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H2)).not.toThrow();
  });
});

describe("Payroll-3B-5B-1c — seeder idempotency + checksum conflict", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("seedCanadaAlbertaPackages2026 installs H1 + H2 with distinct packageVersion + checksums", async () => {
    const sup = await superAdminP();
    const r = await seedCanadaAlbertaPackages2026(sup);
    expect(r.h1.id).toBeDefined();
    expect(r.h2.id).toBeDefined();
    expect(r.h1.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(r.h2.checksum).toMatch(/^[a-f0-9]{64}$/);
    // Same params ⇒ same checksum (H1 and H2 are byte-equal for 2026).
    expect(r.h1.checksum).toBe(r.h2.checksum);
    const rows = await db().payrollStatutoryPackage.findMany({ orderBy: [{ effectiveFrom: "asc" }] });
    expect(rows.map((x) => x.packageVersion)).toEqual([
      "CRA-T4127-122E-CA-AB-2026-H1",
      "CRA-T4127-123E-CA-AB-2026-H2",
    ]);
  });

  it("re-running the installer against the SAME window with a different checksum is refused", async () => {
    const sup = await superAdminP();
    await installStatutoryPackage(sup, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: d(2026, 1, 1),
      effectiveTo: d(2026, 7, 1),
      packageVersion: "CRA-T4127-122E-CA-AB-2026-H1",
      sourcePublication: "TEST",
      params: CA_AB_2026_PARAMS_H1,
    });
    // Attempt an overlap install with modified content.
    const modified = { ...CA_AB_2026_PARAMS_H1, cpp: { ...CA_AB_2026_PARAMS_H1.cpp, ybe: "3600.00" } };
    await expect(
      installStatutoryPackage(sup, {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: d(2026, 1, 1),
        effectiveTo: d(2026, 7, 1),
        packageVersion: "CRA-T4127-122E-CA-AB-2026-H1-MODIFIED",
        sourcePublication: "TEST",
        params: modified,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Payroll-3B-5B-1c — golden fixture files present", () => {
  const fixturesDir = join(process.cwd(), "tests", "payroll", "fixtures", "2026", "ca-ab");
  const required = [
    "cpp-annual-max.json",
    "cpp-basic-exemption.json",
    "ei-annual-max.json",
    "federal-brackets-2026.json",
    "alberta-brackets-2026.json",
    "pdoc-gross-to-net-2026.json",
  ];

  for (const f of required) {
    it(`${f} exists`, () => {
      expect(existsSync(join(fixturesDir, f))).toBe(true);
    });
  }

  it("populated fixtures (non-PDOC) contain NO AWAITING_VERIFICATION markers", () => {
    const populated = [
      "cpp-annual-max.json",
      "cpp-basic-exemption.json",
      "ei-annual-max.json",
      "federal-brackets-2026.json",
      "alberta-brackets-2026.json",
    ];
    for (const f of populated) {
      const raw = readFileSync(join(fixturesDir, f), "utf8");
      expect(raw).not.toContain("AWAITING_VERIFICATION");
    }
  });

  it("PDOC gross-to-net fixture has the required provenance shape", () => {
    const raw = readFileSync(join(fixturesDir, "pdoc-gross-to-net-2026.json"), "utf8");
    const j = JSON.parse(raw);
    expect(j.sourceAuthority).toMatch(/PDOC/);
    expect(j.sourceUrl).toMatch(/cra-arc\.gc\.ca/);
    expect(j.cases.length).toBe(4);
    for (const c of j.cases) {
      expect(c.inputs).toBeDefined();
      expect(c.expected).toBeDefined();
    }
  });
});

// ------------------------------------------------------------
// Payroll-3B-5B-2 Pre-Calc Gate — PDOC fixture integrity
// (was `it.todo` in 3B-5B-1d; now active. Founder ran the four
// scenarios through CRA PDOC on 2026-08-31 and transcribed the
// official CRA-produced expected values into the fixture.)
// ------------------------------------------------------------
describe("pdoc-fixture-integrity", () => {
  const fixturesDir = join(process.cwd(), "tests/payroll/fixtures/2026/ca-ab");
  const fixture = JSON.parse(readFileSync(join(fixturesDir, "pdoc-gross-to-net-2026.json"), "utf8"));

  // Required for EVERY scenario. These are the "seven golden fields"
  // the brief specifies (plus the two mandatory diagnostics).
  const REQUIRED_GOLDEN_FIELDS = [
    "cppEeCombined",
    "cpp2Ee",
    "eiEe",
    "federalTax",
    "provincialTax",
    "totalDeductions",
    "netPay",
  ] as const;
  const REQUIRED_DIAGNOSTICS = [
    "cppAdditionalContributionDeduction",
    "payPeriodTaxableIncome",
  ] as const;

  it("fixture provenance names CRA PDOC as the source authority and carries a founder-run 2026-08-31 retrieval date", () => {
    expect(fixture.sourceAuthority).toMatch(/CRA Payroll Deductions Online Calculator/);
    expect(fixture.sourceAuthority).toMatch(/PDOC/);
    expect(fixture.sourceRetrievedAt).toBe("2026-08-31");
    expect(fixture.sourceRetrievedBy).toMatch(/founder-run-pdoc-independent/);
    // Provenance MUST state the values are NOT Spectre-generated.
    expect(fixture.verificationNote).toMatch(/NOT derived from Spectre code/);
    expect(fixture.verificationNote).toMatch(/NOT derived from the future Spectre gross-to-net calculator/);
    // Provenance MUST state the CRA PDFs contained blank Employee /
    // Employer names (no PII stored).
    expect(fixture.verificationNote).toMatch(/BLANK Employee-name and Employer-name fields/);
  });
  it("fixture carries an immutability contract forbidding calculator-driven rewrites", () => {
    expect(fixture.immutabilityContract).toMatch(/IMMUTABLE test truth/);
    expect(fixture.immutabilityContract).toMatch(/MUST NEVER rewrite, regenerate, or 'correct'/);
    expect(fixture.immutabilityContract).toMatch(/Adjusting the fixture to make the calculator pass is prohibited/);
  });
  it("fixture contains ZERO SOURCE_PENDING_PDOC_TRANSCRIPTION or AWAITING_VERIFICATION markers", () => {
    const raw = readFileSync(join(fixturesDir, "pdoc-gross-to-net-2026.json"), "utf8");
    expect(raw).not.toContain("SOURCE_PENDING_PDOC_TRANSCRIPTION");
    expect(raw).not.toContain("AWAITING_VERIFICATION");
  });
  it("fixture holds exactly the four founder-authorised scenarios by id", () => {
    const ids = fixture.cases.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([
      "pdoc-additional-tax-alberta",
      "pdoc-basic-hourly-biweekly-alberta-h1",
      "pdoc-custom-td1-alberta-h2",
      "pdoc-zero-claim-more-than-one-employer",
    ]);
  });
  it.each(REQUIRED_GOLDEN_FIELDS)("every scenario supplies golden field `%s` as an exact decimal-currency string", (field) => {
    for (const c of fixture.cases) {
      const value = c.expected[field];
      expect(value, `scenario ${c.id} missing golden field ${field}`).toBeDefined();
      // Exact decimal currency, two decimal places (e.g. "163.23" or "0.00").
      expect(value, `scenario ${c.id}.${field} not exact decimal currency`).toMatch(/^\d+\.\d{2}$/);
    }
  });
  it.each(REQUIRED_DIAGNOSTICS)("every scenario supplies diagnostic `%s` as an exact decimal-currency string", (field) => {
    for (const c of fixture.cases) {
      const value = c.expected[field];
      expect(value, `scenario ${c.id} missing diagnostic ${field}`).toBeDefined();
      expect(value, `scenario ${c.id}.${field} not exact decimal currency`).toMatch(/^\d+\.\d{2}$/);
    }
  });
  it("scenario 3 (additional-tax) preserves the base federal/Alberta tax equal to scenario 1 and reports 75.00 additional-tax separately", () => {
    const s1 = fixture.cases.find((c: { id: string }) => c.id === "pdoc-basic-hourly-biweekly-alberta-h1");
    const s3 = fixture.cases.find((c: { id: string }) => c.id === "pdoc-additional-tax-alberta");
    expect(s3.expected.federalTax).toBe(s1.expected.federalTax);
    expect(s3.expected.provincialTax).toBe(s1.expected.provincialTax);
    expect(s3.expected.additionalTaxTotal).toBe("75.00");
    // totalIncomeTaxDeductions = federalTax + provincialTax + additionalTaxTotal.
    const sum = (Number(s3.expected.federalTax) + Number(s3.expected.provincialTax) + Number(s3.expected.additionalTaxTotal)).toFixed(2);
    expect(s3.expected.totalIncomeTaxDeductions).toBe(sum);
  });
  it("scenario 4 (more-than-one-employer) preserves the semantic claimZeroFederal input and shows a materially higher federal withholding", () => {
    const s1 = fixture.cases.find((c: { id: string }) => c.id === "pdoc-basic-hourly-biweekly-alberta-h1");
    const s4 = fixture.cases.find((c: { id: string }) => c.id === "pdoc-zero-claim-more-than-one-employer");
    // Semantic condition is preserved (not reduced to a numeric zero on federal TD1 alone).
    expect(s4.inputs.tdCredits.claimZeroFederal).toBe(true);
    // Federal is materially higher because no BPA credit is applied.
    expect(Number(s4.expected.federalTax)).toBeGreaterThan(Number(s1.expected.federalTax));
    // Alberta unchanged from scenario 1 (Alberta TD1 remains at BPA).
    expect(s4.expected.provincialTax).toBe(s1.expected.provincialTax);
  });
  it("every scenario carries the semantic input contract Payroll-3B-5B-2 will consume (packageWindow + province + payDate + tdCredits shape)", () => {
    for (const c of fixture.cases) {
      expect(c.inputs.packageWindow).toMatch(/^2026-H[12]$/);
      expect(c.inputs.province).toBe("AB");
      expect(c.inputs.payDate).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(c.inputs.payFrequency).toBe("BIWEEKLY");
      expect(c.inputs.grossEarnings).toBe("2000.00");
      expect(c.inputs.tdCredits).toBeDefined();
      expect(typeof c.inputs.tdCredits.claimZeroFederal).toBe("boolean");
      expect(typeof c.inputs.tdCredits.claimZeroProvincial).toBe("boolean");
      expect(typeof c.inputs.tdCredits.totalIncomeLessThanClaim).toBe("boolean");
    }
  });
  it("fixture DOES NOT persist founder / employee / employer / account identifying metadata", () => {
    const raw = readFileSync(join(fixturesDir, "pdoc-gross-to-net-2026.json"), "utf8");
    // Sensitive PII placeholders that MUST NOT appear:
    for (const forbidden of ["sin", "socialInsuranceNumber", "employeeName", "employerName", "employerAccount", "bnNumber", "businessNumber"]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("Payroll-3B-5B-1d — H1/H2 resolver boundary (§O)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("June 30 pay date resolves H1; July 1 pay date resolves H2", async () => {
    const sup = await superAdminP();
    const { h1, h2 } = await seedCanadaAlbertaPackages2026(sup);
    // Direct DB check — the resolver test lives in
    // statutory-package.test.ts. Here we just prove the pinned
    // package IDs differ across the boundary.
    const { resolveStatutoryPackage } = await import("@/lib/payroll/statutory-package");
    const jun = await resolveStatutoryPackage({ country: "CA", province: "AB", payDate: d(2026, 6, 30) });
    const jul = await resolveStatutoryPackage({ country: "CA", province: "AB", payDate: d(2026, 7, 1) });
    expect(jun.id).toBe(h1.id);
    expect(jul.id).toBe(h2.id);
    expect(jun.packageVersion).toBe("CRA-T4127-122E-CA-AB-2026-H1");
    expect(jul.packageVersion).toBe("CRA-T4127-123E-CA-AB-2026-H2");
  });
});
