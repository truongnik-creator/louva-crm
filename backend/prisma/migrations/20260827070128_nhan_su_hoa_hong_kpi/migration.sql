-- CreateTable
CREATE TABLE "attendances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT,
    "date" DATETIME NOT NULL,
    "checkInAt" DATETIME,
    "checkOutAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyMinutes" INTEGER NOT NULL DEFAULT 0,
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "attendances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attendances_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendances_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shift_assignments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'ANNUAL',
    "fromDate" DATETIME NOT NULL,
    "toDate" DATETIME NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "leave_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "leave_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leave_requests_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "commission_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'COLLECTED',
    "percent" INTEGER NOT NULL DEFAULT 0,
    "serviceId" TEXT,
    "minAmount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "commission_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "commission_rules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "ruleId" TEXT,
    "paymentId" TEXT,
    "contractId" TEXT,
    "periodKey" TEXT NOT NULL,
    "baseAmount" INTEGER NOT NULL DEFAULT 0,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "commission_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "commission_entries_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_entries_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "commission_rules" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "commission_entries_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "commission_entries_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "kpi_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'SALES',
    "unit" TEXT NOT NULL DEFAULT 'số',
    "higherIsBetter" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "kpi_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definitionId" TEXT NOT NULL,
    "userId" TEXT,
    "branchId" TEXT,
    "periodKey" TEXT NOT NULL,
    "targetValue" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kpi_targets_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "kpi_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kpi_targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kpi_targets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "kpi_actuals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definitionId" TEXT NOT NULL,
    "userId" TEXT,
    "branchId" TEXT,
    "periodKey" TEXT NOT NULL,
    "actualValue" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kpi_actuals_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "kpi_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kpi_actuals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kpi_actuals_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" DATETIME,
    "closedById" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payroll_periods_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payroll_periods_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payroll_lines" (
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
    CONSTRAINT "payroll_lines_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "payroll_periods" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payroll_lines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "attendances_branchId_date_idx" ON "attendances"("branchId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_userId_date_key" ON "attendances"("userId", "date");

-- CreateIndex
CREATE INDEX "leave_requests_userId_fromDate_idx" ON "leave_requests"("userId", "fromDate");

-- CreateIndex
CREATE INDEX "commission_entries_userId_periodKey_idx" ON "commission_entries"("userId", "periodKey");

-- CreateIndex
CREATE INDEX "commission_entries_branchId_periodKey_idx" ON "commission_entries"("branchId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_definitions_code_key" ON "kpi_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_targets_definitionId_userId_periodKey_key" ON "kpi_targets"("definitionId", "userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_actuals_definitionId_userId_periodKey_key" ON "kpi_actuals"("definitionId", "userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_branchId_periodKey_key" ON "payroll_periods"("branchId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_periodId_userId_key" ON "payroll_lines"("periodId", "userId");
