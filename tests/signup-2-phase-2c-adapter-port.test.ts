// SIGNUP-2 Phase 2C (2026-10-25) -- EntityRegistryAdapter port
// contract tests.
//
// Source-contract style (readFileSync + regex) to pin the Phase 2C
// adapter architecture:
//   • Port is pure (no DB, no logger).
//   • Manual-review stub never returns ACTIVE.
//   • Fixture adapter is ONLY resolvable via env var.
//   • Factory defaults to manual-review for every jurisdiction.
//   • No live adapter ships in Phase 2C baseline (procurement
//     deferred per registry-access investigation).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveAdapter,
  isFixtureAdapterMode,
  SUPPORTED_JURISDICTIONS,
} from "@/lib/signup/entity-registry";

const ROOT = process.cwd();
const PORT = readFileSync(join(ROOT, "src/lib/signup/entity-registry/types.ts"), "utf8");
const FACTORY = readFileSync(join(ROOT, "src/lib/signup/entity-registry/index.ts"), "utf8");
const STUB = readFileSync(join(ROOT, "src/lib/signup/entity-registry/adapters/manual-review.ts"), "utf8");
const FIXTURE = readFileSync(join(ROOT, "src/lib/signup/entity-registry/adapters/fixture.ts"), "utf8");

describe("SIGNUP-2 Phase 2C · adapter port shape", () => {
  it("defines all four EntityStanding values exactly once", () => {
    expect(PORT).toMatch(/"ACTIVE"\s*\|\s*"NOT_ACTIVE"\s*\|\s*"NOT_FOUND"\s*\|\s*"MANUAL_REVIEW_REQUIRED"/);
  });

  it("declares OfficerMatch as a soft signal that may be null", () => {
    expect(PORT).toMatch(/"MATCHED"\s*\|\s*"PARTIAL"\s*\|\s*"NOT_MATCHED"\s*\|\s*null/);
  });

  it("the port carries an isLive discriminator so corroborator can gate PASS_AUTOMATED on authoritative sources", () => {
    expect(PORT).toMatch(/readonly isLive:\s*boolean/);
  });

  it("adapters MUST NOT retain the raw registry payload (documented invariant)", () => {
    expect(PORT).toMatch(/Must NOT retain or persist the raw registry payload/);
  });
});

describe("SIGNUP-2 Phase 2C · manual-review stub", () => {
  it("returns MANUAL_REVIEW_REQUIRED, no business number, no officer match, no PII", () => {
    expect(STUB).toMatch(/standing:\s*"MANUAL_REVIEW_REQUIRED"/);
    expect(STUB).toMatch(/businessNumber:\s*null/);
    expect(STUB).toMatch(/officerMatch:\s*null/);
    // Must not perform any HTTP, must not log, must not touch prisma.
    expect(STUB).not.toMatch(/\bawait\s+fetch\s*\(/);
    expect(STUB).not.toMatch(/\bglobal(?:This)?\.fetch\b/);
    expect(STUB).not.toMatch(/prisma\./);
    expect(STUB).not.toMatch(/logger\./);
  });

  it("isLive === false", () => {
    expect(STUB).toMatch(/isLive:\s*false/);
  });

  it("the stub NEVER returns ACTIVE under any input", async () => {
    // Behavioural assertion via the actual factory (no fixture mode).
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    try {
      for (const jur of SUPPORTED_JURISDICTIONS) {
        const adapter = resolveAdapter(jur);
        const out = await adapter.fetch({
          legalName: "Any Legal Name Inc.",
          signatoryFullName: null,
          jurisdiction: jur,
          correlationId: `test-${jur}`,
        });
        expect(out.standing).toBe("MANUAL_REVIEW_REQUIRED");
        expect(adapter.isLive).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });
});

describe("SIGNUP-2 Phase 2C · fixture adapter is env-gated", () => {
  it("isFixtureAdapterMode() returns false when env var is unset", () => {
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    try {
      expect(isFixtureAdapterMode()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });

  it("isFixtureAdapterMode() returns false when env var is anything other than 'fixture'", () => {
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = "live";
    try {
      expect(isFixtureAdapterMode()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });

  it("isFixtureAdapterMode() returns true ONLY when env var === 'fixture'", () => {
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = "fixture";
    try {
      expect(isFixtureAdapterMode()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });

  it("fixture adapter returns the directive encoded in the legalName", async () => {
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = "fixture";
    try {
      const adapter = resolveAdapter("CA-ON");
      const active = await adapter.fetch({
        legalName: "FIXTURE:ACTIVE+MATCHED Example Club",
        signatoryFullName: null,
        jurisdiction: "CA-ON",
        correlationId: "test",
      });
      expect(active.standing).toBe("ACTIVE");
      expect(active.officerMatch).toBe("MATCHED");

      const notActive = await adapter.fetch({
        legalName: "FIXTURE:NOT_ACTIVE Example Club",
        signatoryFullName: null,
        jurisdiction: "CA-ON",
        correlationId: "test",
      });
      expect(notActive.standing).toBe("NOT_ACTIVE");

      const manual = await adapter.fetch({
        legalName: "No Directive Here Inc.",
        signatoryFullName: null,
        jurisdiction: "CA-ON",
        correlationId: "test",
      });
      expect(manual.standing).toBe("MANUAL_REVIEW_REQUIRED");
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });

  it("fixture adapter STILL reports isLive === false (never counts as authoritative)", async () => {
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = "fixture";
    try {
      const adapter = resolveAdapter("CA-BC");
      expect(adapter.isLive).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });
});

describe("SIGNUP-2 Phase 2C · factory invariants", () => {
  it("supports the three priority jurisdictions (CA-AB / CA-ON / CA-BC)", () => {
    expect(SUPPORTED_JURISDICTIONS).toContain("CA-AB");
    expect(SUPPORTED_JURISDICTIONS).toContain("CA-ON");
    expect(SUPPORTED_JURISDICTIONS).toContain("CA-BC");
  });

  it("the factory defaults to manual-review for ALL jurisdictions (Phase 2C baseline)", () => {
    expect(FACTORY).toMatch(/every jurisdiction routes to manual review/i);
  });

  it("the factory does not import any live adapter module (Phase 2C baseline ships none)", () => {
    expect(FACTORY).not.toMatch(/live-ca-ab|live-ca-on|live-ca-bc|bcregistry/i);
  });

  it("the factory never fabricates ACTIVE", async () => {
    const prev = process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
    try {
      const adapter = resolveAdapter("ZZ-UNKNOWN"); // nonsense jurisdiction
      const out = await adapter.fetch({
        legalName: "FIXTURE:ACTIVE Example Club", // would be ACTIVE in fixture mode
        signatoryFullName: null,
        jurisdiction: "ZZ-UNKNOWN",
        correlationId: "test",
      });
      // Without fixture mode, the fixture directive is ignored.
      expect(out.standing).toBe("MANUAL_REVIEW_REQUIRED");
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE;
      else process.env.SPECTRE_SIGNUP_2C_ADAPTER_MODE = prev;
    }
  });
});

describe("SIGNUP-2 Phase 2C · adapters never persist raw payloads", () => {
  it("stub never calls prisma", () => {
    expect(STUB).not.toMatch(/prisma\./);
  });
  it("fixture never calls prisma", () => {
    expect(FIXTURE).not.toMatch(/prisma\./);
  });
  it("factory never calls prisma", () => {
    expect(FACTORY).not.toMatch(/prisma\./);
  });
  it("port types never import prisma", () => {
    expect(PORT).not.toMatch(/prisma/i);
  });
});
