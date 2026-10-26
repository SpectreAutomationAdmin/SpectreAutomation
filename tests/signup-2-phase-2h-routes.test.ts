// SIGNUP-2 Phase 2H (2026-10-26) -- Route contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUSPEND = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/tenants/[clubId]/suspend/route.ts"),
  "utf8",
);
const REINSTATE = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/tenants/[clubId]/reinstate/route.ts"),
  "utf8",
);
const TIMELINE = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/tenants/[clubId]/timeline/route.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2H · suspend route", () => {
  it("401 on no principal; 403 without the suspend permission", () => {
    expect(SUSPEND).toMatch(/status:\s*401/);
    expect(SUSPEND).toMatch(/status:\s*403/);
    expect(SUSPEND).toMatch(/hasPermission\(principal, null, "platform:tenants:suspend"\)/);
  });
  it("validates trigger against the enumerated list", () => {
    expect(SUSPEND).toMatch(/SUSPENSION_TRIGGERS/);
    expect(SUSPEND).toMatch(/status:\s*400/);
  });
  it("delegates to suspendTenant", () => {
    expect(SUSPEND).toMatch(/suspendTenant\(/);
  });
  it("logs operator action", () => {
    expect(SUSPEND).toMatch(/logger\.info.+signup\.lifecycle\.suspend_api/);
  });
});

describe("SIGNUP-2 Phase 2H · reinstate route", () => {
  it("401 / 403 gated; requires reinstate permission", () => {
    expect(REINSTATE).toMatch(/status:\s*401/);
    expect(REINSTATE).toMatch(/status:\s*403/);
    expect(REINSTATE).toMatch(/hasPermission\(principal, null, "platform:tenants:reinstate"\)/);
  });
  it("requires authoriserUserId in the body", () => {
    expect(REINSTATE).toMatch(/authoriserUserId/);
    expect(REINSTATE).toMatch(/status:\s*400/);
  });
  it("delegates to reinstateTenant", () => {
    expect(REINSTATE).toMatch(/reinstateTenant\(/);
  });
});

describe("SIGNUP-2 Phase 2H · timeline route (read-only)", () => {
  it("401 / 403 gated; any of the three permission keys allowed", () => {
    expect(TIMELINE).toMatch(/status:\s*401/);
    expect(TIMELINE).toMatch(/status:\s*403/);
    expect(TIMELINE).toMatch(/platform:tenants:suspend/);
    expect(TIMELINE).toMatch(/platform:tenants:reinstate/);
    expect(TIMELINE).toMatch(/platform:tenants:remediate/);
  });
  it("read-only: no .create / .update / .delete calls", () => {
    expect(TIMELINE).not.toMatch(/\.create\(|\.update\(|\.delete\(|\.updateMany|\.deleteMany/);
  });
  it("delegates to readTenantLifecycleTimeline", () => {
    expect(TIMELINE).toMatch(/readTenantLifecycleTimeline\(/);
  });
});
