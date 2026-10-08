-- AlterTable
ALTER TABLE "quotations" ADD COLUMN "optionTier" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "boardPrefs" TEXT;

-- CreateTable
CREATE TABLE "upsell_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT,
    "triggerServiceId" TEXT NOT NULL,
    "suggestServiceId" TEXT NOT NULL,
    "pitch" TEXT NOT NULL,
    "conditionNote" TEXT,
    "onlyIfNotDone" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "upsell_rules_triggerServiceId_fkey" FOREIGN KEY ("triggerServiceId") REFERENCES "services" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "upsell_rules_suggestServiceId_fkey" FOREIGN KEY ("suggestServiceId") REFERENCES "services" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "upsell_offers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT,
    "triggerServiceId" TEXT,
    "suggestServiceId" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "declineReason" TEXT,
    "quotationId" TEXT,
    "suggestedById" TEXT,
    "suggestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" DATETIME,
    CONSTRAINT "upsell_offers_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "upsell_rules" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "upsell_offers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "upsell_rules_triggerServiceId_active_idx" ON "upsell_rules"("triggerServiceId", "active");

-- CreateIndex
CREATE INDEX "upsell_offers_customerId_status_idx" ON "upsell_offers"("customerId", "status");

-- CreateIndex
CREATE INDEX "upsell_offers_ruleId_status_idx" ON "upsell_offers"("ruleId", "status");

-- CreateIndex
CREATE INDEX "upsell_offers_suggestedAt_idx" ON "upsell_offers"("suggestedAt");

