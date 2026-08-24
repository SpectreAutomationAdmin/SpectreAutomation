-- HR-2C Home refinement (2026-08-24) — Employee Home notification dismissal.
-- Additive-only. No back-fill.

CREATE TABLE "EmployeeHomeNotificationDismissal" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "clubId"           TEXT NOT NULL,
  "employeeId"       TEXT NOT NULL,
  "notificationKey"  TEXT NOT NULL,
  "dismissedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeHomeNotificationDismissal_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeHomeNotificationDismissal_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeHomeNotificationDismissal_employeeId_notificationKey_key"
  ON "EmployeeHomeNotificationDismissal"("employeeId", "notificationKey");
CREATE INDEX "EmployeeHomeNotificationDismissal_clubId_employeeId_idx"
  ON "EmployeeHomeNotificationDismissal"("clubId", "employeeId");
