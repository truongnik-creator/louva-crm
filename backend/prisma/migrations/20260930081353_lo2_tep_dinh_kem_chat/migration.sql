-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_message_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER,
    "storageKey" TEXT,
    "encIv" TEXT,
    "encTag" TEXT,
    "url" TEXT,
    "savedPhotoSetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_message_attachments" ("createdAt", "fileName", "id", "kind", "messageId", "mimeType", "size", "storageKey") SELECT "createdAt", "fileName", "id", "kind", "messageId", "mimeType", "size", "storageKey" FROM "message_attachments";
DROP TABLE "message_attachments";
ALTER TABLE "new_message_attachments" RENAME TO "message_attachments";
CREATE INDEX "message_attachments_messageId_idx" ON "message_attachments"("messageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
