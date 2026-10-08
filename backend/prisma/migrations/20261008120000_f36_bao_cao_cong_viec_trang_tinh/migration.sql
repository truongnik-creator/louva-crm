-- F36: báo cáo công việc hàng ngày lấy từ trang tính Google của từng nhân viên.
--
-- Mỗi nhân viên một trang tính, 12 sheet "T1".."T12" = 12 tháng. Apps Script
-- trong trang tính đẩy dòng việc về /api/work-reports/ingest bằng token riêng
-- (trang tính ẨN vẫn chạy được); backend chỉ kéo trực tiếp khi link công khai.

-- CreateTable
CREATE TABLE "work_report_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "branchId" TEXT,
    "spreadsheetId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "year" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "syncMode" TEXT NOT NULL DEFAULT 'PUSH',
    "tokenHash" TEXT,
    "tokenPrefix" TEXT,
    "tokenCreatedAt" DATETIME,
    "tokenLastUsedAt" DATETIME,
    "lastSyncStatus" TEXT NOT NULL DEFAULT 'NEVER',
    "lastSyncAt" DATETIME,
    "lastSyncError" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "lastEntryDate" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "work_report_sources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "work_report_sources_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "work_report_tabs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "gid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "month" INTEGER,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "headerRows" INTEGER NOT NULL DEFAULT 2,
    "lastSyncAt" DATETIME,
    CONSTRAINT "work_report_tabs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "work_report_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "work_report_entries" (
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
    CONSTRAINT "work_report_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "work_report_sources_userId_key" ON "work_report_sources"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "work_report_sources_spreadsheetId_key" ON "work_report_sources"("spreadsheetId");

-- CreateIndex
CREATE UNIQUE INDEX "work_report_sources_tokenHash_key" ON "work_report_sources"("tokenHash");

-- CreateIndex
CREATE INDEX "work_report_sources_branchId_active_idx" ON "work_report_sources"("branchId", "active");

-- CreateIndex
CREATE INDEX "work_report_sources_lastSyncStatus_idx" ON "work_report_sources"("lastSyncStatus");

-- CreateIndex
CREATE INDEX "work_report_tabs_sourceId_month_idx" ON "work_report_tabs"("sourceId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "work_report_tabs_sourceId_gid_key" ON "work_report_tabs"("sourceId", "gid");

-- CreateIndex
CREATE INDEX "work_report_entries_userId_workDate_idx" ON "work_report_entries"("userId", "workDate");

-- CreateIndex
CREATE INDEX "work_report_entries_sourceId_year_month_idx" ON "work_report_entries"("sourceId", "year", "month");

-- CreateIndex
CREATE INDEX "work_report_entries_branchId_workDate_idx" ON "work_report_entries"("branchId", "workDate");

-- CreateIndex
CREATE INDEX "work_report_entries_statusCode_idx" ON "work_report_entries"("statusCode");

-- CreateIndex
CREATE UNIQUE INDEX "work_report_entries_tabId_rowIndex_key" ON "work_report_entries"("tabId", "rowIndex");

