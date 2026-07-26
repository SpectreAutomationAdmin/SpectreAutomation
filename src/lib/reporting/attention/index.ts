// Board Attention Engine — barrel export.
//
// Consumers import from this module:
//
//   import {
//     evaluateMetric,
//     rollupChapter,
//     rollupDashboard,
//     countFlagged,
//     labelFor,
//     kpiToneFor,
//   } from "@/lib/reporting/attention";

export type {
  Attention,
  ThresholdRule,
  Thresholds,
  PillarKey,
} from "./types";

export { DEFAULT_THRESHOLDS } from "./thresholds";
export { evaluateMetric, evaluateRule } from "./engine";
export { rollupChapter, rollupDashboard, worstOf, countFlagged } from "./rollup";
export { labelFor, kpiToneFor } from "./labels";
