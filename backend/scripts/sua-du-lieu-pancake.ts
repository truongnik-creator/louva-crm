import { prisma } from "../src/lib/prisma";
import { MessageDirection, MessageType } from "../src/types/enums";

/**
 * SỬA MỘT LẦN dữ liệu Pancake đã đồng bộ về SAI, trước khi có bộ lọc đính kèm
 * theo danh sách cho phép (classifyAttachments).
 *
 *   npx tsx scripts/sua-du-lieu-pancake.ts          xem trước, KHÔNG ghi gì
 *   npx tsx scripts/sua-du-lieu-pancake.ts --yes    sửa thật
 *
 * VÌ SAO CẦN SCRIPT RIÊNG: đồng bộ lại không chữa được. Luồng đồng bộ chống
 * trùng theo externalId của tin, nên tin đã về sẽ bị bỏ qua và giữ nguyên cái
 * sai. Đo trên máy chủ thật: 287 "tệp đính kèm" giả và 429 tin sai nội dung.
 *
 * BA VIỆC:
 *
 *   1. XOÁ ĐÍNH KÈM GIẢ. Pancake gói ad_click (khách bấm quảng cáo) và link
 *      (chia sẻ bài viết) vào cùng mảng `attachments`, kèm `url` trỏ
 *      facebook.com và `name` là NGUYÊN BÀI QUẢNG CÁO. Bản cũ lọc bằng "có url
 *      https" nên nhận hết, tạo ra tệp rác mang tên dài 200 ký tự.
 *      Dấu hiệu nhận: url trỏ facebook.com (media thật nằm ở
 *      content.pancake.vn hoặc *.fbcdn.net).
 *
 *   2. SỬA LOẠI TIN. Tin chỉ còn đính kèm ảnh thì là IMAGE, còn tệp thì FILE,
 *      không còn gì thì TEXT.
 *
 *   3. SỬA NỘI DUNG TIN. Tin không có chữ trước đây ghi "[Tệp đính kèm]" hoặc
 *      "[Nội dung không đọc được]"; sale mở hộp thư thấy một dãy như vậy thì
 *      phải mở Pancake ra mới biết khách gửi gì. Nay nói rõ: "[Hình ảnh]",
 *      "Khách nhắn từ quảng cáo"...
 *
 * CHỈ ĐỤNG hội thoại nguồn Pancake (có pancakePageId). Hộp thư Zalo không liên
 * quan. Chạy lại nhiều lần không sao: lần hai sẽ không tìm thấy gì để sửa.
 */

/** Đính kèm giả: url trỏ trang facebook thay vì trỏ tệp. */
const FAKE_URL = /^https:\/\/(www\.)?facebook\.com\//i;

const PLACEHOLDERS = ["[Tệp đính kèm]", "[Nội dung không đọc được]"];

async function main(): Promise<void> {
  const apply = process.argv.includes("--yes");
  const tag = apply ? "Đã" : "Sẽ";

  const pages = await prisma.pancakePage.findMany({ select: { id: true } });
  if (!pages.length) {
    console.log("Chưa có trang Pancake nào, không có gì để sửa.");
    return;
  }
  const convWhere = { pancakePageId: { in: pages.map((p) => p.id) } };

  // ---------------------------------------------------- 1. đính kèm giả
  const attachments = await prisma.messageAttachment.findMany({
    where: { message: { conversation: convWhere }, storageKey: null },
    select: { id: true, messageId: true, url: true, fileName: true },
  });
  const fake = attachments.filter((a) => a.url && FAKE_URL.test(a.url));
  // Tin từng mang đính kèm quảng cáo: dùng để đặt lại nội dung ở bước 3.
  const adMessageIds = new Set(fake.map((a) => a.messageId));

  console.log(`Đính kèm của hội thoại Pancake: ${attachments.length}, trong đó GIẢ: ${fake.length}`);
  for (const a of fake.slice(0, 3)) {
    console.log(`  ví dụ: ${a.url} | tên tệp: ${JSON.stringify(a.fileName.slice(0, 60))}…`);
  }
  if (apply && fake.length) {
    await prisma.messageAttachment.deleteMany({ where: { id: { in: fake.map((a) => a.id) } } });
  }
  console.log(`${tag} xoá ${fake.length} đính kèm giả.`);

  // ---------------------------------------------------- 2 + 3. loại và nội dung tin
  const messages = await prisma.chatMessage.findMany({
    where: { conversation: convWhere, externalId: { not: null } },
    select: {
      id: true,
      type: true,
      content: true,
      direction: true,
      attachments: { select: { id: true, kind: true } },
    },
  });

  let fixedType = 0;
  let fixedContent = 0;
  const samples: string[] = [];

  for (const m of messages) {
    // Đính kèm còn lại sau khi đã xoá (hoặc sẽ xoá) đồ giả.
    const left = m.attachments.filter((a) => !fake.some((f) => f.id === a.id));
    const hasImage = left.some((a) => a.kind === "IMAGE");
    const wantType = hasImage ? MessageType.IMAGE : left.length ? MessageType.FILE : MessageType.TEXT;

    let wantContent = m.content;
    if (PLACEHOLDERS.includes(m.content)) {
      wantContent = hasImage
        ? "[Hình ảnh]"
        : left.length
          ? "[Tệp đính kèm]"
          : adMessageIds.has(m.id)
            ? // Khách bấm quảng cáo rồi nhắn: Pancake gửi tin rỗng kèm ad_click.
              m.direction === MessageDirection.IN
              ? "Khách nhắn từ quảng cáo"
              : "Tin tự động trả lời quảng cáo"
            : "[Tin không có nội dung chữ]";
    }

    const changeType = wantType !== m.type;
    const changeContent = wantContent !== m.content;
    if (!changeType && !changeContent) continue;

    if (changeType) fixedType++;
    if (changeContent) fixedContent++;
    if (samples.length < 4 && changeContent) {
      samples.push(`  ${JSON.stringify(m.content)} -> ${JSON.stringify(wantContent)}`);
    }
    if (apply) {
      await prisma.chatMessage.update({
        where: { id: m.id },
        data: { ...(changeType ? { type: wantType } : {}), ...(changeContent ? { content: wantContent } : {}) },
      });
    }
  }

  console.log(`${tag} sửa loại cho ${fixedType} tin, sửa nội dung cho ${fixedContent} tin.`);
  for (const s of samples) console.log(s);

  if (!apply) console.log("\nChạy lại với --yes để ghi thật. Nên sao lưu trước: npm run backup");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
