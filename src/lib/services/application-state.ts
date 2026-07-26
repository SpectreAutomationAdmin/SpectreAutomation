// Application-status state machine. Encodes the only transitions the
// product permits so a bad route handler can't move an Applicant directly
// from DRAFT to APPROVED.

import { ConflictError } from "../errors";

export type AppStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "PENDING_INFORMATION"
  | "APPROVED"
  | "DENIED"
  | "WAITLISTED"
  | "WITHDRAWN";

export const ALL_STATUSES: readonly AppStatus[] = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "PENDING_INFORMATION",
  "APPROVED", "DENIED", "WAITLISTED", "WITHDRAWN",
];

// Map of current -> allowed-next statuses.
// Terminal-ish: APPROVED, DENIED, WITHDRAWN. WAITLISTED can still move
// forward to APPROVED/DENIED (admin pulls from waitlist).
const TRANSITIONS: Record<AppStatus, AppStatus[]> = {
  DRAFT: ["SUBMITTED", "WITHDRAWN"],
  SUBMITTED: ["UNDER_REVIEW", "PENDING_INFORMATION", "APPROVED", "DENIED", "WAITLISTED", "WITHDRAWN"],
  UNDER_REVIEW: ["PENDING_INFORMATION", "APPROVED", "DENIED", "WAITLISTED", "WITHDRAWN"],
  PENDING_INFORMATION: ["SUBMITTED", "UNDER_REVIEW", "DENIED", "WITHDRAWN"],
  WAITLISTED: ["UNDER_REVIEW", "APPROVED", "DENIED", "WITHDRAWN"],
  APPROVED: [], // member has been created; no further status changes
  DENIED: ["UNDER_REVIEW"], // allow reopening on appeal
  WITHDRAWN: [],
};

export function canTransition(from: AppStatus, to: AppStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function requireTransition(from: AppStatus, to: AppStatus): void {
  if (from === to) return; // idempotent
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot move application from ${from} to ${to}`);
  }
}

export function isTerminal(s: AppStatus): boolean {
  return s === "APPROVED" || s === "WITHDRAWN";
}
