// Pure data + types for the Board & Committees roster.
//
// Lives in its own module so client components (the assign form,
// status badges, etc.) can import the constants without dragging
// the service module's server-only graph (audit → request-context
// → next/headers) through the bundler.
//
// The service module re-exports the same names for back-compat.

export const BOARD_ROLE_STATUSES = ["UPCOMING", "ACTIVE", "EXPIRED"] as const;
export type BoardRoleStatus = (typeof BOARD_ROLE_STATUSES)[number];

export const BOARD_ROLE_SOURCES = ["MANUAL", "AGM_ELECTION"] as const;
export type BoardRoleSource = (typeof BOARD_ROLE_SOURCES)[number];

/**
 * Canonical Board / Committee titles offered by the admin form's
 * pick-list. The schema column is plain text, so a controller can
 * type any title — the list is for UI consistency, not validation.
 */
export const BOARD_ROLE_TITLES = [
  "President",
  "Vice President",
  "Treasurer",
  "Secretary",
  "Director",
  "Past President",
  "Finance Committee Chair",
  "Greens Committee Chair",
  "Membership Committee Chair",
  "House Committee Chair",
  "Committee Member",
] as const;
