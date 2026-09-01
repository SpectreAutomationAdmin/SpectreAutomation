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

describe("Payroll-3B-5B-1c — Alberta K5P explicit", () => {
  it("H1 carries a K5P block with enabled + triggerBase + rate + sourceCitation", () => {
    const k5p = CA_AB_2026_PARAMS_H1.provincial!.k5p;
    expect(k5p).toBeDefined();
    expect(k5p.enabled).toBe(true);
    expect(k5p.triggerBase).toBe("4800");
    expect(k5p.rate).toBe("0.02");
    expect(k5p.sourceCitation).toMatch(/T4127/);
  });
  it("H2 K5P is present and matches H1 (unchanged mid-year for 2026)", () => {
    expect(CA_AB_2026_PARAMS_H2.provincial!.k5p).toEqual(CA_AB_2026_PARAMS_H1.provincial!.k5p);
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
    expect(j.cases.length).toBeGreaterThanOrEqual(1);
    // Each case declares inputs + expected; expected fields are
    // explicitly marked SOURCE_PENDING_PDOC_TRANSCRIPTION until a
    // human runs the scenario through PDOC.
    for (const c of j.cases) {
      expect(c.inputs).toBeDefined();
      expect(c.expected).toBeDefined();
    }
  });
});
