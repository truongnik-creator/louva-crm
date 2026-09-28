-- CreateTable
CREATE TABLE "consultation_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "consultantId" TEXT,
    "doctorId" TEXT,
    "concernArea" TEXT,
    "expectation" TEXT,
    "budgetNote" TEXT,
    "readiness" TEXT,
    "recoveryNote" TEXT,
    "contraindicationNote" TEXT,
    "note" TEXT,
    "heldAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "consultation_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consultation_sessions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consultation_sessions_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "consultation_sessions_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "treatment_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "doctorId" TEXT,
    "title" TEXT NOT NULL,
    "method" TEXT,
    "expectedResult" TEXT,
    "riskNote" TEXT,
    "recoveryDays" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "treatment_plans_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "consultation_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "treatment_plans_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "treatment_plan_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    CONSTRAINT "treatment_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "treatment_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "treatment_plan_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "case_studies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT,
    "procedureId" TEXT,
    "serviceId" TEXT,
    "doctorId" TEXT,
    "title" TEXT NOT NULL,
    "anonymLabel" TEXT NOT NULL,
    "summary" TEXT,
    "beforeNote" TEXT,
    "afterNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "medicalApprovedById" TEXT,
    "medicalApprovedAt" DATETIME,
    "marketingApprovedById" TEXT,
    "marketingApprovedAt" DATETIME,
    "publishedAt" DATETIME,
    "withdrawnAt" DATETIME,
    "withdrawReason" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "case_studies_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "case_studies_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "case_studies_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedure_records" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "case_studies_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "case_studies_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "case_studies_medicalApprovedById_fkey" FOREIGN KEY ("medicalApprovedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "case_studies_marketingApprovedById_fkey" FOREIGN KEY ("marketingApprovedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "case_studies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "consent_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'SURGERY',
    "title" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "consultation_sessions_customerId_idx" ON "consultation_sessions"("customerId");

-- CreateIndex
CREATE INDEX "treatment_plans_customerId_idx" ON "treatment_plans"("customerId");

-- CreateIndex
CREATE INDEX "case_studies_branchId_status_idx" ON "case_studies"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consent_templates_code_key" ON "consent_templates"("code");
