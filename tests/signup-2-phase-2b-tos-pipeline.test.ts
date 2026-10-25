// SIGNUP-2 Phase 2B (2026-10-25) -- Terms-of-Service pipeline tests.
//
// Exercises the ToS helper end-to-end against the committed dev
// fixture.  Must stay dev-fixture-only; must NOT reach any live
// signatory path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  resolveTermsOfServicePath,
  readTermsOfService,
  assertAttestationLiveFlag,
  assertTermsOfServiceApproved,
  assertAttestationCanProceed,
} from "@/lib/billing/terms-of-service";

const ROOT = process.cwd();
const DEV_FIXTURE = join(ROOT, "docs/legal/terms-of-service-fixture-dev.md");

describe("SIGNUP-2 Phase 2B · ToS pipeline resolution", () => {
  it("resolveTermsOfServicePath() falls back to the dev fixture when no v1 exists", () => {
    const prod = join(ROOT, "docs/legal/terms-of-service-v1.md");
    const resolved = resolveTermsOfServicePath();
    if (!existsSync(prod)) {
      expect(resolved).toBe(DEV_FIXTURE);
    } else {
      // If a prod file ever exists, that wins; still a known safe path.
      expect(resolved).toBe(prod);
    }
  });

  it("resolveTermsOfServicePath() honours SPECTRE_TOS_DOCUMENT_PATH override", () => {
    const override = join(ROOT, "docs/legal/terms-of-service-fixture-dev.md");
    const prev = process.env.SPECTRE_TOS_DOCUMENT_PATH;
    process.env.SPECTRE_TOS_DOCUMENT_PATH = override;
    try {
      expect(resolveTermsOfServicePath()).toBe(override);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_TOS_DOCUMENT_PATH;
      else process.env.SPECTRE_TOS_DOCUMENT_PATH = prev;
    }
  });

  it("The committed dev fixture exists at docs/legal/terms-of-service-fixture-dev.md", () => {
    expect(existsSync(DEV_FIXTURE)).toBe(true);
  });

  it("The dev fixture declares Label: `ToS-dev-fixture-...` and Status: `DEVELOPMENT_FIXTURE`", () => {
    const body = readFileSync(DEV_FIXTURE, "utf8");
    expect(body).toMatch(/\*\*Label:\*\*\s*`ToS-dev-fixture-/);
    expect(body).toMatch(/\*\*Status:\*\*\s*`DEVELOPMENT_FIXTURE`/);
  });
});

describe("SIGNUP-2 Phase 2B · ToS pipeline SHA-256", () => {
  it("readTermsOfService() returns a well-formed SHA-256 hex of the body", () => {
    const prev = process.env.SPECTRE_TOS_DOCUMENT_PATH;
    process.env.SPECTRE_TOS_DOCUMENT_PATH = DEV_FIXTURE;
    try {
      const doc = readTermsOfService();
      expect(doc.sha256).toMatch(/^[a-f0-9]{64}$/);
      const expected = createHash("sha256").update(readFileSync(DEV_FIXTURE, "utf8"), "utf8").digest("hex");
      expect(doc.sha256).toBe(expected);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_TOS_DOCUMENT_PATH;
      else process.env.SPECTRE_TOS_DOCUMENT_PATH = prev;
    }
  });

  it("readTermsOfService() parses the dev fixture as status = DEVELOPMENT_FIXTURE", () => {
    const prev = process.env.SPECTRE_TOS_DOCUMENT_PATH;
    process.env.SPECTRE_TOS_DOCUMENT_PATH = DEV_FIXTURE;
    try {
      const doc = readTermsOfService();
      expect(doc.status).toBe("DEVELOPMENT_FIXTURE");
      expect(doc.label).toMatch(/^ToS-dev-fixture-/);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_TOS_DOCUMENT_PATH;
      else process.env.SPECTRE_TOS_DOCUMENT_PATH = prev;
    }
  });
});

describe("SIGNUP-2 Phase 2B · ToS pipeline fail-closed semantics", () => {
  const flagPrev = process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE;
  const tosPrev = process.env.SPECTRE_TOS_DOCUMENT_PATH;

  beforeEach(() => {
    delete process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE;
    process.env.SPECTRE_TOS_DOCUMENT_PATH = DEV_FIXTURE;
  });

  afterEach(() => {
    if (flagPrev === undefined) delete process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE;
    else process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE = flagPrev;
    if (tosPrev === undefined) delete process.env.SPECTRE_TOS_DOCUMENT_PATH;
    else process.env.SPECTRE_TOS_DOCUMENT_PATH = tosPrev;
  });

  it("assertAttestationLiveFlag() throws when flag is unset (default-OFF)", () => {
    expect(() => assertAttestationLiveFlag()).toThrow(/disabled/i);
  });

  it("assertAttestationLiveFlag() throws when flag is explicitly '0'", () => {
    process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE = "0";
    expect(() => assertAttestationLiveFlag()).toThrow(/disabled/i);
  });

  it("assertAttestationLiveFlag() throws when flag is 'true' (ONLY the literal '1' passes)", () => {
    process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE = "true";
    expect(() => assertAttestationLiveFlag()).toThrow(/disabled/i);
  });

  it("assertAttestationLiveFlag() passes silently when flag === '1'", () => {
    process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE = "1";
    expect(() => assertAttestationLiveFlag()).not.toThrow();
  });

  it("assertTermsOfServiceApproved() rejects the dev fixture even if the flag is on", () => {
    process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE = "1";
    const doc = readTermsOfService();
    expect(() => assertTermsOfServiceApproved(doc)).toThrow(/dev-fixture|DEVELOPMENT_FIXTURE|APPROVED/);
  });

  it("assertAttestationCanProceed() refuses when flag is unset", () => {
    expect(() => assertAttestationCanProceed()).toThrow(/disabled/i);
  });

  it("assertAttestationCanProceed() refuses when flag is on but ToS is dev fixture", () => {
    process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE = "1";
    expect(() => assertAttestationCanProceed()).toThrow(/dev-fixture|DEVELOPMENT_FIXTURE|APPROVED/);
  });
});
