// Sprint 3 · Checkpoint 15U — sanitized Coulee Ridge Chart of
// Accounts SHAPE for regression tests. Preserves the account names,
// categories, and FS groups the real tenant has, so the ranker's
// competition tests reproduce the actual COA the founder-observed
// documents ranked against.
//
// The list is deliberately abbreviated to the accounts the regression
// scenarios can interact with. NO tenant-identifying values leak
// (no clubId, no account ids, no vendors, no invoice numbers, no
// exact amounts — just names + taxonomy).

import type { AccountView } from "../../src/lib/ap-intelligence/gl-account-concepts";

// Every account name below is REAL Coulee Ridge COA data (nothing
// invented). This must be true for the tests to exercise the same
// competition the ranker faces in production.
export const COULEE_RIDGE_ACCOUNTS_SHAPE: AccountView[] = [
  { id: "a-6045", accountNumber: "6045", name: "Score Cards & Printing", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_OFFICE_SUPPLIES", fsGroupName: "Office Supplies" },
  { id: "a-6046", accountNumber: "6046", name: "Rentals - Equipment", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_OTHER_EXPENSES", fsGroupName: "Other Expenses" },
  { id: "a-6047", accountNumber: "6047", name: "Utilities", categoryKey: "UTILITIES", categoryName: "Utilities", fsGroupKey: "IS_UTILITIES", fsGroupName: "Utilities" },
  { id: "a-6048", accountNumber: "6048", name: "Utilities - Backshop", categoryKey: "UTILITIES", categoryName: "Utilities", fsGroupKey: "IS_UTILITIES", fsGroupName: "Utilities" },
  { id: "a-6049", accountNumber: "6049", name: "Waste Disposal", categoryKey: "OTHER_EXPENSES", categoryName: "Other Expenses", fsGroupKey: "IS_OTHER_EXPENSES", fsGroupName: "Other Expenses" },
  { id: "a-6051", accountNumber: "6051", name: "Bank Charges & Credit Card Fees", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_BANK_CHARGES", fsGroupName: "Bank Charges" },
  { id: "a-6053", accountNumber: "6053", name: "Interest Expense", categoryKey: "OTHER_EXPENSES", categoryName: "Other Expenses", fsGroupKey: "IS_INTEREST_EXPENSE", fsGroupName: "Interest Expense" },
  { id: "a-6054", accountNumber: "6054", name: "Computer & IT Services", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_IT_SOFTWARE", fsGroupName: "IT & Software" },
  { id: "a-6060", accountNumber: "6060", name: "Insurance", categoryKey: "INSURANCE", categoryName: "Insurance", fsGroupKey: "IS_INSURANCE", fsGroupName: "Insurance" },
  { id: "a-6061", accountNumber: "6061", name: "Accounting fees", categoryKey: "PROFESSIONAL_SERVICES", categoryName: "Professional Services", fsGroupKey: "IS_PROFESSIONAL_FEES", fsGroupName: "Professional Fees" },
  { id: "a-6062", accountNumber: "6062", name: "Licenses", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_LICENCES_PERMITS", fsGroupName: "Licences & Permits" },
  { id: "a-6064", accountNumber: "6064", name: "Membership & Dues", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_MEMBERSHIPS_SUBS", fsGroupName: "Memberships & Subscriptions" },
  { id: "a-6065", accountNumber: "6065", name: "Office Supplies", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_OFFICE_SUPPLIES", fsGroupName: "Office Supplies" },
  { id: "a-6066", accountNumber: "6066", name: "Postage", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_OFFICE_SUPPLIES", fsGroupName: "Office Supplies" },
  { id: "a-6068", accountNumber: "6068", name: "Consultant & Professional Services", categoryKey: "PROFESSIONAL_SERVICES", categoryName: "Professional Services", fsGroupKey: "IS_PROFESSIONAL_FEES", fsGroupName: "Professional Fees" },
  { id: "a-6069", accountNumber: "6069", name: "Printing - Roster, Newsletter, AGM", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_OFFICE_SUPPLIES", fsGroupName: "Office Supplies" },
  { id: "a-6071", accountNumber: "6071", name: "Subscriptions", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_MEMBERSHIPS_SUBS", fsGroupName: "Memberships & Subscriptions" },
  { id: "a-6072", accountNumber: "6072", name: "Telephone & Internet", categoryKey: "ADMIN_EXPENSES", categoryName: "Administrative Expenses", fsGroupKey: "IS_TELEPHONE_INTERNET", fsGroupName: "Telephone & Internet" },
  { id: "a-6073", accountNumber: "6073", name: "Clubhouse Cable , Music, PA Sys", categoryKey: "OTHER_EXPENSES", categoryName: "Other Expenses", fsGroupKey: "IS_OTHER_EXPENSES", fsGroupName: "Other Expenses" },
];
