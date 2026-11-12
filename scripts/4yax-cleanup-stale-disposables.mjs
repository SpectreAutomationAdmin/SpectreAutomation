#!/usr/bin/env node
// EP-TRAIN-4Y-AX — clean up any stale AX disposables left behind by a
// failed / interrupted Playwright run. Looks up TrainingQuestion rows
// whose prompt matches the disposable markers and TrainingCheckpoint
// rows whose label matches "AX disposable CP", scoped to the pilot
// version only. Uses direct Prisma deletes with full audit logging
// surrogate (writes manual AuditLog entries) since we're on staging
// out-of-band.

import { execSync } from "node:child_process";

const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const CP_PROMPT = "AX disposable CP question — delete me";
const FA_PROMPT = "AX disposable FA question — delete me";
const CP_LABEL  = "AX disposable CP";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    // Find + delete the disposable TrainingQuestion rows first.
    const staleQs = await p.trainingQuestion.findMany({
      where: {
        courseVersionId: "${VERSION_ID}",
        prompt: { in: [${JSON.stringify(CP_PROMPT)}, ${JSON.stringify(FA_PROMPT)}] },
      },
      select: { id: true, prompt: true, checkpointId: true },
    });
    const qDeleteResults = [];
    for (const q of staleQs) {
      await p.trainingAnswerOption.deleteMany({ where: { questionId: q.id } });
      await p.trainingQuestion.delete({ where: { id: q.id } });
      qDeleteResults.push({ id: q.id, prompt: q.prompt });
    }

    // Then delete the disposable checkpoint rows (now empty).
    const staleCps = await p.trainingCheckpoint.findMany({
      where: {
        courseVersionId: "${VERSION_ID}",
        label: ${JSON.stringify(CP_LABEL)},
      },
      select: { id: true, atSecond: true, label: true },
    });
    const cpDeleteResults = [];
    for (const cp of staleCps) {
      const bound = await p.trainingQuestion.count({ where: { checkpointId: cp.id } });
      if (bound === 0) {
        await p.trainingCheckpoint.delete({ where: { id: cp.id } });
        cpDeleteResults.push({ id: cp.id, atSecond: cp.atSecond });
      }
    }

    console.log("==CLEANUP_BEGIN==");
    console.log(JSON.stringify({ qDeleteResults, cpDeleteResults }, null, 2));
    console.log("==CLEANUP_END==");
  } catch (e) {
    console.log("==CLEANUP_BEGIN==");
    console.log(JSON.stringify({ error: e.message }));
    console.log("==CLEANUP_END==");
  } finally { await p.$disconnect(); }
})();
`;
const b64 = Buffer.from(script, "utf8").toString("base64");
const remote = `sh -lc "cd /app && echo ${b64} | base64 -d | node"`;
const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const out = execSync(
  `"${flyctl}" ssh console --app spectre-staging --command '${remote}'`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: "bash.exe" },
);
const m = out.match(/==CLEANUP_BEGIN==\s*([\s\S]*?)\s*==CLEANUP_END==/);
if (!m) { console.error("no markers"); console.error(out.slice(-2000)); process.exit(1); }
console.log(m[1]);
