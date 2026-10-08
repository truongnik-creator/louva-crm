-- AlterTable
ALTER TABLE "customers" ADD COLUMN "mergedIntoId" TEXT;
ALTER TABLE "customers" ADD COLUMN "nameNormalized" TEXT;
ALTER TABLE "customers" ADD COLUMN "phoneNormalized" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "phoneNormalized" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "title" TEXT,
    "avatarColor" TEXT,
    "departmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "lastLoginAt" DATETIME,
    "resignedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_users" ("avatarColor", "createdAt", "departmentId", "email", "id", "lastLoginAt", "mustChangePassword", "name", "passwordHash", "phone", "resignedAt", "status", "title", "updatedAt") SELECT "avatarColor", "createdAt", "departmentId", "email", "id", "lastLoginAt", "mustChangePassword", "name", "passwordHash", "phone", "resignedAt", "status", "title", "updatedAt" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_status_idx" ON "users"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "chat_messages_createdAt_idx" ON "chat_messages"("createdAt");

-- CreateIndex
CREATE INDEX "conversations_branchId_idx" ON "conversations"("branchId");

-- CreateIndex
CREATE INDEX "conversations_customerId_idx" ON "conversations"("customerId");

-- CreateIndex
CREATE INDEX "conversations_channel_idx" ON "conversations"("channel");

-- CreateIndex
CREATE INDEX "customer_branch_links_branchId_idx" ON "customer_branch_links"("branchId");

-- CreateIndex
CREATE INDEX "customers_phoneNormalized_idx" ON "customers"("phoneNormalized");

-- CreateIndex
CREATE INDEX "customers_nameNormalized_idx" ON "customers"("nameNormalized");

-- CreateIndex
CREATE INDEX "customers_createdAt_idx" ON "customers"("createdAt");

-- CreateIndex
CREATE INDEX "customers_lastContactAt_idx" ON "customers"("lastContactAt");

-- CreateIndex
CREATE INDEX "leads_phone_idx" ON "leads"("phone");

-- CreateIndex
CREATE INDEX "leads_phoneNormalized_idx" ON "leads"("phoneNormalized");

-- CreateIndex
CREATE INDEX "leads_branchId_idx" ON "leads"("branchId");
