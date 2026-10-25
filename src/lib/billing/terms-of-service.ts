// SIGNUP-2 Phase 2B (2026-10-25) -- Terms of Service helper.
//
// Reads the active ToS document, computes its SHA-256, and
// returns both the content + the lock metadata that
// `SubscriptionAuthorisationAttestation` records at acceptance.
//
// Fail-closed on EVERY path.  The attestation acceptance API
// refuses to proceed unless BOTH of these hold:
//
//   1. The environment flag `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE`
//      is set to `"1"`.  Default (unset or anything else) is OFF.
//
//   2. The ToS resolved for this environment is a FOUNDER-APPROVED
//      production document, NOT the development fixture.
//      Determined by the resolved document's version label:
//      `ToS-dev-fixture-*` labels are rejected as unsafe.
//
// Phase 2B ships a dev fixture at
// `docs/legal/terms-of-service-fixture-dev.md`.  No real signatory
// may be exposed to it.  Development + automated staging tests
// exercise the pipeline through this fixture; the feature flag
// stays OFF so no production path reaches the acceptance API.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AppError, ForbiddenError } from "@/lib/errors";

export interface TermsOfServiceDocument {
  label: string;
  sha256: string;
  length: number;
  status: "APPROVED" | "DEVELOPMENT_FIXTURE";
  body: string;
}

/** Resolve the ToS document path.  Production uses
 *  `docs/legal/terms-of-service-v1.md` (not yet created at Phase
 *  2B authoring time).  Development + automated tests fall back
 *  to the dev fixture. */
export function resolveTermsOfServicePath(): string {
  const envOverride = process.env.SPECTRE_TOS_DOCUMENT_PATH;
  if (envOverride && envOverride.trim().length > 0) return envOverride.trim();
  const prod = path.resolve(process.cwd(), "docs", "legal", "terms-of-service-v1.md");
  if (fs.existsSync(prod)) return prod;
  const fixture = path.resolve(process.cwd(), "docs", "legal", "terms-of-service-fixture-dev.md");
  return fixture;
}

/** Read + hash the ToS document.  Pure except for the file read. */
export function readTermsOfService(): TermsOfServiceDocument {
  const docPath = resolveTermsOfServicePath();
  if (!fs.existsSync(docPath)) {
    throw new AppError(
      "SIGNUP_2B_TOS_DOC_MISSING",
      `Terms-of-service document not found at ${docPath}`,
      500,
    );
  }
  const body = fs.readFileSync(docPath, "utf8");
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  // Determine label + status by reading the document's "Label:" and
  // "Status:" lines from the version-metadata block.
  const labelMatch = body.match(/^\s*-\s*\*\*Label:\*\*\s*`([^`]+)`/m);
  const statusMatch = body.match(/^\s*-\s*\*\*Status:\*\*\s*`([^`]+)`/m);
  const label = labelMatch ? labelMatch[1] : "UNKNOWN";
  const statusRaw = statusMatch ? statusMatch[1] : "UNKNOWN";
  let status: "APPROVED" | "DEVELOPMENT_FIXTURE";
  if (statusRaw === "APPROVED") status = "APPROVED";
  else if (statusRaw === "DEVELOPMENT_FIXTURE") status = "DEVELOPMENT_FIXTURE";
  else {
    throw new AppError(
      "SIGNUP_2B_TOS_STATUS_UNKNOWN",
      `Terms-of-service document at ${docPath} has unknown status '${statusRaw}'; refusing to proceed`,
      500,
    );
  }
  return { label, sha256, length: body.length, status, body };
}

/** Fail-closed feature flag check.  Attestation acceptance code
 *  calls this FIRST before doing anything else. */
export function assertAttestationLiveFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 Phase 2B attestation workflow is disabled (SPECTRE_SIGNUP_2B_ATTESTATION_LIVE != 1)",
    );
  }
}

/** Fail-closed ToS-readiness check.  Attestation acceptance refuses
 *  to persist an attestation if the ToS it would record is the
 *  development fixture.  The founder's amendment (§2.1 and §5) is
 *  explicit: "Do not publish or activate placeholder legal terms." */
export function assertTermsOfServiceApproved(doc: TermsOfServiceDocument): void {
  if (doc.status !== "APPROVED") {
    throw new ForbiddenError(
      `SIGNUP-2 Phase 2B refusing to record attestation: the resolved ToS is '${doc.status}' (label '${doc.label}'); it must be APPROVED before any live signatory sees it.`,
    );
  }
  if (doc.label.startsWith("ToS-dev-fixture")) {
    throw new ForbiddenError(
      `SIGNUP-2 Phase 2B refusing to record attestation against development fixture '${doc.label}'`,
    );
  }
}

/** Combined gate used by the attestation acceptance route. */
export function assertAttestationCanProceed(): { doc: TermsOfServiceDocument } {
  assertAttestationLiveFlag();
  const doc = readTermsOfService();
  assertTermsOfServiceApproved(doc);
  return { doc };
}
