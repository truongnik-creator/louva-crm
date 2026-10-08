-- AlterTable
ALTER TABLE "contract_items" ADD COLUMN "upsellById" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "firstPurchaseAt" DATETIME;
ALTER TABLE "customers" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "customers" ADD COLUMN "referredAt" DATETIME;
ALTER TABLE "customers" ADD COLUMN "referredById" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "hasPhoneAt" DATETIME;
ALTER TABLE "leads" ADD COLUMN "showedUpAt" DATETIME;

-- AlterTable
ALTER TABLE "payroll_periods" ADD COLUMN "computedAt" DATETIME;
ALTER TABLE "payroll_periods" ADD COLUMN "paramsJson" TEXT;

-- CreateTable
CREATE TABLE "staff_violation_flags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "branchId" TEXT,
    "periodKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "flaggedById" TEXT,
    "flaggedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedById" TEXT
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "customerId" TEXT,
    "branchId" TEXT,
    "value" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" DATETIME,
    "redeemedById" TEXT,
    "redeemedPaymentId" TEXT
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "procedureId" TEXT,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "voucherId" TEXT,
    "status" TEXT NOT NULL,
    "paidAt" DATETIME,
    "paidById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "gift_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "gift_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "giftItemId" TEXT NOT NULL,
    "giftName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCost" INTEGER NOT NULL,
    "totalCost" INTEGER NOT NULL,
    "visitId" TEXT,
    "givenById" TEXT,
    "givenByName" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "sales_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "branchId" TEXT,
    "serviceId" TEXT,
    "targetRevenue" INTEGER NOT NULL DEFAULT 0,
    "targetShowups" INTEGER,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "conversation_scores" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "customerId" TEXT,
    "userId" TEXT,
    "branchId" TEXT,
    "weekKey" TEXT NOT NULL,
    "scriptId" TEXT,
    "scriptVersion" INTEGER,
    "status" TEXT NOT NULL,
    "score" INTEGER,
    "criteriaJson" TEXT,
    "summary" TEXT,
    "model" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_campaign_costs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_costs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_campaign_costs" ("amount", "campaignId", "date", "id", "note") SELECT "amount", "campaignId", "date", "id", "note" FROM "campaign_costs";
DROP TABLE "campaign_costs";
ALTER TABLE "new_campaign_costs" RENAME TO "campaign_costs";
CREATE UNIQUE INDEX "campaign_costs_campaignId_date_key" ON "campaign_costs"("campaignId", "date");
CREATE TABLE "new_contracts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quotationId" TEXT,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "consultantId" TEXT,
    "signedAt" DATETIME,
    "cancelReason" TEXT,
    "note" TEXT,
    "closeType" TEXT NOT NULL DEFAULT 'FULL',
    "closingDoctorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "contracts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "contracts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "contracts_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "contracts_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_contracts" ("branchId", "cancelReason", "code", "consultantId", "createdAt", "customerId", "discount", "id", "note", "paidAmount", "quotationId", "signedAt", "status", "subtotal", "total", "updatedAt") SELECT "branchId", "cancelReason", "code", "consultantId", "createdAt", "customerId", "discount", "id", "note", "paidAmount", "quotationId", "signedAt", "status", "subtotal", "total", "updatedAt" FROM "contracts";
DROP TABLE "contracts";
ALTER TABLE "new_contracts" RENAME TO "contracts";
CREATE UNIQUE INDEX "contracts_quotationId_key" ON "contracts"("quotationId");
CREATE UNIQUE INDEX "contracts_code_key" ON "contracts"("code");
CREATE INDEX "contracts_customerId_idx" ON "contracts"("customerId");
CREATE INDEX "contracts_branchId_signedAt_idx" ON "contracts"("branchId", "signedAt");
CREATE TABLE "new_payroll_lines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "periodId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseSalary" INTEGER NOT NULL DEFAULT 0,
    "commission" INTEGER NOT NULL DEFAULT 0,
    "allowance" INTEGER NOT NULL DEFAULT 0,
    "deduction" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "workedDays" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "roleCode" TEXT,
    "showups" INTEGER NOT NULL DEFAULT 0,
    "revenue" INTEGER NOT NULL DEFAULT 0,
    "salesBonus" INTEGER NOT NULL DEFAULT 0,
    "upsellBonus" INTEGER NOT NULL DEFAULT 0,
    "adsBonus" INTEGER NOT NULL DEFAULT 0,
    "detailJson" TEXT,
    CONSTRAINT "payroll_lines_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "payroll_periods" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payroll_lines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_payroll_lines" ("allowance", "baseSalary", "commission", "deduction", "id", "note", "periodId", "total", "userId", "workedDays") SELECT "allowance", "baseSalary", "commission", "deduction", "id", "note", "periodId", "total", "userId", "workedDays" FROM "payroll_lines";
DROP TABLE "payroll_lines";
ALTER TABLE "new_payroll_lines" RENAME TO "payroll_lines";
CREATE UNIQUE INDEX "payroll_lines_periodId_userId_key" ON "payroll_lines"("periodId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "staff_violation_flags_periodKey_userId_idx" ON "staff_violation_flags"("periodKey", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");

-- CreateIndex
CREATE INDEX "vouchers_customerId_idx" ON "vouchers"("customerId");

-- CreateIndex
CREATE INDEX "vouchers_status_expiresAt_idx" ON "vouchers"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_customerId_key" ON "referral_rewards"("customerId");

-- CreateIndex
CREATE INDEX "referral_rewards_referrerId_idx" ON "referral_rewards"("referrerId");

-- CreateIndex
CREATE INDEX "gift_logs_customerId_idx" ON "gift_logs"("customerId");

-- CreateIndex
CREATE INDEX "gift_logs_branchId_createdAt_idx" ON "gift_logs"("branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sales_targets_scopeKey_key" ON "sales_targets"("scopeKey");

-- CreateIndex
CREATE INDEX "sales_targets_periodKey_idx" ON "sales_targets"("periodKey");

-- CreateIndex
CREATE INDEX "conversation_scores_weekKey_userId_idx" ON "conversation_scores"("weekKey", "userId");

-- CreateIndex
CREATE INDEX "conversation_scores_customerId_idx" ON "conversation_scores"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_scores_conversationId_weekKey_key" ON "conversation_scores"("conversationId", "weekKey");

-- CreateIndex
CREATE INDEX "contract_items_upsellById_idx" ON "contract_items"("upsellById");

-- CreateIndex
CREATE UNIQUE INDEX "customers_referralCode_key" ON "customers"("referralCode");

-- CreateIndex
CREATE INDEX "customers_firstPurchaseAt_idx" ON "customers"("firstPurchaseAt");

-- CreateIndex
CREATE INDEX "customers_referredById_idx" ON "customers"("referredById");

-- CreateIndex
CREATE INDEX "leads_hasPhoneAt_idx" ON "leads"("hasPhoneAt");

-- CreateIndex
CREATE INDEX "leads_showedUpAt_idx" ON "leads"("showedUpAt");


-- Lô 5: điền dữ liệu có sẵn cho các cột mới.
-- F32: lần trả tiền thật đầu tiên của khách (bỏ hoàn tiền, voucher, phiếu 0 đồng).
UPDATE "customers" SET "firstPurchaseAt" = (
  SELECT MIN(p."paidAt") FROM "payments" p
  WHERE p."customerId" = "customers"."id" AND p."amount" > 0 AND p."type" <> 'REFUND' AND p."method" <> 'VOUCHER'
);
-- F15: lead đã có SĐT thì lấy mốc liên hệ đầu (hoặc ngày tạo) làm mốc có SĐT.
UPDATE "leads" SET "hasPhoneAt" = COALESCE("firstContactAt", "createdAt")
WHERE "phone" IS NOT NULL AND TRIM("phone") <> '' AND "hasPhoneAt" IS NULL;
-- F15: lead đã thành khách và khách đã check-in: mốc khách đến lần đầu.
UPDATE "leads" SET "showedUpAt" = (
  SELECT MIN(v."checkedInAt") FROM "visits" v WHERE v."customerId" = "leads"."convertedCustomerId"
) WHERE "convertedCustomerId" IS NOT NULL AND "showedUpAt" IS NULL;
-- F15: lead đã chuyển thành khách phải ở bước WON (sửa phễu marketing).
UPDATE "leads" SET "stage" = 'WON' WHERE "convertedCustomerId" IS NOT NULL AND "stage" NOT IN ('WON');
