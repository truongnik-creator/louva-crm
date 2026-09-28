-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_visits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "queueNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "consultantId" TEXT,
    "receptionistId" TEXT,
    "purpose" TEXT,
    "note" TEXT,
    "checkedInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calledAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "visits_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "visits_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "visits_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "visits_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "visits_receptionistId_fkey" FOREIGN KEY ("receptionistId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_visits" ("appointmentId", "branchId", "calledAt", "checkedInAt", "consultantId", "customerId", "finishedAt", "id", "note", "purpose", "queueNumber", "status") SELECT "appointmentId", "branchId", "calledAt", "checkedInAt", "consultantId", "customerId", "finishedAt", "id", "note", "purpose", "queueNumber", "status" FROM "visits";
DROP TABLE "visits";
ALTER TABLE "new_visits" RENAME TO "visits";
CREATE UNIQUE INDEX "visits_appointmentId_key" ON "visits"("appointmentId");
CREATE INDEX "visits_branchId_status_idx" ON "visits"("branchId", "status");
CREATE INDEX "visits_checkedInAt_idx" ON "visits"("checkedInAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
