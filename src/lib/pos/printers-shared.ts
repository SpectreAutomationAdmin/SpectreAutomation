// Pure constants + types for the POS printer registry. Lives in its
// own file so client components (the admin form, the lounge POS print
// picker) can import the enum lists without dragging in the server-
// only audit / headers stack that `printers.ts` pulls in.
//
// Server-side service functions stay in `printers.ts`; both files
// agree on these literals.

export const PRINTER_ROLES = ["ANY", "KITCHEN", "BAR", "SIGNATURE", "RECEIPT"] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

export const PRINTER_KINDS = ["PDF", "NETWORK", "USB", "RECEIPT_PRINTER"] as const;
export type PrinterKind = (typeof PRINTER_KINDS)[number];

export type PrinterOption = {
  id: string;
  name: string;
  role: PrinterRole;
  kind: PrinterKind;
  location: string | null;
  isDefault: boolean;
};

// Sentinel id for the always-available "Print to PDF" entry. Real
// printer rows use cuid()s so there's no collision risk.
export const PDF_PRINTER_ID = "pdf";
