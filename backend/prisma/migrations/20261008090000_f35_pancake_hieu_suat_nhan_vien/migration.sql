-- F35: báo cáo hiệu suất nhân viên trên Pancake.
-- Token theo trang + mốc kéo thống kê.

-- AlterTable
ALTER TABLE "pancake_pages" ADD COLUMN "pageAccessTokenEnc" TEXT;
ALTER TABLE "pancake_pages" ADD COLUMN "statsSyncAt" DATETIME;

-- CreateTable
CREATE TABLE "pancake_agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "pancakeUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fbId" TEXT,
    "userId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pancake_agents_configId_fkey" FOREIGN KEY ("configId") REFERENCES "pancake_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "pancake_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "pancake_agents_configId_pancakeUserId_key" ON "pancake_agents"("configId", "pancakeUserId");
CREATE INDEX "pancake_agents_userId_idx" ON "pancake_agents"("userId");

-- CreateTable
CREATE TABLE "pancake_agent_stats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pageId" TEXT NOT NULL,
    "pancakeUserId" TEXT NOT NULL,
    "hour" DATETIME NOT NULL,
    "dayKey" TEXT NOT NULL,
    "inboxCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueInboxCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueCommentCount" INTEGER NOT NULL DEFAULT 0,
    "privateReplyCount" INTEGER NOT NULL DEFAULT 0,
    "phoneNumberCount" INTEGER NOT NULL DEFAULT 0,
    "avgResponseSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pancake_agent_stats_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pancake_pages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "pancake_agent_stats_pageId_pancakeUserId_hour_key" ON "pancake_agent_stats"("pageId", "pancakeUserId", "hour");
CREATE INDEX "pancake_agent_stats_dayKey_idx" ON "pancake_agent_stats"("dayKey");
CREATE INDEX "pancake_agent_stats_pancakeUserId_dayKey_idx" ON "pancake_agent_stats"("pancakeUserId", "dayKey");
