import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { RoleCode } from "../src/lib/rbac-catalog";
import { revokeAllSessions } from "../src/lib/session";

/**
 * Tạo (hoặc cập nhật) một tài khoản quản trị cấp cao.
 *
 *   npx tsx scripts/create-admin.ts --email a@louva.vn --name "Xuân Trường"
 *
 * Tuỳ chọn:
 *   --roles GIAM_DOC,QUAN_LY_HE_THONG   mặc định: cả hai
 *   --password "..."                    mặc định: sinh ngẫu nhiên 20 ký tự
 *   --keep-password                     giữ mật khẩu cũ nếu tài khoản đã tồn tại
 *
 * Vì sao cần script này thay vì tạo trên giao diện: đây là lối vào khi chưa có
 * ai đăng nhập được (mất mật khẩu quản trị, dựng máy chủ mới). Tài khoản tạo ra
 * luôn bị đánh dấu PHẢI ĐỔI MẬT KHẨU ở lần đăng nhập đầu.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Mật khẩu tạm: đủ mạnh để dán qua kênh chat mà không lo dò. */
function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();

  if (!email || !name) {
    console.error('Thiếu tham số. Ví dụ:\n  npx tsx scripts/create-admin.ts --email ceo@louva.vn --name "Xuân Trường"');
    process.exit(1);
  }

  const roleCodes = (arg("roles") ?? `${RoleCode.GIAM_DOC},${RoleCode.QUAN_LY_HE_THONG}`)
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const roles = await prisma.role.findMany({ where: { code: { in: roleCodes } } });
  if (roles.length !== roleCodes.length) {
    const found = roles.map((r) => r.code);
    console.error(`Không tìm thấy vai trò: ${roleCodes.filter((c) => !found.includes(c)).join(", ")}`);
    process.exit(1);
  }

  const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
  if (!branches.length) {
    console.error("Chưa có cơ sở nào. Khởi động máy chủ một lần để bootstrap tạo cơ sở trước.");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  const password = arg("password") ?? generatePassword();
  const keepPassword = hasFlag("keep-password") && existing;

  const passwordData = keepPassword
    ? {}
    : { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null };

  const user = await prisma.$transaction(async (tx) => {
    const u = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { name, status: "ACTIVE", ...passwordData },
        })
      : await tx.user.create({ data: { email, name, ...(passwordData as { passwordHash: string }) } });

    // Gán lại vai trò và cơ sở cho khớp đúng yêu cầu lần chạy này.
    await tx.userRoleLink.deleteMany({ where: { userId: u.id } });
    await tx.userRoleLink.createMany({
      data: roles.map((r) => ({ userId: u.id, roleId: r.id })),
    });

    await tx.userBranch.deleteMany({ where: { userId: u.id } });
    await tx.userBranch.createMany({
      data: branches.map((b, i) => ({ userId: u.id, branchId: b.id, isPrimary: i === 0 })),
    });

    return u;
  });

  // Quyền vừa đổi thì mọi phiên cũ phải nạp lại — cùng nguyên tắc với màn
  // Phân quyền trên giao diện.
  if (existing) await revokeAllSessions(user.id, "Cập nhật vai trò qua script quản trị");

  console.log("=================================================");
  console.log(existing ? "ĐÃ CẬP NHẬT tài khoản quản trị:" : "ĐÃ TẠO tài khoản quản trị:");
  console.log(`  Họ tên:   ${user.name}`);
  console.log(`  Email:    ${user.email}`);
  if (!keepPassword) console.log(`  Mật khẩu: ${password}`);
  else console.log("  Mật khẩu: (giữ nguyên)");
  console.log(`  Vai trò:  ${roles.map((r) => r.name).join(" + ")}`);
  console.log(`  Cơ sở:    ${branches.map((b) => b.name).join(", ")}`);
  console.log("");
  console.log("  Hệ thống sẽ YÊU CẦU ĐỔI MẬT KHẨU ở lần đăng nhập đầu tiên.");
  console.log("=================================================");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
