-- F35: giữ mã nhân viên Pancake trên từng tin, để gắn tài khoản CRM muộn vẫn
-- quy lại được số của các tin đã đồng bộ về trước đó.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "pancakeAgentUid" TEXT;

-- CreateIndex
CREATE INDEX "chat_messages_pancakeAgentUid_idx" ON "chat_messages"("pancakeAgentUid");
