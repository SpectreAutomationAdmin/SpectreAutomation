#!/usr/bin/env node
// Local dry-run of the cleanup rules for the failing draft.
const RAW = "If an employee notices an issue with the system that could be improved, what is the best course of action according to the training material? \n\n**A)** Discuss the issue with other staff members to gather opinions.\n\n**B)** Report the issue to management without offering a solution.\n\n**C)** Offer a solution along with the report of the issue.\n\n**D)** Ignore the issue and let it continue to affect the membership negatively.\n\n**Correct Answer:** C";

const CLEANUPS = [
  { match: /,?\s*according to the transcript(?:\s*segments?\s*\[[\d,\s]+\](?:\s+and\s+\[[\d,\s]+\])*)?(?=[?.])/gi, replace: "" },
  { match: /^(?:[*_]{0,2})According to the transcript,?\s+/i, replace: "" },
  { match: /,?\s*according to (?:the )?evidence window(?:\s*content)?(?=[?.])/gi, replace: "" },
  { match: /,?\s*according to (?:the )?training materials?(?:\s+provided so far)?(?=[?.])/gi, replace: "" },
  { match: /\n*\*?\s*Segment\s*IDs?\s*:\s*\[[\d,\s]+\]\s*\*?\s*/gi, replace: "" },
  { match: /\n*\*{0,2}\s*Correct\s+Answer\s*:\s*\*{0,2}\s*[A-D]\s*\n*/gi, replace: "\n" },
  { match: /\*{1,2}([A-D])\)\*{1,2}\s*/g, replace: "" },
];
let out = RAW;
for (const { match, replace } of CLEANUPS) out = out.replace(match, replace);
out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
if (/^[a-z]/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);

console.log("=== CLEANED ===");
console.log(JSON.stringify(out));
console.log("\n=== RAW BYTES ===");
console.log(out);

// Now run the sanitiser patterns (inline) against it.
const PATTERNS = [
  { code: "ACCORDING_TO_TRANSCRIPT", regex: /\baccording to (?:the )?transcript\b/i },
  { code: "ACCORDING_TO_EVIDENCE_WINDOW", regex: /\baccording to (?:the )?evidence window\b/i },
  { code: "ACCORDING_TO_TRAINING_MATERIAL", regex: /\baccording to (?:the )?training materials?\b/i },
  { code: "EXPLICIT_SEGMENT_ID_REFERENCE", regex: /\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\bids?\b|\d+)/i },
  { code: "EMBEDDED_ANSWER_KEY", regex: /\*{0,2}\s*correct\s+answer\s*\*{0,2}\s*:/i },
  { code: "EMBEDDED_MARKDOWN_OPTION_HEADER", regex: /\*{1,2}[A-D]\)\*{1,2}/ },
  { code: "UNRESOLVED_TEMPLATE_PLACEHOLDER", regex: /\[(?!\s*\d)[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,2}\]/ },
];

console.log("\n=== SANITISER ===");
for (const p of PATTERNS) {
  const m = p.regex.exec(out);
  if (m) console.log(`  ⚠ ${p.code}: matched "${m[0]}"`);
}
