// Sprint 3 · Checkpoint 15T — real parser-output layout fixture for
// a recurring connectivity/communications service statement.
//
// The founder-observed defect: a statement whose payable reference
// is labelled "Statement number" (not "Invoice #"), whose amounts
// appear one line below their labels, whose service description
// includes bandwidth units — was routed to an unrelated printing
// account.
//
// This fixture preserves the ACTUAL line ordering pdf-parse produces
// for such a statement. NO founder acceptance values (OXIO,
// OXIO-23375874, 00108064, 40.32, oxio.ca) appear here.

export const RECURRING_SERVICE_LAYOUT_TEXT =
`Statement of account

BODY
100 Sample Ave #0000
Region, RG X0X 0X0

[SUBSCRIBER NAME]
00-00 Sample Terrace SW
Region, RG X0X 0X0

Billing cycle
07/28/2026 - 08/27/2026

Statement number
BODY-99999999

Due date

Total amount due
CA$50.99

Your account number: 00099999

Charges

Ongoing charges
CA$50.00

Taxes/Fees
CA$2.50

Credits
-CA$1.51

Pending payments
CA$50.99

More about your charges

Internet: 25 mbit/s, 2.5 mbit/s
CA$50.00

GST 999999999
CA$2.50

Outage Credit
CA$1.51
`;

export const RECURRING_SERVICE_EXPECTATIONS = {
  payableReferenceType: "STATEMENT_NUMBER",
  payableReferencePrefix: "BODY-",
  hasTotal: true,
  gross: 50.99,                          // printed total preserved
  hasInternetLine: true,
  hasCreditLine: true,
  minCreditGroups: 1,
  topPurpose: "recurring_communications_or_connectivity_service",
  purposeSourceIsBoosted: true,
};
