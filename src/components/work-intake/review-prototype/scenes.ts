// AP-MOTION-1 (2026-10-13) — deterministic scene state for the AP
// Review motion prototype.  Isolated demonstration — no DB, no
// mutations, no accounting side-effects.
//
// A scene is a snapshot of what Spectre has done AT THAT MOMENT:
//   - Which workflow stage is active.
//   - Which invoice fields have been populated.
//   - Whether the vendor-match attention state is live.
//   - What the AI rail should say.
//
// The scene progression is driven by `useScenePlayback` (sibling
// hook): the user can play, pause, step, or replay through the
// six scenes.  Transitions between scenes are field-level — the
// prototype never reflows the layout.

export type SceneKey =
  | "scene-1-received"
  | "scene-2-extraction"
  | "scene-3-classification"
  | "scene-4-exception"
  | "scene-5-intervention"
  | "scene-6-resolution";

/** Highlighted-field key.  Matches a `data-field` attribute on the
 *  Classification rows + the matching document-region overlay.
 *  When the user hovers over a Classification row, the matching
 *  document-region flashes briefly (prototype-only — fabricated
 *  coordinates for the demo invoice). */
export type FieldKey =
  | "vendor"
  | "invoiceNumber"
  | "invoiceDate"
  | "dueDate"
  | "total"
  | "category"
  | "glAccount";

export interface SceneState {
  key: SceneKey;
  title: string;
  // Workflow — which stage index (1..5) is "active"; stages below
  // are "done".
  activeStageIndex: 1 | 2 | 3 | 4 | 5;
  // Which fields are POPULATED at this scene.  Any field not in
  // the set renders as "Extracting…" with a soft shimmer when the
  // scene is live.
  populated: Set<FieldKey>;
  // Which fields are PROCESSING right now (dot-pulse) — i.e. the
  // scene is in the act of filling them.  Populated AND processing
  // are mutually exclusive at a point in time.
  processing: Set<FieldKey>;
  // Vendor-match attention state.
  //   "idle"     — no indicator (scenes 1–3).
  //   "attention"— extracted name but no vendor-record match
  //                (scenes 4–5).
  //   "resolved" — match confirmed via the simulated popover
  //                (scene 6).
  vendorMatchState: "idle" | "attention" | "resolved";
  // AI assistant copy.
  ai: {
    lead: string;
    bullets: string[];
    recommendation: string | null;
  };
  // Short caption shown next to the playback controls so the
  // founder sees "where we are" without reading the AI panel.
  caption: string;
}

/** Demo invoice content — modelled on the directive-named
 *  Club Support Inc example.  Fabricated identifiers; demo-only;
 *  isolated from production. */
export const DEMO_INVOICE = {
  vendor: "Club Support Inc",
  invoiceNumber: "CS-28841",
  invoiceDate: "2026-10-10",
  dueDate: "2026-11-09",
  total: "$778.16 CAD",
  category: "Kitchen Supplies",
  glAccount: "6504 · Kitchen Operating Supplies",
  lineItems: [
    { n: 1, description: "Chef's knives, 8\"", quantity: "6", unitCost: "$42.95", amount: "$257.70" },
    { n: 2, description: "Prep gloves, nitrile (case)", quantity: "4", unitCost: "$68.40", amount: "$273.60" },
    { n: 3, description: "Dish-sanitiser concentrate", quantity: "2", unitCost: "$108.95", amount: "$217.90" },
  ],
  taxLabel: "GST 5%",
  taxAmount: "$28.96",
} as const;

/** Document-region coordinates (percent of the doc viewport) for
 *  the field-highlight overlay.  Hand-authored for THIS prototype
 *  invoice — Spectre's extractor doesn't persist coordinates
 *  today, so a real implementation would require upstream support;
 *  this prototype uses deliberate static regions purely for the
 *  motion demonstration. */
export const DEMO_FIELD_REGIONS: Record<FieldKey, { x: number; y: number; w: number; h: number }> = {
  vendor:        { x: 6,  y: 8,  w: 38, h: 7  },
  invoiceNumber: { x: 60, y: 8,  w: 32, h: 5  },
  invoiceDate:   { x: 60, y: 15, w: 32, h: 5  },
  dueDate:       { x: 60, y: 22, w: 32, h: 5  },
  total:         { x: 60, y: 68, w: 32, h: 7  },
  category:      { x: 6,  y: 55, w: 38, h: 5  },
  glAccount:     { x: 6,  y: 62, w: 38, h: 5  },
};

const ALL_IDENTITY: FieldKey[] = ["vendor", "invoiceNumber", "invoiceDate", "dueDate", "total"];
const ALL_ACCOUNTING: FieldKey[] = ["category", "glAccount"];

export function buildScenes(): SceneState[] {
  return [
    {
      key: "scene-1-received",
      title: "Invoice received",
      activeStageIndex: 1,
      populated: new Set(),
      processing: new Set(),
      vendorMatchState: "idle",
      ai: {
        lead: "Spectre received a new invoice from the Accounts Payable mailbox.",
        bullets: ["Document queued for analysis"],
        recommendation: null,
      },
      caption: "The invoice has arrived. Spectre is about to analyze it.",
    },
    {
      key: "scene-2-extraction",
      title: "Extracting invoice fields",
      activeStageIndex: 2,
      populated: new Set(ALL_IDENTITY),
      processing: new Set(),
      vendorMatchState: "idle",
      ai: {
        lead: "Spectre has read the invoice document.",
        bullets: [
          "Invoice identity extracted",
          "Vendor name read from the invoice header",
          "Totals and dates captured",
        ],
        recommendation: null,
      },
      caption: "Spectre reads the document — identity fields populate.",
    },
    {
      key: "scene-3-classification",
      title: "Suggesting GL classification",
      activeStageIndex: 2,
      populated: new Set([...ALL_IDENTITY, ...ALL_ACCOUNTING]),
      processing: new Set(),
      vendorMatchState: "idle",
      ai: {
        lead: "Spectre has suggested a GL account from vendor history.",
        bullets: [
          "Category: Kitchen Supplies",
          "GL Account: 6504 · Kitchen Operating Supplies",
          "Suggestion source: prior-coding match on similar invoices",
        ],
        recommendation: "Review the GL suggestion before approving the invoice.",
      },
      caption: "Spectre suggests a GL account from prior-coding history.",
    },
    {
      key: "scene-4-exception",
      title: "Vendor match requires attention",
      activeStageIndex: 2,
      populated: new Set([...ALL_IDENTITY, ...ALL_ACCOUNTING]),
      processing: new Set(),
      vendorMatchState: "attention",
      ai: {
        lead: "Spectre could not confidently match the extracted supplier.",
        bullets: [
          `Extracted supplier: ${DEMO_INVOICE.vendor}`,
          "No existing vendor record with a confident name match",
          "Classification + line items are preserved while this is resolved",
        ],
        recommendation: "Match an existing vendor record, or create a new vendor profile.",
      },
      caption: "No confident vendor match — Spectre pauses on the Vendor field.",
    },
    {
      key: "scene-5-intervention",
      title: "Reviewer picks a matching vendor",
      activeStageIndex: 2,
      populated: new Set([...ALL_IDENTITY, ...ALL_ACCOUNTING]),
      processing: new Set(),
      vendorMatchState: "attention",
      ai: {
        lead: "Spectre is waiting on vendor confirmation.",
        bullets: [
          "A match-vendor panel has opened next to the Vendor field",
          "Three candidate records found by name similarity",
          "No posting action will run until the match is confirmed",
        ],
        recommendation: "Select the matching record, or create a new vendor.",
      },
      caption: "A match popover opens next to the Vendor field — no banner.",
    },
    {
      key: "scene-6-resolution",
      title: "Match confirmed — ready for approval",
      activeStageIndex: 2,
      populated: new Set([...ALL_IDENTITY, ...ALL_ACCOUNTING]),
      processing: new Set(),
      vendorMatchState: "resolved",
      ai: {
        lead: "Vendor matched. The invoice is ready for a human to approve posting.",
        bullets: [
          "Vendor record linked",
          "GL suggestion preserved",
          "Posting still requires explicit human authorization",
        ],
        recommendation: "Review the invoice and click Approve & Post when ready.",
      },
      caption: "Vendor matched — workflow advances to Review. No auto-posting.",
    },
  ];
}

/** Milliseconds between automatic scene transitions during play. */
export const SCENE_INTERVAL_MS = 3_200;
