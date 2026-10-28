-- AlterTable
ALTER TABLE "content_plans" ADD COLUMN "postUrlKey" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_work_report_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "tabId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "workDate" DATETIME,
    "dayKey" TEXT,
    "weekday" TEXT,
    "channel" TEXT,
    "taskName" TEXT,
    "progress" TEXT,
    "status" TEXT,
    "rating" TEXT,
    "linkText" TEXT,
    "linkUrl" TEXT,
    "linkUrlKey" TEXT,
    "contentPlanId" TEXT,
    "note" TEXT,
    "summary" TEXT,
    "dayCredit" REAL,
    "statusCode" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "ratingCode" TEXT,
    "isDayOff" BOOLEAN NOT NULL DEFAULT false,
    "raw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_report_entries_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "work_report_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "work_report_entries_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "work_report_tabs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "work_report_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "work_report_entries_contentPlanId_fkey" FOREIGN KEY ("contentPlanId") REFERENCES "content_plans" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_work_report_entries" ("branchId", "channel", "createdAt", "dayCredit", "dayKey", "id", "isDayOff", "linkText", "linkUrl", "month", "note", "progress", "rating", "ratingCode", "raw", "rowIndex", "sourceId", "status", "statusCode", "summary", "tabId", "taskName", "userId", "weekday", "workDate", "year") SELECT "branchId", "channel", "createdAt", "dayCredit", "dayKey", "id", "isDayOff", "linkText", "linkUrl", "month", "note", "progress", "rating", "ratingCode", "raw", "rowIndex", "sourceId", "status", "statusCode", "summary", "tabId", "taskName", "userId", "weekday", "workDate", "year" FROM "work_report_entries";
DROP TABLE "work_report_entries";
ALTER TABLE "new_work_report_entries" RENAME TO "work_report_entries";
CREATE INDEX "work_report_entries_userId_workDate_idx" ON "work_report_entries"("userId", "workDate");
CREATE INDEX "work_report_entries_sourceId_year_month_idx" ON "work_report_entries"("sourceId", "year", "month");
CREATE INDEX "work_report_entries_branchId_workDate_idx" ON "work_report_entries"("branchId", "workDate");
CREATE INDEX "work_report_entries_statusCode_idx" ON "work_report_entries"("statusCode");
CREATE INDEX "work_report_entries_contentPlanId_idx" ON "work_report_entries"("contentPlanId");
CREATE INDEX "work_report_entries_linkUrlKey_idx" ON "work_report_entries"("linkUrlKey");
CREATE UNIQUE INDEX "work_report_entries_tabId_rowIndex_key" ON "work_report_entries"("tabId", "rowIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "content_plans_postUrlKey_idx" ON "content_plans"("postUrlKey");
