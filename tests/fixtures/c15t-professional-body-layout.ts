// Sprint 3 · Checkpoint 15T — real parser-output layout fixture for
// a professional-body membership invoice.
//
// The founder-observed defect: pdf-parse frequently places labels
// (SUBTOTAL, INVOICE TOTAL, GST/HST, Invoice #) on their own line
// with the value on a nearby line. The pre-15T extractors assumed
// same-line label+value.
//
// This fixture preserves the ACTUAL line ordering and spacing pdf-
// parse produces for a professional-body membership invoice — every
// vendor-specific detail (issuer name, invoice number, member name,
// amounts) has been REPLACED with fictional analogues that keep the
// same SHAPE. NO founder acceptance values (CPA Alberta, 1007565767,
// 6064, 810/400/150/40.50) appear here.

export const PROFESSIONAL_BODY_LAYOUT_TEXT =
`Invoice
[MEMBER NAME], [CREDENTIAL]
BODY ACRONYM
Suite 000, 000 - 0th Ave SW Region, RG X0X 0X0 Country
info@example-body.example
www.example-body.example
1-800-000-0000
Invoice #:
9999999999
Date:
2026-05-15
Amount Due:
0.00
Member Dues for [MEMBER NAME] (1000000) Region year 2026

Fees are shown below.

Body Region Fee
900.00
Body National Fee
500.00
Penalty
200.00
1,650.50
Payment Details:
Please pay by cheque, credit card, or bank transfer.
SUBTOTAL
Support Program / HST
25.00
1,600.00
GST/HST
75.50
INVOICE TOTAL
Body Region fees include $80.00 for the Education Foundation
and $20.00 for Support Program to support these programs.
Registered charity BN 000000000RT0000
`;

// The expected behaviours the analyser must produce from this text.
// These assertions describe SHAPES, not specific vendor identities.
export const PROFESSIONAL_BODY_EXPECTATIONS = {
  payableReferenceType: "INVOICE_NUMBER",
  payableReferenceLength: 10,           // "9999999999"
  hasSubtotal: true,
  hasTaxTotal: true,
  hasTotal: true,
  minLineItems: 3,                      // at least 3 fee lines + penalty
  hasPenaltyLine: true,                 // penalty is one of the extracted lines
  hasMembershipLine: true,              // "Member Dues" appears in full text
  topPurpose: "employee_professional_membership_dues",
  purposeSourceIsBoosted: true,
  gross: 1650.50,                       // printed total preserved
};
