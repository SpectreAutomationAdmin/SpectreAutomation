// EP-TRAIN-4Y-BE — worker-side preparation watchdog.
//
// The fast path is event-driven (upload, transcription finished,
// generation finished each call the orchestrator directly). This tick
// is the safety net: it re-evaluates every course with an upload
// authorization inside the pipeline window, so a step that was lost —
// a worker restart mid-run, a queue entry that never ran, a hand-off
// that failed — resumes on its own from the last completed stage.
//
// It can only ever do what the orchestrator allows: authorized
// versions, bounded attempts, under the cost ceiling.

import { logger } from "@/lib/observability/logger";
import { listPipelineCandidates } from "./generation/processing-authorization";
import { advancePreparation } from "./preparation-orchestrator";

const DEFAULT_INTERVAL_MS = 30_000;
let lastTickAt = 0;

export async function tickTrainingPreparationWatchdog(now: number = Date.now()): Promise<void> {
  const interval = Number(process.env.TRAINING_PREPARATION_WATCHDOG_MS ?? DEFAULT_INTERVAL_MS);
  if (now - lastTickAt < interval) return;
  lastTickAt = now;
  let candidates: Awaited<ReturnType<typeof listPipelineCandidates>>;
  try {
    candidates = await listPipelineCandidates();
  } catch (err) {
    logger.error("training.preparation.watchdog.list_failed", {
      error: (err as Error)?.message ?? String(err),
    });
    return;
  }
  for (const c of candidates) {
    // advancePreparation never throws and logs anything it does.
    await advancePreparation({ ...c, trigger: "WATCHDOG" });
  }
}
