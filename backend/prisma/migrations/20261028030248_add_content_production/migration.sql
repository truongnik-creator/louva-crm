-- CreateTable
CREATE TABLE "content_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT,
    "campaignId" TEXT,
    "channelId" TEXT,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'VIDEO',
    "brief" TEXT,
    "ownerId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'Y_TUONG',
    "plannedDate" DATETIME,
    "publishedAt" DATETIME,
    "postUrl" TEXT,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "content_plans_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_plans_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_plans_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_plans_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_plans_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_plans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "content_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "assigneeId" TEXT,
    "dueDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resultUrl" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "content_tasks_planId_fkey" FOREIGN KEY ("planId") REFERENCES "content_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "content_plans_branchId_stage_idx" ON "content_plans"("branchId", "stage");

-- CreateIndex
CREATE INDEX "content_plans_plannedDate_idx" ON "content_plans"("plannedDate");

-- CreateIndex
CREATE INDEX "content_plans_ownerId_stage_idx" ON "content_plans"("ownerId", "stage");

-- CreateIndex
CREATE INDEX "content_plans_campaignId_idx" ON "content_plans"("campaignId");

-- CreateIndex
CREATE INDEX "content_tasks_planId_idx" ON "content_tasks"("planId");

-- CreateIndex
CREATE INDEX "content_tasks_assigneeId_status_idx" ON "content_tasks"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "content_tasks_dueDate_idx" ON "content_tasks"("dueDate");
