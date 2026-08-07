// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// multimodal supplier-identity orchestrator.
//
// Founder rebuild: supplier identity must be derived from
// CORROBORATED evidence, not a single-signal shortcut. A domain
// alone (e.g. "Dmmenergy" from www.dmmenergy.ca) is insufficient
// architecture — a real invoice carries multiple independent
// signals that must combine into a defensible identity:
//
//   VISUAL_LOGO          + LEGAL_ENTITY_TEXT
//   HEADER_ORG_TEXT      + WEBSITE_DOMAIN
//   ADDRESS_BLOCK        + PHONE_BLOCK
//   TAX_REGISTRATION     + REMITTANCE_ENTITY
//   REPEATED_BRANDING    + PROVIDER_VENDOR_ROLE
//
// This module implements the provider-neutral canonical shape
// (types + orchestrator + clustering + scoring). Visual/logo
// evidence is scaffolded via the existing strategy-router — its
// full realisation is a follow-on slice. Text-based evidence is
// implemented here.
//
// Every candidate carries:
//   * normalizedIdentity — the cluster key (lowercase, corp-suffix
//     stripped, alphanumeric only)
//   * legalNameCandidate — the best "…Inc/Corp/Ltd/…" form seen
//   * operatingNameCandidate — the best plain-brand form seen
//   * evidence — supporting signals with type + page + region +
//     confidence + independenceGroup
//   * contradictions — negative signals attached to this cluster
//   * independentEvidenceGroups — count of DISTINCT independence
//     groups (WEBSITE + EMAIL from same domain root count as ONE)
//   * confidence — 0..100 corroboration score

export type SupplierEvidenceType =
  | "VISUAL_LOGO"
  | "HEADER_ORG_TEXT"
  | "LEGAL_ENTITY_TEXT"
  | "WEBSITE_DOMAIN"
  | "EMAIL_DOMAIN"
  | "ADDRESS_BLOCK"
  | "PHONE_BLOCK"
  | "TAX_REGISTRATION"
  | "REMITTANCE_ENTITY"
  | "PROVIDER_VENDOR_ROLE"
  | "REPEATED_BRANDING"
  | "POSITIONAL_HEADER"
  | "OTHER";

export interface SupplierBoundingRegion {
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  lineIndex?: number;
}

export interface SupplierIdentityEvidence {
  type: SupplierEvidenceType;
  value: string;
  page: number;
  region?: SupplierBoundingRegion;
  confidence: number;              // 0..100 (single-signal strength)
  sourceStrategy: string;
  evidenceSnippet?: string;
  /** Independence-group key. Multiple evidence items sharing this
   *  key count as ONE independent confirmation (e.g. WEBSITE_DOMAIN +
   *  EMAIL_DOMAIN sharing the same domain root). */
  independenceGroup: string;
}

export interface SupplierIdentityCandidate {
  normalizedIdentity: string;
  legalNameCandidate?: string;
  operatingNameCandidate?: string;
  evidence: SupplierIdentityEvidence[];
  contradictions: SupplierIdentityEvidence[];
  independentEvidenceGroups: number;
  confidence: number;
}

export interface SupplierSelection {
  winner: SupplierIdentityCandidate | null;
  alternates: Array<{ candidate: SupplierIdentityCandidate; rejectedBecause: string[] }>;
  abstained: boolean;
  abstainReason: string | null;
  /** Deterministic diagnostic payload for tests + card debugging. */
  diagnostic: {
    selectedSupplier: string | null;
    operatingName: string | null;
    legalName: string | null;
    confidence: number;
    independentEvidenceGroups: number;
    supportingEvidence: SupplierEvidenceType[];
    contradictions: SupplierEvidenceType[];
    allCandidates: number;
  };
}

// ---------------------------------------------------------------------------
// Evidence collection — text-only in this slice; visual/logo evidence is
// added by a companion module that feeds SupplierIdentityEvidence with
// type=VISUAL_LOGO once the vision path is wired.
// ---------------------------------------------------------------------------

const LEGAL_SUFFIX_RE = /\b(Inc|Incorporated|Corp|Corporation|Ltd|Limited|LLC|LLP|LP|ULC|PLC|Company|Co|GmbH|AG|SA|BV|NV)\b\.?/i;
// Sprint 3 · Post-16H Phase 4 Slice 4-reopen fix (2026-08-07) —
// the LEGAL_ENTITY_LINE regex must NOT use /i, because /i makes
// `[A-Z]` match lowercase too, which caused "the property of DMM
// ENERGY INC" to be captured as an org name from the footer terms
// ("...the property of DMM ENERGY INC. until full payment..."). An
// organisation name always STARTS with an uppercase letter — the
// suffix alternation covers common casing variants explicitly.
const LEGAL_ENTITY_LINE = /([A-Z][A-Za-z0-9&.,'\-\s]{2,60}?\s+(?:Inc|Incorporated|Corp|Corporation|Ltd|Limited|LLC|LLP|LP|ULC|PLC|Company|Co|GmbH|AG|SA|BV|NV|INC|CORP|LTD|LIMITED|COMPANY|CO))\b\.?/;
const WEBSITE_RE = /\bwww\.([a-z0-9][a-z0-9\-]{1,40})\.([a-z]{2,6})\b/i;
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)\.([A-Za-z]{2,})\b/g;
const PHONE_RE = /\b(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/;
// Sprint 3 · Post-16H Phase 4 Slice 4-reopen (2026-08-07) —
// bounded quantifiers to prevent catastrophic backtracking on
// long lines that don't contain an address suffix. `{1,60}?`
// is non-greedy + capped.
const ADDRESS_RE = /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'\-\s]{1,60}?(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Circle|Cir\.?|Highway|Hwy\.?|Way|Lane|Ln\.?|Court|Ct\.?|Place|Pl\.?|Route|Rte\.?|Square|Sq\.?)\b/i;
const TAX_REG_RE = /\b(?:GST|HST|TPS|TVQ|BN|Business\s*Number|Tax\s*Reg(?:istration)?|EIN)\s*[#:]?\s*(\d[\d\s\-]{6,30})/i;
const REMITTANCE_RE = /\bRemit(?:tance)?\s*(?:payment\s*)?to[:\s]+([^\n]+)/i;

// Domains that must NEVER become a supplier identity on their own —
// generic payment portals, cloud services, personal email hosts.
// Corroboration by a same-cluster address/phone/tax-reg on the same
// document CAN still promote them, but a bare domain match cannot.
const GENERIC_DOMAIN_BLOCKLIST = new Set([
  "gmail", "yahoo", "hotmail", "outlook", "protonmail", "aol", "icloud",
  "no-reply", "noreply", "notifications", "mailer-daemon",
  "quickbooks", "intuit", "stripe", "square",
  "amazonaws", "s3", "dropbox", "sharepoint", "onedrive", "docusign",
  "sendgrid", "mailgun", "postmark", "hubspot", "salesforce",
  "paypal", "venmo", "cashapp", "billcom",
]);

/** Normalize an organisation name into its cluster key: lowercase,
 *  strip legal-suffix, collapse non-alphanumerics. Also handles
 *  suffix variants (Inc./Ltd./LLC) so "DMM Energy Inc" and
 *  "DMM Energy" collapse to the same key. */
export function normalizeOrgName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Compute independenceGroup key for an evidence item. WEBSITE +
 *  EMAIL sharing the same domain root collapse; address + phone
 *  block sharing the same page region are separate groups. */
function independenceGroupKey(type: SupplierEvidenceType, value: string): string {
  if (type === "WEBSITE_DOMAIN" || type === "EMAIL_DOMAIN") {
    // Same domain root → same group.
    return `DOMAIN:${value.toLowerCase()}`;
  }
  return `${type}:${normalizeOrgName(value)}`;
}

/** Scan flattened text for supplier-identity evidence. All returned
 *  evidence items carry page=1 (single-page assumption for the
 *  text-only path; positioned/OCR sources overwrite this later). */
export function collectTextSupplierEvidence(text: string): SupplierIdentityEvidence[] {
  const evidence: SupplierIdentityEvidence[] = [];
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const headerCutoff = Math.min(30, Math.ceil(totalLines * 0.3));

  // ---- LEGAL_ENTITY_TEXT + HEADER_ORG_TEXT ----
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    const m = line.match(LEGAL_ENTITY_LINE);
    if (!m || !m[1]) continue;
    const name = m[1].trim().replace(/[,;:]+$/, "");
    if (name.length < 4 || name.length > 80) continue;
    const type: SupplierEvidenceType = i < headerCutoff ? "HEADER_ORG_TEXT" : "LEGAL_ENTITY_TEXT";
    const norm = normalizeOrgName(name);
    if (!norm || norm.length < 3) continue;
    evidence.push({
      type,
      value: name,
      page: 1,
      region: { page: 1, lineIndex: i },
      confidence: type === "HEADER_ORG_TEXT" ? 82 : 75,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: line.slice(0, 100),
      independenceGroup: `LEGAL:${norm}`,
    });
  }

  // ---- WEBSITE_DOMAIN ----
  for (let i = 0; i < totalLines; i++) {
    const m = lines[i].match(WEBSITE_RE);
    if (!m || !m[1]) continue;
    const root = m[1].toLowerCase();
    if (GENERIC_DOMAIN_BLOCKLIST.has(root)) continue;
    evidence.push({
      type: "WEBSITE_DOMAIN",
      value: root,
      page: 1,
      region: { page: 1, lineIndex: i },
      confidence: 70,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: `www.${root}.${m[2]}`,
      independenceGroup: `DOMAIN:${root}`,
    });
  }

  // ---- EMAIL_DOMAIN ----
  for (const m of text.matchAll(EMAIL_RE)) {
    const host = (m[2] ?? "").toLowerCase();
    if (!host) continue;
    const root = host.split(".")[0];
    if (GENERIC_DOMAIN_BLOCKLIST.has(root)) continue;
    evidence.push({
      type: "EMAIL_DOMAIN",
      value: root,
      page: 1,
      confidence: 60,
      sourceStrategy: "EMBEDDED_TEXT",
      evidenceSnippet: `${m[1]}@${host}.${m[3]}`,
      independenceGroup: `DOMAIN:${root}`,
    });
  }

  // ---- ADDRESS_BLOCK + PHONE_BLOCK + TAX_REGISTRATION ----
  // These attach to the NEAREST organisation candidate in the header
  // region — we collect them, then during clustering they're assigned
  // to the closest LEGAL/HEADER cluster (or become weak standalone
  // evidence when no cluster exists).
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    if (ADDRESS_RE.test(line)) {
      evidence.push({
        type: "ADDRESS_BLOCK",
        value: line.trim().slice(0, 100),
        page: 1,
        region: { page: 1, lineIndex: i },
        confidence: 55,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: line.trim().slice(0, 80),
        independenceGroup: `ADDRESS_LINE:${i}`,
      });
    }
    if (PHONE_RE.test(line)) {
      const p = line.match(PHONE_RE)?.[0] ?? "";
      evidence.push({
        type: "PHONE_BLOCK",
        value: p,
        page: 1,
        region: { page: 1, lineIndex: i },
        confidence: 45,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: line.trim().slice(0, 80),
        independenceGroup: `PHONE:${p.replace(/\D/g, "")}`,
      });
    }
    const trm = line.match(TAX_REG_RE);
    if (trm) {
      const num = (trm[1] ?? "").replace(/\s+/g, "");
      evidence.push({
        type: "TAX_REGISTRATION",
        value: num,
        page: 1,
        region: { page: 1, lineIndex: i },
        confidence: 78,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: line.trim().slice(0, 80),
        independenceGroup: `TAX_REG:${num}`,
      });
    }
  }

  // ---- REMITTANCE_ENTITY ----
  const remit = text.match(REMITTANCE_RE);
  if (remit && remit[1]) {
    const remitName = remit[1].trim().replace(/[,;:]+$/, "").slice(0, 80);
    const norm = normalizeOrgName(remitName);
    if (norm && norm.length >= 3) {
      evidence.push({
        type: "REMITTANCE_ENTITY",
        value: remitName,
        page: 1,
        confidence: 70,
        sourceStrategy: "EMBEDDED_TEXT",
        evidenceSnippet: remit[0].slice(0, 80),
        independenceGroup: `REMIT:${norm}`,
      });
    }
  }

  return evidence;
}

/** Group evidence into candidates by normalized identity. Attaches
 *  supporting evidence (address / phone / tax-reg / remittance) to
 *  the nearest LEGAL/HEADER cluster when structural proximity
 *  supports it. */
export function clusterSupplierEvidence(evidence: SupplierIdentityEvidence[]): SupplierIdentityCandidate[] {
  // First pass: create candidates from every LEGAL_ENTITY_TEXT /
  // HEADER_ORG_TEXT / WEBSITE_DOMAIN / EMAIL_DOMAIN / REMITTANCE_ENTITY
  // evidence.
  const candidatesByIdentity = new Map<string, SupplierIdentityCandidate>();
  const identityAliases = new Map<string, string>();   // normalized alias → canonical identity
  const IDENTITY_TYPES = new Set<SupplierEvidenceType>([
    "LEGAL_ENTITY_TEXT", "HEADER_ORG_TEXT", "WEBSITE_DOMAIN",
    "EMAIL_DOMAIN", "REMITTANCE_ENTITY", "VISUAL_LOGO", "REPEATED_BRANDING",
  ]);
  for (const e of evidence) {
    if (!IDENTITY_TYPES.has(e.type)) continue;
    const idKey = normalizeOrgName(e.value);
    if (!idKey || idKey.length < 3) continue;
    // Alias merge: domain root and legal name may match by substring.
    // If a longer legal name contains the domain root (or vice versa),
    // merge into the LONGER identity's cluster. Post-16H fix: never
    // create a self-referential alias (which would loop forever in
    // the resolution walk below).
    let target = idKey;
    for (const existing of candidatesByIdentity.keys()) {
      if (existing === idKey) continue;
      if (existing.includes(idKey) || idKey.includes(existing)) {
        target = existing.length >= idKey.length ? existing : idKey;
        if (existing !== target) identityAliases.set(existing, target);
        if (idKey !== target) identityAliases.set(idKey, target);
        break;
      }
    }
    // Resolve alias with a bounded walk (never loops).
    const visited = new Set<string>();
    while (identityAliases.has(target) && !visited.has(target)) {
      visited.add(target);
      const next = identityAliases.get(target)!;
      if (next === target) break;
      target = next;
    }
    let cand = candidatesByIdentity.get(target);
    if (!cand) {
      cand = {
        normalizedIdentity: target,
        legalNameCandidate: undefined,
        operatingNameCandidate: undefined,
        evidence: [],
        contradictions: [],
        independentEvidenceGroups: 0,
        confidence: 0,
      };
      candidatesByIdentity.set(target, cand);
    }
    cand.evidence.push(e);
    // Set legal vs operating names when the shape supports it.
    if (e.type === "LEGAL_ENTITY_TEXT" || e.type === "HEADER_ORG_TEXT") {
      const hasSuffix = LEGAL_SUFFIX_RE.test(e.value);
      if (hasSuffix && !cand.legalNameCandidate) cand.legalNameCandidate = e.value;
      if (!cand.operatingNameCandidate) {
        cand.operatingNameCandidate = e.value.replace(LEGAL_SUFFIX_RE, "").trim().replace(/[,]+$/, "");
      }
    }
    if ((e.type === "WEBSITE_DOMAIN" || e.type === "EMAIL_DOMAIN") && !cand.operatingNameCandidate) {
      cand.operatingNameCandidate = e.value.charAt(0).toUpperCase() + e.value.slice(1);
    }
  }

  // Second pass: attach supporting evidence (address/phone/tax-reg)
  // to the SINGLE candidate when there's exactly one identity, or
  // to all identity clusters as weak support when there are multiple.
  // For DMM this yields: DMM cluster gets address + phone + tax-reg.
  const supporting = evidence.filter((e) =>
    e.type === "ADDRESS_BLOCK" || e.type === "PHONE_BLOCK" || e.type === "TAX_REGISTRATION",
  );
  if (candidatesByIdentity.size === 1) {
    const only = Array.from(candidatesByIdentity.values())[0];
    for (const s of supporting) only.evidence.push(s);
  } else if (candidatesByIdentity.size > 1) {
    // When multiple clusters exist, attach the address/phone/tax-reg
    // to the FIRST (highest-line-index) cluster only — the header
    // is typically the supplier's identity, so its adjacent block
    // is its identity's support.
    const first = Array.from(candidatesByIdentity.values())
      .sort((a, b) => (a.evidence[0]?.region?.lineIndex ?? 0) - (b.evidence[0]?.region?.lineIndex ?? 0))[0];
    for (const s of supporting) first.evidence.push(s);
  }

  return Array.from(candidatesByIdentity.values());
}

/** Compute independent-evidence-group count + confidence for every
 *  candidate. Uses the founder's §5 confidence model. */
export function scoreSupplierCandidates(candidates: SupplierIdentityCandidate[]): void {
  for (const c of candidates) {
    const groups = new Set(c.evidence.map((e) => e.independenceGroup));
    c.independentEvidenceGroups = groups.size;
    // Base score from strongest single signal.
    const strongest = c.evidence.reduce((max, e) => Math.max(max, e.confidence), 0);
    // Corroboration multiplier per additional independent group.
    // Founder §5 model:
    //   1 weak signal → candidate only (≤ 40)
    //   1 very strong signal → plausible / still review (≤ 65)
    //   2 independent agreeing → strong (65..85)
    //   3+ independent agreeing → high (85..99)
    const groupBonus =
      c.independentEvidenceGroups >= 3 ? 30
      : c.independentEvidenceGroups === 2 ? 20
      : 0;
    // Weak-only cap: single WEBSITE/EMAIL group with no
    // corroboration cannot exceed 45 — founder §18.
    const types = new Set(c.evidence.map((e) => e.type));
    const onlyDomain = c.independentEvidenceGroups === 1
      && (types.has("WEBSITE_DOMAIN") || types.has("EMAIL_DOMAIN"))
      && !types.has("LEGAL_ENTITY_TEXT") && !types.has("HEADER_ORG_TEXT")
      && !types.has("TAX_REGISTRATION") && !types.has("ADDRESS_BLOCK")
      && !types.has("VISUAL_LOGO");
    let confidence = strongest + groupBonus;
    if (onlyDomain) confidence = Math.min(confidence, 45);
    c.confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  }
}

/** Founder-§5 commitment policy. Selects a winner only when the
 *  corroboration confidence clears the review threshold; otherwise
 *  abstains with a structured reason. */
export function selectSupplier(candidates: SupplierIdentityCandidate[], opts: {
  /** Minimum confidence to commit to a supplier value. Default 60. */
  commitmentThreshold?: number;
} = {}): SupplierSelection {
  const threshold = opts.commitmentThreshold ?? 60;
  const sorted = candidates.slice().sort((a, b) => b.confidence - a.confidence);
  const winner = sorted[0] ?? null;
  const alternates = sorted.slice(1).map((c) => ({
    candidate: c,
    rejectedBecause: [
      c.confidence < threshold ? "BELOW_COMMITMENT_THRESHOLD" : "LOWER_CONFIDENCE",
    ],
  }));
  const abstained = !winner || winner.confidence < threshold;
  const abstainReason = !winner
    ? "no supplier candidates"
    : winner.confidence < threshold
    ? `top candidate confidence ${winner.confidence} < threshold ${threshold} (insufficient corroboration)`
    : null;
  const supporting = winner ? Array.from(new Set(winner.evidence.map((e) => e.type))) : [];
  return {
    winner: abstained ? null : winner,
    alternates,
    abstained,
    abstainReason,
    diagnostic: {
      selectedSupplier: abstained ? null : (winner?.legalNameCandidate ?? winner?.operatingNameCandidate ?? winner?.normalizedIdentity ?? null),
      operatingName: winner?.operatingNameCandidate ?? null,
      legalName: winner?.legalNameCandidate ?? null,
      confidence: winner?.confidence ?? 0,
      independentEvidenceGroups: winner?.independentEvidenceGroups ?? 0,
      supportingEvidence: supporting,
      contradictions: winner ? Array.from(new Set(winner.contradictions.map((e) => e.type))) : [],
      allCandidates: candidates.length,
    },
  };
}

/** End-to-end helper: text → evidence → clusters → scored → selected. */
export function selectSupplierFromText(text: string, opts?: { commitmentThreshold?: number }): SupplierSelection {
  const evidence = collectTextSupplierEvidence(text);
  const candidates = clusterSupplierEvidence(evidence);
  scoreSupplierCandidates(candidates);
  return selectSupplier(candidates, opts ?? {});
}
