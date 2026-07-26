// Step 18 — unified seated-party derivation.
//
// A SEATED dining table on the floor map shows the same host + party +
// elapsed time card regardless of how the party got there. There are
// two valid paths:
//
//   1. Reservation-seated: a DiningReservation exists in SEATED state
//      and is linked to the table. The reservation is the source of
//      truth for host, party size, and the seated timestamp
//      (`actualSeatedAt`).
//
//   2. POS/self-seated: a waiter marked the table seated directly
//      from the floor map. No reservation exists; a POSCheck has been
//      stamped with `tableId`. Host comes from the primary
//      POSCheckSeat (isPrimary=true), party size from POSCheck.partySize
//      with a count-of-seats fallback, and seated-since from
//      POSCheck.createdAt.
//
// The returned shape exposes a `checkIsActive` flag so callers can
// disable Mark departed while an unsettled check is still on the
// table — settling first guarantees the seat view + accounting agree.

export type SeatedPartySource = "RESERVATION" | "POS_CHECK";

export type SeatedParty = {
  source: SeatedPartySource;
  hostName: string | null;
  partySize: number | null;
  seatedSinceIso: string;
  reservationId: string | null;
  checkId: string | null;
  checkIsActive: boolean;
};

type ReservationInput = {
  id: string;
  status: string;
  partySize: number;
  startTime: Date;
  actualSeatedAt: Date | null;
  guestName: string | null;
  member: { firstName: string; lastName: string } | null;
} | null;

type OpenCheckInput = {
  id: string;
  status: string;
  createdAt: Date;
  partySize: number | null;
  guestName: string | null;
  member: { firstName: string; lastName: string } | null;
  seats: Array<{
    guestName: string | null;
    member: { firstName: string; lastName: string } | null;
  }>;
  _count: { seats: number };
} | null;

export function deriveSeatedParty(input: {
  reservation: ReservationInput;
  openCheck: OpenCheckInput;
  tableStatus: string;
}): SeatedParty | null {
  const { reservation, openCheck, tableStatus } = input;

  // Reservation-first: a SEATED reservation is the canonical source.
  if (reservation && reservation.status === "SEATED") {
    const hostName =
      (reservation.member
        ? `${reservation.member.firstName} ${reservation.member.lastName}`
        : null) ?? reservation.guestName ?? null;
    return {
      source: "RESERVATION",
      hostName,
      partySize: reservation.partySize,
      seatedSinceIso: (reservation.actualSeatedAt ?? reservation.startTime).toISOString(),
      reservationId: reservation.id,
      checkId: openCheck?.id ?? null,
      checkIsActive: !!openCheck,
    };
  }

  // POS / self-seated path: no reservation, but the table is SEATED
  // and there's an open check stamped to it.
  if (openCheck && tableStatus === "SEATED") {
    const primarySeat = openCheck.seats[0] ?? null;
    const hostName =
      (primarySeat?.member
        ? `${primarySeat.member.firstName} ${primarySeat.member.lastName}`
        : null) ??
      primarySeat?.guestName ??
      (openCheck.member
        ? `${openCheck.member.firstName} ${openCheck.member.lastName}`
        : null) ??
      openCheck.guestName ?? null;
    const partySize = openCheck.partySize ?? openCheck._count.seats ?? null;
    return {
      source: "POS_CHECK",
      hostName,
      partySize,
      seatedSinceIso: openCheck.createdAt.toISOString(),
      reservationId: null,
      checkId: openCheck.id,
      checkIsActive: true,
    };
  }

  return null;
}
