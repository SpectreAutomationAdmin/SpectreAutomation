#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";

const RUN_ID = "cmw9rrl1g000rj41xaoxvzqbb";

const script = `
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const r = await p.trainingQuestionAiGenerationRun.findUnique({
      where: { id: "${RUN_ID}" },
      select: { shortfallReasonJson: true, assessmentPlanJson: true },
    });
    const shortfall = r.shortfallReasonJson ? JSON.parse(r.shortfallReasonJson) : null;
    // Print the FA-relevant extras + the dedup decisions verbatim.
    console.log("==4YAF_RAW_BEGIN==");
    console.log(JSON.stringify({
      targetCount: shortfall ? shortfall.targetCount : null,
      generatedCount: shortfall ? shortfall.generatedCount : null,
      shortfall: shortfall ? shortfall.shortfall : null,
      reason: shortfall ? shortfall.reason : null,
      dedupRulesVersion: shortfall ? shortfall.dedupRulesVersion : null,
      allKeys: shortfall ? Object.keys(shortfall) : null,
    }, null, 2));
    console.log("==4YAF_RAW_END==");
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
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

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yaf-diagnose-raw-shortfall.raw.txt", out);

const m = out.match(/==4YAF_RAW_BEGIN==\s*([\s\S]*?)\s*==4YAF_RAW_END==/);
if (!m) { console.error("no markers"); console.error(out); process.exit(1); }
console.log(m[1]);
