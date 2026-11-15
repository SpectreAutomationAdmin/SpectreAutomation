// EP-TRAIN-4Y-BF §1 — in-environment proof that this process cannot
// reach a billable inference provider.
//
// Run INSIDE the worker container (the process that holds the provider
// credentials), with that container's real environment:
//
//   flyctl ssh console -a spectre-staging-worker -C "sh -c 'cd /app && npx tsx scripts/ep-train-4y-bf-verify-lock.ts'"
//
// It calls each of the three provider clients exactly as the worker
// would, with the real credentials from the environment — but with the
// network replaced by a local spy, so this script itself can never
// contact a provider whatever the result. It then reports, per client,
// whether the call was refused before the spy was reached.
//
// Exit code 0 = locked (every client refused, spy never called).
// Exit code 1 = NOT locked. Writes nothing; prints no secret values.

import {
  ENV_BILLABLE_INFERENCE,
  ENV_FINGERPRINT_SECRET,
  ENV_GENERATE_URL,
  ENV_MODAL_KEY,
  ENV_MODAL_SECRET,
  ENV_REQUEST_HMAC_KEY,
  ENV_TRANSCRIBE_URL,
  isBillableInferenceEnabled,
  issuePilotAuthorization,
} from "../src/lib/hr/training/modal-shared";
import { callModalGenerate } from "../src/lib/hr/training/generation/modal-client";
import { callModalTranscribe } from "../src/lib/hr/training/transcription/modal-client";
import { callModalMetadata } from "../src/lib/hr/training/ai-metadata/metadata-modal-client";
import {
  isMockInferenceAllowed,
} from "../src/lib/hr/training/generation/processing-authorization";
import { trainingTestPrincipalIds } from "../src/lib/hr/training/generation/test-execution-identity";

async function main(): Promise<void> {
  const env = process.env;
  let spyCalls = 0;
  const spy = (async () => {
    spyCalls++;
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;

  const present = (name: string) => typeof env[name] === "string" && (env[name] as string).length > 0;
  const report: Record<string, unknown> = {
    app: env.FLY_APP_NAME ?? null,
    billableInferenceFlag: isBillableInferenceEnabled(env) ? "ENABLED" : "LOCKED",
    billableInferenceVariablePresent: present(ENV_BILLABLE_INFERENCE),
    simulationAllowed: isMockInferenceAllowed(env),
    testPrincipalsListed: trainingTestPrincipalIds(env).size,
    providerCredentialsPresent: {
      proxyKey: present(ENV_MODAL_KEY),
      proxySecret: present(ENV_MODAL_SECRET),
      requestHmacKey: present(ENV_REQUEST_HMAC_KEY),
      fingerprintSecret: present(ENV_FINGERPRINT_SECRET),
      transcribeUrl: present(ENV_TRANSCRIBE_URL),
      generateUrl: present(ENV_GENERATE_URL),
    },
  };

  // A syntactically valid authorization envelope. The fingerprint secret
  // falls back to a dummy when this process has none (the web app).
  const pilotAuthorization = issuePilotAuthorization({
    tenantId: "lock-probe",
    courseId: "lock-probe",
    versionId: "lock-probe",
    sourceVideoSha256: "0".repeat(64),
    resolvedTranscriptBuildId: "1".repeat(64),
    approvedGroundingProjectionSha256: "2".repeat(64),
    operation: "GENERATE_DRAFT_QUESTIONS",
    maxRequestedQuestions: 1,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: true,
      automaticRetriesProhibited: true,
      excludedSegmentIds: [],
      scope: "lock-probe",
    },
    ttlSec: 60,
    issuedBy: "system:lock-probe",
    fingerprintSecret: env[ENV_FINGERPRINT_SECRET] ?? "lock-probe-dummy-fingerprint-secret",
  });

  const outcome = async (label: string, call: () => Promise<unknown>) => {
    const before = spyCalls;
    try {
      await call();
      return { client: label, refused: false, code: null, reachedNetworkLayer: spyCalls > before };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? null;
      const message = ((err as Error)?.message ?? "").slice(0, 90);
      const refusedByLock = code === "BILLABLE_INFERENCE_LOCKED" || /Billable inference is not enabled/.test(message);
      return { client: label, refused: refusedByLock, code, message, reachedNetworkLayer: spyCalls > before };
    }
  };

  const clients = [
    await outcome("transcription", () =>
      callModalTranscribe(
        {
          requestId: "lock-probe-t",
          audioUrl: "https://invalid.example/lock-probe.mp4",
          languageCode: "en",
          modelVariant: "faster-whisper-large-v3",
          pilotAuthorization,
        },
        { fetchImpl: spy, env },
      ),
    ),
    await outcome("question-generation", () =>
      callModalGenerate(
        {
          requestId: "lock-probe-g",
          pilotAuthorization,
          modelVariant: "qwen-2.5-7b-instruct-awq",
          systemPrompt: "lock probe",
          transcript: "lock probe",
          constraints: {
            proposalKind: "QUESTION_FINAL_ASSESSMENT",
            maxQuestions: 1,
            allowedQuestionTypes: ["SINGLE_CHOICE"],
            jsonSchema: {},
          },
        },
        { fetchImpl: spy, env },
      ),
    ),
    await outcome("course-metadata", () =>
      callModalMetadata({ pilotAuthorization, systemPrompt: "lock probe", transcript: "lock probe" }, { fetchImpl: spy, env }),
    ),
  ];

  const locked = clients.every((c) => c.refused && !c.reachedNetworkLayer) && spyCalls === 0;
  report.clients = clients;
  report.networkLayerCalls = spyCalls;
  report.verdict = locked ? "LOCKED — no provider client can be reached from this process" : "NOT LOCKED";
  console.log("<<<JSON");
  console.log(JSON.stringify(report));
  console.log("JSON>>>");
  process.exitCode = locked ? 0 : 1;
}

main().catch((err) => {
  console.error("probe failed:", (err as Error)?.message ?? err);
  process.exitCode = 1;
});
