-- AlterTable
ALTER TABLE "consultation_sessions" ADD COLUMN "createdById" TEXT;
ALTER TABLE "consultation_sessions" ADD COLUMN "faceAreas" TEXT;
ALTER TABLE "consultation_sessions" ADD COLUMN "photoSetId" TEXT;
ALTER TABLE "consultation_sessions" ADD COLUMN "proposals" TEXT;

-- CreateTable
CREATE TABLE "reengage_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT,
    "conversationId" TEXT,
    "ownerId" TEXT,
    "dayKey" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "finalContent" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "broadcastId" TEXT,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" DATETIME,
    "rejectReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "manager_briefings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dayKey" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "branchId" TEXT,
    "source" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_treatment_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "doctorId" TEXT,
    "title" TEXT NOT NULL,
    "method" TEXT,
    "expectedResult" TEXT,
    "riskNote" TEXT,
    "recoveryDays" INTEGER,
    "quotationId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "treatment_plans_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "consultation_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_treatment_plans" ("branchId", "createdAt", "customerId", "doctorId", "expectedResult", "id", "method", "recoveryDays", "riskNote", "sessionId", "status", "title", "updatedAt") SELECT "branchId", "createdAt", "customerId", "doctorId", "expectedResult", "id", "method", "recoveryDays", "riskNote", "sessionId", "status", "title", "updatedAt" FROM "treatment_plans";
DROP TABLE "treatment_plans";
ALTER TABLE "new_treatment_plans" RENAME TO "treatment_plans";
CREATE UNIQUE INDEX "treatment_plans_quotationId_key" ON "treatment_plans"("quotationId");
CREATE INDEX "treatment_plans_customerId_idx" ON "treatment_plans"("customerId");
CREATE TABLE "new_treatment_plan_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "serviceId" TEXT,
    "productId" TEXT,
    "productName" TEXT,
    "doseTenths" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "listPrice" INTEGER,
    "faceArea" TEXT,
    "name" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    CONSTRAINT "treatment_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "treatment_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "treatment_plan_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_treatment_plan_items" ("id", "name", "note", "planId", "serviceId", "stepOrder") SELECT "id", "name", "note", "planId", "serviceId", "stepOrder" FROM "treatment_plan_items";
DROP TABLE "treatment_plan_items";
ALTER TABLE "new_treatment_plan_items" RENAME TO "treatment_plan_items";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "reengage_drafts_status_createdAt_idx" ON "reengage_drafts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "reengage_drafts_ownerId_status_idx" ON "reengage_drafts"("ownerId", "status");

-- CreateIndex
CREATE INDEX "reengage_drafts_customerId_idx" ON "reengage_drafts"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "manager_briefings_dayKey_scopeKey_key" ON "manager_briefings"("dayKey", "scopeKey");

