import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { registerJob, runJob } from "../src/lib/jobs";
import {
  RULE_KEYS,
  ruleAftercare,
  ruleMedicalKeyword,
  ruleNoShow,
  rulePriceDeviation,
  ruleRetreat,
  ruleStuckPhoto,
  ruleTomorrowReminder,
  ruleUnanswered,
} from "../src/lib/automation";
import { autoAssignConversation, noteInbound, noteOutbound } from "../src/lib/inbox-routing";
import { findMedicalKeywords, parseKeywords } from "../src/lib/medical-keywords";
import { milestoneDueAt } from "../src/lib/aftercare";
import { startOfVnDay } from "../src/lib/datetime";

// Lô 4: F8 bộ chạy tác vụ nền (khoá, nhật ký, bật tắt), F9 tám quy tắc (giờ giả),
// F10 chăm sóc sau điều trị, F14 lượng tiêm lẻ, F26 chia xoay vòng, F27 việc hôm nay.

const uid = () => crypto.randomBytes(4).toString("hex");
const DAY = 86_400_000;
const MIN = 60_000;
/** Giờ giả xa trong tương lai: dữ liệu của tệp test khác không lọt vào cửa sổ quy tắc. */
const T0 = new Date("2031-03-10T03:00:00Z"); // 10:00 giờ VN

let ctx: TestContext;
let manager: TestUser;
let sale: TestUser;
let doctor: TestUser;
let receptionist: TestUser;

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}

async function notificationsOf(userId: string, contains: string) {
  return prisma.notification.findMany({ where: { userId, title: { contains } } });
}

beforeAll(async () => {
  ctx = await setupTestContext("lo4auto");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  sale = await ctx.createUser("TELESALE");
  doctor = await ctx.createUser("BAC_SI");
  receptionist = await ctx.createUser("LE_TAN");
  await ctx.createUser("QUAN_LY_HE_THONG");
  await ctx.createUser("TU_VAN_VIEN");
  await setSetting("clinic.mode", "INJECTION");
});

describe("F8: bộ chạy tác vụ nền", () => {
  it("khoá: gọi chạy chồng thì lần sau bỏ qua, chỉ một JobRun; khoá CSDL của tiến trình khác cũng chặn", async () => {
    const key = `test-lock-${uid()}`;
    let release!: () => void;
    let calls = 0;
    registerJob({
      key,
      label: "Tác vụ thử khoá",
      intervalMs: 60_000,
      run: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return { created: 2, message: "xong" };
      },
    });
    const first = runJob(key);
    await new Promise((r) => setTimeout(r, 50));
    const second = await runJob(key);
    expect(second.status).toBe("SKIPPED_LOCKED");
    release();
    const done = await first;
    expect(done.status).toBe("SUCCESS");
    expect(calls).toBe(1);
    const runs = await prisma.jobRun.findMany({ where: { jobKey: key } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "SUCCESS", createdCount: 2, message: "xong" });

    // Tiến trình khác đang giữ khoá trong CSDL.
    await prisma.jobLock.update({ where: { key }, data: { owner: "may-khac:123", lockedUntil: new Date(Date.now() + 60_000) } });
    expect((await runJob(key)).status).toBe("SKIPPED_LOCKED");
    expect(calls).toBe(1);
    await prisma.jobLock.update({ where: { key }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await runJob(key)).status).toBe("SUCCESS");
    expect(calls).toBe(2);
  });

  it("lỗi trong tác vụ ghi FAILED; tắt quy tắc trong Cài đặt thì không chạy theo lịch", async () => {
    const key = `test-fail-${uid()}`;
    registerJob({ key, label: "Lỗi", intervalMs: 60_000, run: async () => { throw new Error("hỏng giữa chừng"); } });
    const out = await runJob(key);
    expect(out.status).toBe("FAILED");
    expect((await prisma.jobRun.findFirstOrThrow({ where: { jobKey: key } })).error).toContain("hỏng giữa chừng");

    await setSetting("automation.noShow.enabled", "false");
    expect((await runJob(RULE_KEYS.NO_SHOW, { now: T0 })).status).toBe("SKIPPED_DISABLED");
    await setSetting("automation.noShow.enabled", "true");
  });

  it("màn Nhật ký tác vụ: xem danh sách, chạy tay (chỉ quản trị hệ thống)", async () => {
    const list = await ctx.as("QUAN_LY_CO_SO").get("/api/automation/jobs");
    expect(list.status).toBe(200);
    expect(list.body.jobs.map((j: { key: string }) => j.key)).toEqual(expect.arrayContaining(Object.values(RULE_KEYS)));
    const denied = await ctx.as("QUAN_LY_CO_SO").post(`/api/automation/jobs/${RULE_KEYS.RETREAT}/run`);
    expect(denied.status).toBe(403);
    const ran = await ctx.as("QUAN_LY_HE_THONG").post(`/api/automation/jobs/${RULE_KEYS.RETREAT}/run`);
    expect(ran.status).toBe(200);
    expect(ran.body.status).toBe("SUCCESS");
    const runs = await ctx.as("QUAN_LY_HE_THONG").get("/api/automation/runs").query({ jobKey: RULE_KEYS.RETREAT });
    expect(runs.body.items[0].trigger).toBe("MANUAL");
  });
});

describe("F9: tám quy tắc tự động (giờ giả)", () => {
  it("1. khách chờ quá N phút: báo quản lý và người phụ trách, chạy lại không báo trùng", async () => {
    const conv = await prisma.conversation.create({
      data: { title: `Khách chờ ${uid()}`, kind: "CUSTOMER", channel: "FACEBOOK", branchId: ctx.branchId, assignedToId: sale.id },
    });
    await noteInbound(conv.id, new Date(T0.getTime() - 20 * MIN));
    await noteInbound(conv.id, new Date(T0.getTime() - 5 * MIN)); // tin thứ hai không dời mốc chờ
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).waitingSince).toEqual(new Date(T0.getTime() - 20 * MIN));
    await ruleUnanswered(T0);
    await ruleUnanswered(T0);
    expect(await notificationsOf(manager.id, conv.title)).toHaveLength(1);
    expect(await notificationsOf(sale.id, conv.title)).toHaveLength(1);

    // Trả lời rồi thì hết chờ.
    await noteOutbound(conv.id, T0);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).waitingSince).toBeNull();
  });

  it("2. từ khoá y khoa: gắn cờ hội thoại, báo bác sĩ cơ sở; so cả cụm từ", async () => {
    expect(findMedicalKeywords("Chị bị SƯNG và đau quá", parseKeywords("đau,sưng,thai"))).toEqual(["đau", "sưng"]);
    expect(findMedicalKeywords("Em ở đâu vậy, đi Thailand", parseKeywords("đau,thai"))).toEqual([]);
    const conv = await prisma.conversation.create({
      data: { title: `Khách sưng ${uid()}`, kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId },
    });
    await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "IN", content: "Em tiêm hôm qua giờ bị sưng với bầm ạ", createdAt: new Date(T0.getTime() - 30 * MIN) },
    });
    await ruleMedicalKeyword(T0);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).medicalFlag).toBe(true);
    const n = await notificationsOf(doctor.id, conv.title);
    expect(n).toHaveLength(1);
    expect(n[0].level).toBe("DANGER");
  });

  it("3. báo giá giảm ngoài ưu đãi: cảnh báo quản lý", async () => {
    const c = await ctx.createCustomer({ name: `Khách báo giá ${uid()}`, phone: uniquePhone() });
    const svc = await prisma.service.create({ data: { code: `R3${uid()}`.toUpperCase(), name: "Meso thử" } });
    await prisma.servicePrice.create({ data: { serviceId: svc.id, branchId: ctx.branchId, price: 3_000_000 } });
    const q = await ctx.as("QUAN_LY_CO_SO").post("/api/sales/quotations").send({
      customerId: c.id,
      items: [{ serviceId: svc.id, name: "Meso thử", quantity: 1, unitPrice: 3_000_000, discount: 300_000, discountReason: "Khách quen" }],
    });
    expect(q.status).toBe(201);
    await rulePriceDeviation(new Date());
    expect(await notificationsOf(manager.id, q.body.code)).toHaveLength(1);
  });

  it("4. kẹt ở bước Có ảnh quá N ngày: việc chăm lại cho sale", async () => {
    const c = await ctx.createCustomer({ name: `Khách có ảnh ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "CO_ANH", stageChangedAt: new Date(T0.getTime() - 4 * DAY) } });
    await ruleStuckPhoto(T0);
    await ruleStuckPhoto(T0);
    const tasks = await prisma.task.findMany({ where: { customerId: c.id, kind: "CARE_AGAIN" } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigneeId).toBe(sale.id);
  });

  it("5. lịch ngày mai: tin nhắc, việc nhắc cọc cho lịch chưa cọc, thông báo lễ tân", async () => {
    const c = await ctx.createCustomer({ name: `Khách mai ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const tomorrow10h = new Date(startOfVnDay(T0).getTime() + DAY + 10 * 3_600_000);
    const appt = await prisma.appointment.create({
      data: {
        branchId: ctx.branchId,
        customerId: c.id,
        title: "Filler môi",
        startAt: tomorrow10h,
        endAt: new Date(tomorrow10h.getTime() + 30 * MIN),
        depositAmount: 500_000,
        depositStatus: "CHO_COC",
      },
    });
    await ruleTomorrowReminder(T0);
    await ruleTomorrowReminder(T0);
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: appt.id } })).toBe(1);
    const dep = await prisma.task.findMany({ where: { customerId: c.id, kind: "DEPOSIT_REMINDER" } });
    expect(dep).toHaveLength(1);
    expect(dep[0].assigneeId).toBe(sale.id);
    const n = await prisma.notification.findMany({ where: { userId: receptionist.id, title: { contains: "Ngày mai" } } });
    expect(n.length).toBe(1);
    expect(n[0].link).toContain("/lich-hen?date=2031-03-11");
  });

  it("6. quá giờ hẹn 30 phút chưa check-in: việc gọi lại; đã check-in thì không", async () => {
    const c = await ctx.createCustomer({ name: `Khách trễ ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const late = await prisma.appointment.create({
      data: { branchId: ctx.branchId, customerId: c.id, title: "Botox", startAt: new Date(T0.getTime() - 45 * MIN), endAt: T0 },
    });
    const c2 = await ctx.createCustomer({ name: `Khách đến ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const came = await prisma.appointment.create({
      data: { branchId: ctx.branchId, customerId: c2.id, title: "Botox", startAt: new Date(T0.getTime() - 45 * MIN), endAt: T0 },
    });
    await prisma.visit.create({ data: { branchId: ctx.branchId, customerId: c2.id, appointmentId: came.id, queueNumber: 1 } });
    const early = await prisma.appointment.create({
      data: { branchId: ctx.branchId, customerId: c2.id, title: "Meso", startAt: new Date(T0.getTime() - 10 * MIN), endAt: T0 },
    });
    await ruleNoShow(T0);
    const t = await prisma.task.findMany({ where: { customerId: c.id, kind: "CALLBACK" } });
    expect(t).toHaveLength(1);
    expect(t[0].priority).toBe("URGENT");
    expect(await prisma.task.count({ where: { customerId: c2.id, kind: "CALLBACK" } })).toBe(0);
    expect(late.id && early.id).toBeTruthy();
  });

  it("7 + F10: hoàn tất lần thực hiện sinh việc chăm sóc D0..D30 và mốc tái tiêm theo dịch vụ", async () => {
    const c = await ctx.createCustomer({ name: `Khách filler ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const svc = await prisma.service.create({ data: { code: `FIL${uid()}`.toUpperCase(), name: "Filler môi", kind: "INJECTION", retreatDays: 180 } });
    const proc = await prisma.procedureRecord.create({
      data: { code: `PM-L4-${uid()}`, branchId: ctx.branchId, customerId: c.id, serviceId: svc.id, title: "Tiêm filler môi", scheduledAt: new Date() },
    });
    const res = await ctx.as(doctor).post(`/api/procedures/${proc.id}/status`).send({ status: "COMPLETED", report: "Tiêm 1cc môi" });
    expect(res.status).toBe(200);
    const tasks = await prisma.task.findMany({ where: { procedureId: proc.id, kind: "AFTERCARE" }, orderBy: { dueAt: "asc" } });
    expect(tasks.map((t) => t.milestone)).toEqual(["D0", "D1", "D3", "D7", "D14", "D30"]);
    expect(tasks.every((t) => t.assigneeId === sale.id)).toBe(true);
    const saved = await prisma.procedureRecord.findUniqueOrThrow({ where: { id: proc.id } });
    expect(saved.retreatDueAt!.getTime() - saved.finishedAt!.getTime()).toBe(180 * DAY);
    // D3 = 17:00 giờ VN ngày làm + 3.
    expect(tasks[2].dueAt!.toISOString()).toBe(milestoneDueAt(saved.finishedAt!, 3).toISOString());
    // Phòng khám tiêm không sinh lịch tái khám cắt chỉ.
    expect(await prisma.appointment.count({ where: { customerId: c.id, type: "FOLLOW_UP" } })).toBe(0);
    // Chạy quét bù không sinh trùng.
    await ruleAftercare(new Date());
    expect(await prisma.task.count({ where: { procedureId: proc.id, kind: "AFTERCARE" } })).toBe(6);

    // Bác sĩ chỉnh số ngày tái tiêm của riêng lần này.
    const patch = await ctx.as(doctor).patch(`/api/aftercare/procedures/${proc.id}/retreat`).send({ retreatDays: 150 });
    expect(patch.status).toBe(200);
    const again = await prisma.procedureRecord.findUniqueOrThrow({ where: { id: proc.id } });
    expect(again.retreatDueAt!.getTime() - again.finishedAt!.getTime()).toBe(150 * DAY);
  });

  it("7 (quét bù): lần thực hiện hoàn tất lúc quy tắc tắt vẫn được sinh việc khi quét", async () => {
    const c = await ctx.createCustomer({ name: `Khách quét bù ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const proc = await prisma.procedureRecord.create({
      data: {
        code: `PM-L4-${uid()}`, branchId: ctx.branchId, customerId: c.id, title: "Meso", status: "COMPLETED",
        scheduledAt: new Date(T0.getTime() - DAY), finishedAt: new Date(T0.getTime() - 2 * 3_600_000),
      },
    });
    await ruleAftercare(T0);
    expect(await prisma.task.count({ where: { procedureId: proc.id } })).toBe(6);
  });

  it("8. đến mốc tái tiêm: việc cơ hội bán cho sale + thông báo, không trùng", async () => {
    const name = `Khách tái tiêm ${uid()}`;
    const c = await ctx.createCustomer({ name, phone: uniquePhone(), assignedToId: sale.id });
    const proc = await prisma.procedureRecord.create({
      data: {
        code: `PM-L4-${uid()}`, branchId: ctx.branchId, customerId: c.id, title: "Botox gọn hàm", status: "COMPLETED",
        scheduledAt: new Date(T0.getTime() - 120 * DAY), finishedAt: new Date(T0.getTime() - 117 * DAY),
        retreatDueAt: new Date(T0.getTime() + 3 * DAY),
      },
    });
    await ruleRetreat(T0);
    await ruleRetreat(T0);
    const t = await prisma.task.findMany({ where: { procedureId: proc.id, kind: "RETREAT" } });
    expect(t).toHaveLength(1);
    expect(t[0].assigneeId).toBe(sale.id);
    expect(t[0].dueAt).toEqual(new Date(T0.getTime() + 3 * DAY));
    expect(await notificationsOf(sale.id, `Cơ hội tái tiêm: ${name}`)).toHaveLength(1);
  });
});

describe("F10: màn Chăm sóc sau điều trị", () => {
  it("lọc phía máy chủ, Đã liên hệ ghi kết quả; khách có vấn đề thì báo bác sĩ; không nghe máy thì dời hạn", async () => {
    const c = await ctx.createCustomer({ name: `Khách chăm ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const past = new Date(Date.now() - 5 * DAY);
    const [overdue, today, later] = await Promise.all(
      [past, new Date(Date.now() - 3_600_000), new Date(Date.now() + 5 * DAY)].map((dueAt, i) =>
        prisma.task.create({
          data: { branchId: ctx.branchId, customerId: c.id, title: `Chăm sóc ${i}`, kind: "AFTERCARE", milestone: `D${i}`, assigneeId: sale.id, dueAt },
        })
      )
    );
    const due = await ctx.as("TELESALE").get("/api/aftercare").query({ view: "due", mine: "1" });
    expect(due.status).toBe(200);
    const ids = due.body.items.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining([overdue.id, today.id]));
    expect(ids).not.toContain(later.id);
    expect(due.body.items.find((t: { id: string }) => t.id === overdue.id).overdue).toBe(true);
    expect(due.body.items.find((t: { id: string }) => t.id === today.id).overdue).toBe(false);
    expect(due.body.items[0].customer.phone).toBeTruthy();

    const noAnswer = await ctx.as("TELESALE").post(`/api/aftercare/${today.id}/contact`).send({ result: "NO_ANSWER" });
    expect(noAnswer.status).toBe(200);
    expect(noAnswer.body.status).toBe("OPEN");
    expect(new Date(noAnswer.body.dueAt).getTime()).toBeGreaterThan(Date.now());

    const issue = await ctx.as("TELESALE").post(`/api/aftercare/${overdue.id}/contact`).send({ result: "REACHED_ISSUE", note: "Khách báo hơi sưng" });
    expect(issue.body.status).toBe("DONE");
    expect(issue.body.result).toBe("REACHED_ISSUE");
    expect((await prisma.notification.findMany({ where: { userId: doctor.id, body: "Khách báo hơi sưng" } })).length).toBe(1);
    const again = await ctx.as("TELESALE").post(`/api/aftercare/${overdue.id}/contact`).send({ result: "REACHED_OK" });
    expect(again.status).toBe(409);

    // Người khác (không được giao, không có quyền followup.update cả cơ sở) không bấm được.
    const other = await ctx.createUser("TELESALE", { key: `sale2-${uid()}` });
    expect((await ctx.as(other).post(`/api/aftercare/${later.id}/contact`).send({ result: "REACHED_OK" })).status).toBe(404);
  });
});

describe("F27: Việc của tôi hôm nay", () => {
  it("chỉ việc tới hạn hôm nay (kể cả quá hạn) và số trên huy hiệu", async () => {
    const me = await ctx.createUser("TELESALE", { key: `mytask-${uid()}` });
    await prisma.task.createMany({
      data: [
        { title: "Quá hạn", assigneeId: me.id, dueAt: new Date(Date.now() - DAY), kind: "CALLBACK" },
        { title: "Hôm nay", assigneeId: me.id, dueAt: new Date(Date.now() + 60_000), kind: "DEPOSIT_REMINDER" },
        { title: "Tuần sau", assigneeId: me.id, dueAt: new Date(Date.now() + 7 * DAY), kind: "AFTERCARE" },
        { title: "Xong rồi", assigneeId: me.id, dueAt: new Date(), status: "DONE" },
      ],
    });
    const today = await ctx.as(me).get("/api/customers/tasks/mine").query({ today: "1" });
    const titles = today.body.map((t: { title: string }) => t.title);
    // "Hôm nay" có hạn sau 1 phút: nếu test chạy sát 0h giờ VN có thể sang ngày mai.
    expect(titles).toContain("Quá hạn");
    expect(titles).not.toContain("Tuần sau");
    expect(titles).not.toContain("Xong rồi");
    const count = await ctx.as(me).get("/api/customers/tasks/mine/count");
    expect(count.body.overdue).toBe(1);
    expect(count.body.today).toBe(titles.length);
  });
});

describe("F26: chia hội thoại xoay vòng theo ca", () => {
  it("chỉ chia cho sale có ca hôm nay ở cơ sở của hội thoại, lần lượt từng người", async () => {
    const code = `RR_${uid()}`.toUpperCase();
    const branch = await prisma.branch.create({ data: { code, name: `Cơ sở ${code}` } });
    const mk = async (role: "TELESALE" | "TU_VAN_VIEN", key: string) => {
      const u = await ctx.createUser(role, { key: `${key}-${uid()}` });
      await prisma.userBranch.create({ data: { userId: u.id, branchId: branch.id } });
      return u;
    };
    const a = await mk("TELESALE", "rr-a");
    const b = await mk("TU_VAN_VIEN", "rr-b");
    const offShift = await mk("TELESALE", "rr-off");
    const now = new Date();
    const date = new Date(startOfVnDay(now).getTime() + 7 * 3_600_000); // 00:00Z = 07:00 VN cùng ngày
    for (const u of [a, b]) await prisma.shiftAssignment.create({ data: { branchId: branch.id, userId: u.id, date } });
    const convs = [];
    for (let i = 0; i < 4; i++) {
      convs.push(await prisma.conversation.create({ data: { title: `RR ${i}`, kind: "CUSTOMER", channel: "FACEBOOK", branchId: branch.id } }));
    }
    const got = [];
    for (const c of convs) got.push(await autoAssignConversation(c.id, now));
    expect(got).not.toContain(offShift.id);
    expect(new Set(got)).toEqual(new Set([a.id, b.id]));
    expect(got[0]).not.toBe(got[1]);
    expect(got[0]).toBe(got[2]);
    expect(got[1]).toBe(got[3]);
    // Đã có người phụ trách thì không chia lại.
    expect(await autoAssignConversation(convs[0].id, now)).toBeNull();

    // Bộ lọc hộp thư: chưa phân công, theo kênh, của tôi.
    const un = await prisma.conversation.create({ data: { title: `RR tự do ${uid()}`, kind: "CUSTOMER", channel: "TIKTOK", branchId: ctx.branchId } });
    const list = await ctx.as("QUAN_LY_CO_SO").get("/api/conversations").query({ unassigned: "1", channel: "TIKTOK", limit: 300 });
    const found = list.body.find((c: { id: string }) => c.id === un.id);
    expect(found.channelGroup).toBe("TIKTOK");
    expect(list.body.every((c: { assignedToId: string | null; channelGroup: string }) => !c.assignedToId && c.channelGroup === "TIKTOK")).toBe(true);
  });

  it("nhãn và ghi chú nội bộ ở cột 3", async () => {
    const conv = await prisma.conversation.create({ data: { title: `Nhãn ${uid()}`, kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId } });
    const tag = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/tags`).send({ name: `Khách VIP ${uid()}` });
    expect(tag.status).toBe(201);
    const note = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/notes`).send({ content: "Khách ngại tiêm, cần gửi ảnh case" });
    expect(note.status).toBe(201);
    const got = await ctx.as("QUAN_LY_CO_SO").get(`/api/conversations/${conv.id}/notes`);
    expect(got.body.tags[0].id).toBe(tag.body.id);
    expect(got.body.notes[0].content).toContain("ngại tiêm");
  });
});

describe("F14: lần thực hiện dịch vụ tiêm, vật tư dùng lẻ", () => {
  it("lượng tiêm lưu theo 0,1cc, điều dưỡng, vùng tiêm; lẻ hơn 0,1cc bị từ chối", async () => {
    const c = await ctx.createCustomer({ name: `Khách tiêm ${uid()}`, phone: uniquePhone() });
    const nurse = await ctx.createUser("DIEU_DUONG", { key: `nurse-${uid()}` });
    const proc = await prisma.procedureRecord.create({
      data: { code: `PM-L4-${uid()}`, branchId: ctx.branchId, customerId: c.id, title: "Filler", scheduledAt: new Date() },
    });
    const ok = await ctx
      .as("QUAN_LY_CO_SO")
      .patch(`/api/procedures/${proc.id}`)
      .send({ volumeCc: 1.5, injectionArea: "Môi trên", nurseId: nurse.id });
    expect(ok.status).toBe(200);
    const saved = await prisma.procedureRecord.findUniqueOrThrow({ where: { id: proc.id } });
    expect(saved.volumeTenthCc).toBe(15);
    expect(saved.injectionArea).toBe("Môi trên");
    expect(saved.nurseId).toBe(nurse.id);
    const bad = await ctx.as("QUAN_LY_CO_SO").patch(`/api/procedures/${proc.id}`).send({ volumeCc: 1.55 });
    expect(bad.status).toBe(400);
  });

  it("xuất dùng 0,5 ống: lưu 5 phần mười, trừ kho 1 ống đã mở, giá vốn theo lượng dùng thật", async () => {
    const c = await ctx.createCustomer({ name: `Khách vật tư ${uid()}`, phone: uniquePhone() });
    const wh = await prisma.warehouse.create({ data: { branchId: ctx.branchId, code: `K${uid()}`, name: "Kho thử" } });
    const product = await prisma.product.create({ data: { code: `SP${uid()}`, name: "Filler 1cc", unit: "ống" } });
    const lot = await prisma.stockLot.create({
      data: { productId: product.id, warehouseId: wh.id, lotNumber: `L${uid()}`, quantity: 3, unitCost: 1_200_000 },
    });
    const res = await ctx.as("QUAN_LY_CO_SO").post("/api/inventory/use").send({ lotId: lot.id, customerId: c.id, quantity: 0.5 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ quantity: 1, quantityTenths: 5, costAtUse: 600_000 });
    expect((await prisma.stockLot.findUniqueOrThrow({ where: { id: lot.id } })).quantity).toBe(2);
    const bad = await ctx.as("QUAN_LY_CO_SO").post("/api/inventory/use").send({ lotId: lot.id, customerId: c.id, quantity: 0.25 });
    expect(bad.status).toBe(400);
  });
});
