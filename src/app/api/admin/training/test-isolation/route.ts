// EP-TRAIN-4Y-BF §1 — isolation status for automated tests.
//
// A browser test calls this BEFORE it uploads anything, and refuses to
// continue unless the server confirms all three:
//   - this session is recognised as a test principal (so its uploads are
//     simulated, by identity);
//   - simulated processing is allowed in this environment;
//   - billable inference is locked in this process.
//
// On a build that predates test isolation this route does not exist, so
// the test stops on the 404 instead of making a real upload.
//
// It answers only a test principal; everyone else gets the same 404 as
// an unknown route. It reveals nothing about any course, and reads no
// secret — only whether three switches are on.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isMockInferenceAllowed } from "@/lib/hr/training/generation/processing-authorization";
import {
  isTestExecutionPrincipal,
  isTestPrincipalEmail,
  isTrainingTestPrincipal,
} from "@/lib/hr/training/generation/test-execution-identity";
import { isBillableInferenceEnabled } from "@/lib/hr/training/modal-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const principal = await getCurrentPrincipal();
  if (!principal || !isTestExecutionPrincipal(principal)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    enforcement: "ep-train-4y-bf",
    testPrincipal: true,
    recognisedBy: {
      configuredList: isTrainingTestPrincipal(principal.id),
      reservedEmailDomain: isTestPrincipalEmail(principal.email),
    },
    simulationAllowed: isMockInferenceAllowed(),
    billableInference: isBillableInferenceEnabled() ? "ENABLED" : "LOCKED",
  });
}
