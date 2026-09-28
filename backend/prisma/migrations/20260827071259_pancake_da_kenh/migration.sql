-- CreateTable
CREATE TABLE "pancake_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT,
    "label" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" DATETIME,
    "lastSyncNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pancake_configs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pancake_pages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "branchId" TEXT,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'FACEBOOK',
    "channelId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pancake_pages_configId_fkey" FOREIGN KEY ("configId") REFERENCES "pancake_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "pancake_pages_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "pancake_pages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    CONSTRAINT "conversations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_oaConfigId_fkey" FOREIGN KEY ("oaConfigId") REFERENCES "zalo_oa_configs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conversations_pancakePageId_fkey" FOREIGN KEY ("pancakePageId") REFERENCES "pancake_pages" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conversations" ("assignedToId", "branchId", "channel", "createdAt", "customerId", "externalId", "id", "kind", "lastMessageAt", "lastMessagePreview", "memberCount", "oaConfigId", "title", "unreadCount", "updatedAt") SELECT "assignedToId", "branchId", "channel", "createdAt", "customerId", "externalId", "id", "kind", "lastMessageAt", "lastMessagePreview", "memberCount", "oaConfigId", "title", "unreadCount", "updatedAt" FROM "conversations";
DROP TABLE "conversations";
ALTER TABLE "new_conversations" RENAME TO "conversations";
CREATE UNIQUE INDEX "conversations_pancakeConversationId_key" ON "conversations"("pancakeConversationId");
CREATE INDEX "conversations_kind_lastMessageAt_idx" ON "conversations"("kind", "lastMessageAt");
CREATE INDEX "conversations_assignedToId_idx" ON "conversations"("assignedToId");
CREATE UNIQUE INDEX "conversations_externalId_oaConfigId_key" ON "conversations"("externalId", "oaConfigId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "pancake_pages_pageId_key" ON "pancake_pages"("pageId");
