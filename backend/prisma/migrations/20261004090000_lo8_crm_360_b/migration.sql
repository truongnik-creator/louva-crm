-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "opportunityId" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "needsProfile" TEXT;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN "followupTaskId" TEXT;
ALTER TABLE "quotations" ADD COLUMN "opportunityId" TEXT;
ALTER TABLE "quotations" ADD COLUMN "rejectReason" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "checklistItemId" TEXT;
ALTER TABLE "tasks" ADD COLUMN "opportunityId" TEXT;
ALTER TABLE "tasks" ADD COLUMN "stageKey" TEXT;

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT,
    "serviceId" TEXT,
    "title" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "subStage" TEXT,
    "stageChangedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "expectedValue" INTEGER,
    "expectedCloseAt" DATETIME,
    "channelId" TEXT,
    "campaignId" TEXT,
    "ownerId" TEXT,
    "lostReason" TEXT,
    "lostNote" TEXT,
    "closedAt" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "opportunities_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stage_checklist_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stage" TEXT NOT NULL,
    "branchId" TEXT,
    "title" TEXT NOT NULL,
    "messageTemplate" TEXT,
    "dueDays" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "treatment_packages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "contractItemId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "usedSessions" INTEGER NOT NULL DEFAULT 0,
    "price" INTEGER NOT NULL,
    "intervalDays" INTEGER,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cancelReason" TEXT,
    "lastUsedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "treatment_packages_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "package_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "sessionNo" INTEGER NOT NULL,
    "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "procedureId" TEXT,
    "visitId" TEXT,
    "value" INTEGER NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "package_sessions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "treatment_packages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_stage_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "event" TEXT,
    "lostReason" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opportunityId" TEXT,
    CONSTRAINT "stage_history_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stage_history_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_stage_history" ("createdAt", "customerId", "event", "fromStage", "id", "lostReason", "note", "source", "toStage", "userId", "userName") SELECT "createdAt", "customerId", "event", "fromStage", "id", "lostReason", "note", "source", "toStage", "userId", "userName" FROM "stage_history";
DROP TABLE "stage_history";
ALTER TABLE "new_stage_history" RENAME TO "stage_history";
CREATE INDEX "stage_history_customerId_createdAt_idx" ON "stage_history"("customerId", "createdAt");
CREATE INDEX "stage_history_toStage_createdAt_idx" ON "stage_history"("toStage", "createdAt");
CREATE INDEX "stage_history_opportunityId_createdAt_idx" ON "stage_history"("opportunityId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "opportunities_customerId_status_idx" ON "opportunities"("customerId", "status");

-- CreateIndex
CREATE INDEX "opportunities_stage_status_idx" ON "opportunities"("stage", "status");

-- CreateIndex
CREATE INDEX "opportunities_ownerId_idx" ON "opportunities"("ownerId");

-- CreateIndex
CREATE INDEX "stage_checklist_items_stage_active_idx" ON "stage_checklist_items"("stage", "active");

-- CreateIndex
CREATE UNIQUE INDEX "treatment_packages_contractItemId_key" ON "treatment_packages"("contractItemId");

-- CreateIndex
CREATE INDEX "treatment_packages_customerId_status_idx" ON "treatment_packages"("customerId", "status");

-- CreateIndex
CREATE INDEX "treatment_packages_status_lastUsedAt_idx" ON "treatment_packages"("status", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "package_sessions_procedureId_key" ON "package_sessions"("procedureId");

-- CreateIndex
CREATE UNIQUE INDEX "package_sessions_packageId_sessionNo_key" ON "package_sessions"("packageId", "sessionNo");

-- CreateIndex
CREATE INDEX "tasks_opportunityId_idx" ON "tasks"("opportunityId");

