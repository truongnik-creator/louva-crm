-- AlterTable
ALTER TABLE "procedure_records" ADD COLUMN "aftercareGeneratedAt" DATETIME;
ALTER TABLE "procedure_records" ADD COLUMN "injectionArea" TEXT;
ALTER TABLE "procedure_records" ADD COLUMN "nurseId" TEXT;
ALTER TABLE "procedure_records" ADD COLUMN "retreatDays" INTEGER;
ALTER TABLE "procedure_records" ADD COLUMN "retreatDueAt" DATETIME;
ALTER TABLE "procedure_records" ADD COLUMN "volumeTenthCc" INTEGER;

-- AlterTable
ALTER TABLE "product_usages" ADD COLUMN "costAtUse" INTEGER;
ALTER TABLE "product_usages" ADD COLUMN "quantityTenths" INTEGER;

-- AlterTable
ALTER TABLE "services" ADD COLUMN "retreatDays" INTEGER;

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULE',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "triggeredById" TEXT
);

-- CreateTable
CREATE TABLE "job_locks" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "lockedUntil" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "automation_marks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "round_robin_states" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "lastUserId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "conversation_tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_tags_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conversation_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_notes_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "customer_segments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "filter" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "segmentId" TEXT,
    "filter" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "broadcastId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "content" TEXT,
    "error" TEXT,
    "taskId" TEXT,
    "messageId" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "broadcast_recipients_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PERCENT',
    "value" INTEGER NOT NULL,
    "maxSlots" INTEGER,
    "usedSlots" INTEGER NOT NULL DEFAULT 0,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "branchId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lockedAt" DATETIME,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "promotion_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promotionId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    CONSTRAINT "promotion_services_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "promotion_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sales_scripts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL DEFAULT 'default',
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "customerId" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "suggestion" TEXT,
    "scriptId" TEXT,
    "model" TEXT,
    "checkResult" TEXT,
    "sentMessageId" TEXT,
    "sentText" TEXT,
    "sentAt" DATETIME,
    "edited" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_contract_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL,
    "deliveredQty" INTEGER NOT NULL DEFAULT 0,
    "listPrice" INTEGER,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "promotionDiscount" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "promotionId" TEXT,
    "approvedById" TEXT,
    CONSTRAINT "contract_items_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "contract_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_contract_items" ("amount", "contractId", "deliveredQty", "discount", "id", "name", "quantity", "serviceId", "unitPrice") SELECT "amount", "contractId", "deliveredQty", "discount", "id", "name", "quantity", "serviceId", "unitPrice" FROM "contract_items";
DROP TABLE "contract_items";
ALTER TABLE "new_contract_items" RENAME TO "contract_items";
CREATE INDEX "contract_items_promotionId_idx" ON "contract_items"("promotionId");
CREATE TABLE "new_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT,
    "oaConfigId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "channel" TEXT NOT NULL DEFAULT 'ZALO_OA',
    "title" TEXT NOT NULL,
    "externalId" TEXT,
    "memberCount" INTEGER,
    "customerId" TEXT,
    "assignedToId" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" DATETIME,
    "lastMessagePreview" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "pancakePageId" TEXT,
    "pancakeConversationId" TEXT,
    "adId" TEXT,
    "adPostId" TEXT,
    "adCampaign" TEXT,
    "leadId" TEXT,
    "lastInboundAt" DATETIME,
    "lastOutboundAt" DATETIME,
    "waitingSince" DATETIME,
    "assignedAt" DATETIME,
    "medicalFlag" BOOLEAN NOT NULL DEFAULT false,
    "medicalFlagAt" DATETIME,
    CONSTRAINT "conversations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_oaConfigId_fkey" FOREIGN KEY ("oaConfigId") REFERENCES "zalo_oa_configs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_pancakePageId_fkey" FOREIGN KEY ("pancakePageId") REFERENCES "pancake_pages" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conversations" ("adCampaign", "adId", "adPostId", "assignedToId", "branchId", "channel", "createdAt", "customerId", "externalId", "id", "kind", "lastMessageAt", "lastMessagePreview", "leadId", "memberCount", "oaConfigId", "pancakeConversationId", "pancakePageId", "title", "unreadCount", "updatedAt") SELECT "adCampaign", "adId", "adPostId", "assignedToId", "branchId", "channel", "createdAt", "customerId", "externalId", "id", "kind", "lastMessageAt", "lastMessagePreview", "leadId", "memberCount", "oaConfigId", "pancakeConversationId", "pancakePageId", "title", "unreadCount", "updatedAt" FROM "conversations";
DROP TABLE "conversations";
ALTER TABLE "new_conversations" RENAME TO "conversations";
CREATE UNIQUE INDEX "conversations_pancakeConversationId_key" ON "conversations"("pancakeConversationId");
CREATE INDEX "conversations_kind_lastMessageAt_idx" ON "conversations"("kind", "lastMessageAt");
CREATE INDEX "conversations_assignedToId_idx" ON "conversations"("assignedToId");
CREATE INDEX "conversations_branchId_idx" ON "conversations"("branchId");
CREATE INDEX "conversations_customerId_idx" ON "conversations"("customerId");
CREATE INDEX "conversations_channel_idx" ON "conversations"("channel");
CREATE INDEX "conversations_waitingSince_idx" ON "conversations"("waitingSince");
CREATE UNIQUE INDEX "conversations_externalId_oaConfigId_key" ON "conversations"("externalId", "oaConfigId");
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
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "optOutAt" DATETIME,
    "optOutReason" TEXT,
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
INSERT INTO "new_customers" ("address", "aiDataConsent", "aiDataConsentAt", "aiDataConsentById", "assignedToId", "budgetNote", "campaignId", "channelId", "city", "code", "createdAt", "dob", "email", "gender", "hidden", "hiddenReason", "id", "interest", "lastContactAt", "lastServiceAt", "lostReason", "mergedIntoId", "name", "nameNormalized", "note", "phone", "phoneNormalized", "stage", "stageChangedAt", "status", "telesaleId", "updatedAt", "zaloUserId") SELECT "address", "aiDataConsent", "aiDataConsentAt", "aiDataConsentById", "assignedToId", "budgetNote", "campaignId", "channelId", "city", "code", "createdAt", "dob", "email", "gender", "hidden", "hiddenReason", "id", "interest", "lastContactAt", "lastServiceAt", "lostReason", "mergedIntoId", "name", "nameNormalized", "note", "phone", "phoneNormalized", "stage", "stageChangedAt", "status", "telesaleId", "updatedAt", "zaloUserId" FROM "customers";
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
CREATE TABLE "new_quotation_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quotationId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL,
    "listPrice" INTEGER,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "promotionDiscount" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "promotionId" TEXT,
    "approvedById" TEXT,
    CONSTRAINT "quotation_items_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quotation_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_quotation_items" ("amount", "discount", "id", "name", "quantity", "quotationId", "serviceId", "unitPrice") SELECT "amount", "discount", "id", "name", "quantity", "quotationId", "serviceId", "unitPrice" FROM "quotation_items";
DROP TABLE "quotation_items";
ALTER TABLE "new_quotation_items" RENAME TO "quotation_items";
CREATE TABLE "new_quotations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "validUntil" DATETIME,
    "createdById" TEXT,
    "sentAt" DATETIME,
    "decidedAt" DATETIME,
    "approvalStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvalRequestedAt" DATETIME,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "approvalNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "quotations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quotations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quotations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_quotations" ("branchId", "code", "createdAt", "createdById", "customerId", "decidedAt", "discount", "id", "note", "sentAt", "status", "subtotal", "total", "updatedAt", "validUntil") SELECT "branchId", "code", "createdAt", "createdById", "customerId", "decidedAt", "discount", "id", "note", "sentAt", "status", "subtotal", "total", "updatedAt", "validUntil" FROM "quotations";
DROP TABLE "quotations";
ALTER TABLE "new_quotations" RENAME TO "quotations";
CREATE UNIQUE INDEX "quotations_code_key" ON "quotations"("code");
CREATE INDEX "quotations_approvalStatus_idx" ON "quotations"("approvalStatus");
CREATE INDEX "quotations_customerId_idx" ON "quotations"("customerId");
CREATE TABLE "new_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT,
    "customerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "dueAt" DATETIME,
    "completedAt" DATETIME,
    "assigneeId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "source" TEXT,
    "procedureId" TEXT,
    "milestone" TEXT,
    "result" TEXT,
    "resultNote" TEXT,
    "contactedAt" DATETIME,
    "contactedById" TEXT,
    CONSTRAINT "tasks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_tasks" ("assigneeId", "branchId", "completedAt", "createdAt", "createdById", "customerId", "description", "dueAt", "id", "priority", "status", "title") SELECT "assigneeId", "branchId", "completedAt", "createdAt", "createdById", "customerId", "description", "dueAt", "id", "priority", "status", "title" FROM "tasks";
DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";
CREATE INDEX "tasks_assigneeId_status_idx" ON "tasks"("assigneeId", "status");
CREATE INDEX "tasks_dueAt_idx" ON "tasks"("dueAt");
CREATE INDEX "tasks_kind_status_dueAt_idx" ON "tasks"("kind", "status", "dueAt");
CREATE INDEX "tasks_customerId_idx" ON "tasks"("customerId");
CREATE INDEX "tasks_procedureId_idx" ON "tasks"("procedureId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "job_runs_jobKey_startedAt_idx" ON "job_runs"("jobKey", "startedAt");

-- CreateIndex
CREATE INDEX "job_runs_startedAt_idx" ON "job_runs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_marks_ruleKey_dedupeKey_key" ON "automation_marks"("ruleKey", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tags_conversationId_tagId_key" ON "conversation_tags"("conversationId", "tagId");

-- CreateIndex
CREATE INDEX "conversation_notes_conversationId_createdAt_idx" ON "conversation_notes"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "broadcasts_status_createdAt_idx" ON "broadcasts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "broadcast_recipients_broadcastId_status_idx" ON "broadcast_recipients"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "broadcast_recipients_status_sentAt_idx" ON "broadcast_recipients"("status", "sentAt");

-- CreateIndex
CREATE INDEX "broadcast_recipients_customerId_idx" ON "broadcast_recipients"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_active_startAt_endAt_idx" ON "promotions"("active", "startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_services_promotionId_serviceId_key" ON "promotion_services"("promotionId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_scripts_key_version_key" ON "sales_scripts"("key", "version");

-- CreateIndex
CREATE INDEX "ai_suggestions_conversationId_createdAt_idx" ON "ai_suggestions"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_suggestions_customerId_idx" ON "ai_suggestions"("customerId");

-- CreateIndex
CREATE INDEX "procedure_records_retreatDueAt_idx" ON "procedure_records"("retreatDueAt");


-- Dữ liệu cũ (trước Lô 4) không lưu giá niêm yết: lấy đơn giá đã bán làm giá
-- niêm yết và coi phần giảm tay là giảm ngoài ưu đãi, để báo cáo rò rỉ chiết
-- khấu vẫn thấy các khoản giảm cũ.
UPDATE "quotation_items" SET "listPrice" = "unitPrice", "discountAmount" = "discount" WHERE "listPrice" IS NULL;
UPDATE "contract_items" SET "listPrice" = "unitPrice", "discountAmount" = "discount" WHERE "listPrice" IS NULL;
