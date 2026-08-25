// HR mobile-hotfix (2026-08-30) §2 — Backfill script safety invariants.
//
// Pinned at the source level (not exercised — the script talks to
// KMS + prisma). The rules the script must enforce:
//   * Dry-run is the default; --commit is required to write.
//   * Sanitised console output — no plaintext SIN digits, no full
//     account digits, no transit/institution numbers, no fingerprint
//     hex. Only last-3 SIN / last-4 account are printed.
//   * Collisions HALT writing for that fingerprint. The script never
//     silently deletes a colliding row, never picks a winner. Human
//     review required — matches the founder brief §2.
//   * ACTIVE-vs-INACTIVE bank distinction: only status ∈
//     (PENDING_PENNY_TEST, VERIFIED) counts as a collision.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(
  resolve(process.cwd(), "scripts/hr-backfill-sensitive-fingerprints.ts"), "utf8",
);

describe("HR mobile-hotfix · §2 backfill script safety invariants", () => {
  it("dry-run is the default; --commit is required to write", () => {
    expect(script).toMatch(/let commit = false;/);
    expect(script).toMatch(/if \(raw === "--commit"\) \{ commit = true;/);
    // The write branches are gated on args.commit.
    expect(script).toMatch(/if \(!args\.commit\)[\s\S]{0,200}dry-run/);
  });

  it("halts writing on a collision — never silently deletes or picks a winner", () => {
    // Both SIN and BANK conflict branches must exit the loop with `continue`.
    expect(script).toMatch(/\[SIN CONFLICT\][\s\S]{0,800}SKIPPED writing fingerprint/);
    expect(script).toMatch(/\[BANK CONFLICT\][\s\S]{0,800}SKIPPED writing fingerprint/);
    // NO deletion calls in the script — safety belt.
    expect(script).not.toMatch(/prisma\.employeeSensitiveIdentity\.delete/);
    expect(script).not.toMatch(/prisma\.employeeBankAccount\.delete/);
  });

  it("sanitised report: only sinLastThree / accountLastFour printed — no plaintext", () => {
    // Verify that the printed record shape uses the ...LastThree /
    // ...LastFour columns and NOT the plaintext variables.
    const sinBlock = script.slice(script.indexOf("[SIN CONFLICT]"), script.indexOf("[BANK"));
    expect(sinBlock).toMatch(/SIN last-3 \$\{row\.sinLastThree/);
    // No direct printing of the decrypted `plaintext` var.
    expect(sinBlock).not.toMatch(/\$\{plaintext\}/);
    const bankBlock = script.slice(script.indexOf("[BANK CONFLICT]"));
    expect(bankBlock).toMatch(/account last-4 \$\{row\.accountLastFour/);
    // Never prints the decrypted institution / transit / account values.
    expect(bankBlock).not.toMatch(/\$\{institution\}/);
    expect(bankBlock).not.toMatch(/\$\{transit\}/);
    expect(bankBlock).not.toMatch(/\$\{account\}/);
  });

  it("labelFor never prints the full employee id (uses `.slice(-8)`)", () => {
    expect(script).toMatch(/emp\.id\.slice\(-8\)/);
    // Confirm the label uses the tail slice — no raw `${emp.id}` interpolation
    // (only .slice-based forms allowed).
    const labelBlock = script.slice(script.indexOf("function labelFor"), script.indexOf("SIN backfill"));
    expect(labelBlock).not.toMatch(/\$\{emp\.id\}/);
  });

  it("bank ACTIVE vs INACTIVE distinction: only PENDING_PENNY_TEST / VERIFIED collide", () => {
    // The DB conflict lookup for bank restricts status.
    expect(script).toMatch(/status:\s*\{\s*in:\s*\["PENDING_PENNY_TEST",\s*"VERIFIED"\]\s*\}/);
    // The isActive gate is defined.
    expect(script).toMatch(/const isActive =/);
  });

  it("club scoping via --club flag reaches the DB filter", () => {
    expect(script).toMatch(/if \(raw\.startsWith\("--club="\)\)/);
    expect(script).toMatch(/args\.clubFilter/);
  });

  it("non-zero exit code when conflicts detected", () => {
    expect(script).toMatch(/if \(sinResult\.conflicts \+ bankResult\.conflicts > 0\)[\s\S]{0,200}process\.exit\(2\)/);
  });

  it("Chris/Lise remediation is deferred to interactive session (script itself is safe to run in prod)", () => {
    // The script header must mention the deferred remediation so a
    // future operator does NOT wire an automatic winner-selection.
    expect(script).toMatch(/Chris\/Lise remediation is deferred/);
  });
});
