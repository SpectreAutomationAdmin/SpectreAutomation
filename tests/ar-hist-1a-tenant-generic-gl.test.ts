// AR-HIST-1A §6 / §I (2026-10-03) — tenant-generic GL control proof.
//
// The AR-HIST-1 commit service MUST NOT hardcode account number
// "1200". Different clubs may map their Member AR control to a
// different account number — the resolver discovers via
// fsGroupKey (BS_MEMBER_AR) and the exact-balance match, not via
// a global account-number constant.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const COMMIT = path.join(REPO, "src/lib/imports/ar-aging/commit-service.ts");
const RESOLVER = path.join(REPO, "src/lib/reporting/ar-aging-resolver.ts");

describe("AR-HIST-1A §6 — GL control is tenant-generic (no hardcoded 1200)", () => {
  it("commit service source does NOT reference account number '1200'", () => {
    const src = readFileSync(COMMIT, "utf8");
    // The commit service MUST use fsGroupKey classification +
    // balance match, never a hardcoded account number.
    expect(src).not.toMatch(/"1200"/);
    expect(src).not.toMatch(/'1200'/);
    expect(src).not.toMatch(/accountNumber\s*===\s*["']1200["']/);
  });

  it("resolver source does NOT reference account number '1200'", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).not.toMatch(/"1200"/);
    expect(src).not.toMatch(/'1200'/);
  });

  it("commit service drives GL discovery through AR_CONTROL_FS_GROUPS = ['BS_MEMBER_AR']", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/AR_CONTROL_FS_GROUPS\s*=\s*\[\s*"BS_MEMBER_AR"\s*\]/);
    expect(src).toMatch(/AR_CONTROL_FS_GROUPS\.includes\(b\.fsGroupKey\)/);
  });

  it("commit service picks ONE account via exact-balance match within $0.01 (no sum-across)", () => {
    const src = readFileSync(COMMIT, "utf8");
    // Documents the §12 non-combination rule.
    expect(src).toMatch(/Do not combine unrelated receivable accounts/);
    // The matcher is `balance.minus(subledgerTotal).abs().lte(TOLERANCE)`.
    expect(src).toMatch(/naturalBalance\.minus\(subledgerTotal\)\.abs\(\)\.lte\(TOLERANCE\)/);
  });

  it("commit service surfaces every BS_MEMBER_AR candidate when no single-account match exists", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/No single BS_MEMBER_AR account matches the subledger total within \$0\.01 — candidates/);
    expect(src).toMatch(/Multiple BS_MEMBER_AR accounts match the subledger total — operator must disambiguate/);
  });
});

describe("AR-HIST-1A — AR-HIST-1A diagnostic endpoint exists", () => {
  it("src/app/api/admin/ar-hist-1a-diagnostics/route.ts exists", () => {
    expect(existsSync(path.join(REPO, "src/app/api/admin/ar-hist-1a-diagnostics/route.ts"))).toBe(true);
  });

  it("diagnostic endpoint is read-only (no prisma write methods)", () => {
    const src = readFileSync(
      path.join(REPO, "src/app/api/admin/ar-hist-1a-diagnostics/route.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|deleteMany|updateMany)\b/);
  });
});
