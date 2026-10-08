-- AlterTable
ALTER TABLE "branches" ADD COLUMN "bankAccountName" TEXT;
ALTER TABLE "branches" ADD COLUMN "bankAccountNo" TEXT;
ALTER TABLE "branches" ADD COLUMN "bankBin" TEXT;
ALTER TABLE "branches" ADD COLUMN "buildingGuide" TEXT;
ALTER TABLE "branches" ADD COLUMN "facadePhotoUrl" TEXT;
ALTER TABLE "branches" ADD COLUMN "mapUrl" TEXT;
ALTER TABLE "branches" ADD COLUMN "parkingGuide" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "adCampaign" TEXT;
ALTER TABLE "conversations" ADD COLUMN "adId" TEXT;
ALTER TABLE "conversations" ADD COLUMN "adPostId" TEXT;
ALTER TABLE "conversations" ADD COLUMN "leadId" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "adCampaign" TEXT;
ALTER TABLE "leads" ADD COLUMN "adId" TEXT;
ALTER TABLE "leads" ADD COLUMN "adPostId" TEXT;

-- CreateTable
CREATE TABLE "stage_history" (
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
    CONSTRAINT "stage_history_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_appointments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CONSULT',
    "title" TEXT NOT NULL,
    "serviceId" TEXT,
    "doctorId" TEXT,
    "roomId" TEXT,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "code" TEXT,
    "depositAmount" INTEGER NOT NULL DEFAULT 0,
    "depositStatus" TEXT,
    "depositConfirmedAt" DATETIME,
    "depositConfirmedById" TEXT,
    "note" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "appointments_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "appointments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_appointments" ("branchId", "cancelReason", "createdAt", "createdById", "customerId", "doctorId", "endAt", "id", "note", "roomId", "serviceId", "startAt", "status", "title", "type", "updatedAt") SELECT "branchId", "cancelReason", "createdAt", "createdById", "customerId", "doctorId", "endAt", "id", "note", "roomId", "serviceId", "startAt", "status", "title", "type", "updatedAt" FROM "appointments";
DROP TABLE "appointments";
ALTER TABLE "new_appointments" RENAME TO "appointments";
CREATE UNIQUE INDEX "appointments_code_key" ON "appointments"("code");
CREATE INDEX "appointments_branchId_startAt_idx" ON "appointments"("branchId", "startAt");
CREATE INDEX "appointments_customerId_idx" ON "appointments"("customerId");
CREATE INDEX "appointments_status_idx" ON "appointments"("status");
CREATE INDEX "appointments_depositStatus_idx" ON "appointments"("depositStatus");
CREATE TABLE "new_customers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT,
    "phone" TEXT,
    "phoneNormalized" TEXT,
    "email" TEXT,
    "zaloUserId" TEXT,
    "dob" DATETIME,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "status" TEXT NOT NULL DEFAULT 'LEAD',
    "stage" TEXT NOT NULL DEFAULT 'TIEP_CAN',
    "lostReason" TEXT,
    "stageChangedAt" DATETIME,
    "lastServiceAt" DATETIME,
    "aiDataConsent" BOOLEAN NOT NULL DEFAULT false,
    "aiDataConsentAt" DATETIME,
    "aiDataConsentById" TEXT,
    "channelId" TEXT,
    "campaignId" TEXT,
    "interest" TEXT,
    "budgetNote" TEXT,
    "note" TEXT,
    "assignedToId" TEXT,
    "telesaleId" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "hiddenReason" TEXT,
    "mergedIntoId" TEXT,
    "lastContactAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "customers_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "customers_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "customers_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "customers_telesaleId_fkey" FOREIGN KEY ("telesaleId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_customers" ("address", "assignedToId", "budgetNote", "campaignId", "channelId", "city", "code", "createdAt", "dob", "email", "gender", "hidden", "hiddenReason", "id", "interest", "lastContactAt", "mergedIntoId", "name", "nameNormalized", "note", "phone", "phoneNormalized", "stage", "status", "telesaleId", "updatedAt", "zaloUserId") SELECT "address", "assignedToId", "budgetNote", "campaignId", "channelId", "city", "code", "createdAt", "dob", "email", "gender", "hidden", "hiddenReason", "id", "interest", "lastContactAt", "mergedIntoId", "name", "nameNormalized", "note", "phone", "phoneNormalized", "stage", "status", "telesaleId", "updatedAt", "zaloUserId" FROM "customers";
DROP TABLE "customers";
ALTER TABLE "new_customers" RENAME TO "customers";
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");
CREATE UNIQUE INDEX "customers_zaloUserId_key" ON "customers"("zaloUserId");
CREATE INDEX "customers_status_idx" ON "customers"("status");
CREATE INDEX "customers_stage_idx" ON "customers"("stage");
CREATE INDEX "customers_assignedToId_idx" ON "customers"("assignedToId");
CREATE INDEX "customers_phone_idx" ON "customers"("phone");
CREATE INDEX "customers_phoneNormalized_idx" ON "customers"("phoneNormalized");
CREATE INDEX "customers_nameNormalized_idx" ON "customers"("nameNormalized");
CREATE INDEX "customers_createdAt_idx" ON "customers"("createdAt");
CREATE INDEX "customers_lastContactAt_idx" ON "customers"("lastContactAt");
CREATE TABLE "new_payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contractId" TEXT,
    "invoiceId" TEXT,
    "appointmentId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PAYMENT',
    "misaInvoiceNo" TEXT,
    "depositAppliedAt" DATETIME,
    "code" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "note" TEXT,
    "receivedById" TEXT,
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "payments_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_payments" ("amount", "branchId", "code", "contractId", "createdAt", "customerId", "id", "invoiceId", "method", "note", "paidAt", "receivedById", "reference") SELECT "amount", "branchId", "code", "contractId", "createdAt", "customerId", "id", "invoiceId", "method", "note", "paidAt", "receivedById", "reference" FROM "payments";
DROP TABLE "payments";
ALTER TABLE "new_payments" RENAME TO "payments";
CREATE UNIQUE INDEX "payments_code_key" ON "payments"("code");
CREATE INDEX "payments_branchId_paidAt_idx" ON "payments"("branchId", "paidAt");
CREATE INDEX "payments_customerId_idx" ON "payments"("customerId");
CREATE INDEX "payments_appointmentId_idx" ON "payments"("appointmentId");
CREATE TABLE "new_photo_sets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "procedureId" TEXT,
    "stage" TEXT NOT NULL,
    "consentForMarketing" BOOLEAN NOT NULL DEFAULT false,
    "consentSetById" TEXT,
    "consentSetAt" DATETIME,
    "sourceMessageId" TEXT,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenById" TEXT,
    "note" TEXT,
    CONSTRAINT "photo_sets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "photo_sets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "photo_sets_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedure_records" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "photo_sets_takenById_fkey" FOREIGN KEY ("takenById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_photo_sets" ("branchId", "customerId", "id", "note", "procedureId", "stage", "takenAt", "takenById") SELECT "branchId", "customerId", "id", "note", "procedureId", "stage", "takenAt", "takenById" FROM "photo_sets";
DROP TABLE "photo_sets";
ALTER TABLE "new_photo_sets" RENAME TO "photo_sets";
CREATE INDEX "photo_sets_customerId_stage_idx" ON "photo_sets"("customerId", "stage");
CREATE INDEX "photo_sets_branchId_idx" ON "photo_sets"("branchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "stage_history_customerId_createdAt_idx" ON "stage_history"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "stage_history_toStage_createdAt_idx" ON "stage_history"("toStage", "createdAt");
