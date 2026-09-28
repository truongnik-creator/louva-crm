import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import bcrypt from "bcrypt";
import { prisma } from "./prisma";
import { env, BACKEND_ROOT } from "./env";
import { ensureStorageDir } from "./storage";
import { PERMISSIONS, ROLES, RoleCode, expandGrant } from "./rbac-catalog";

const execFileAsync = promisify(execFile);

const SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
// We deliberately do NOT shell out to `npx prisma ...`. `npx` requires
// resolving `prisma` from PATH/registry, which isn't guaranteed in a packaged
// desktop app. Instead we invoke the prisma CLI's own JS entrypoint directly
// with `node`, using a path resolved from this file's location — this works
// identically in dev (tsx, from src/lib) and in a built app (from dist/lib).
const PRISMA_CLI_ENTRY = path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@louva.vn";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";

/**
 * Cơ sở khởi tạo. Hệ thống vẫn là ĐA CƠ SỞ (đó là xương sống của mô hình phân
 * quyền và cách ly bệnh án) — chỉ là khởi tạo sẵn một cơ sở. Mở thêm cơ sở ở
 * Cài đặt › Phòng & Thiết bị hoặc qua API `POST /api/org/branches`.
 *
 * Đặt tên phòng khám bằng biến môi trường CLINIC_NAME / CLINIC_CODE nếu muốn
 * đổi mà không phải sửa mã nguồn.
 */
const BRANCHES = [
  {
    code: process.env.CLINIC_CODE ?? "LOUVA",
    name: process.env.CLINIC_NAME ?? "Phòng khám Thẩm mỹ Louva",
    shortName: process.env.CLINIC_SHORT_NAME ?? "Louva",
  },
];

function sqliteFilePathFromUrl(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  const raw = url.slice("file:".length);
  return path.isAbsolute(raw) ? raw : path.resolve(BACKEND_ROOT, raw);
}

function ensureSqliteDirExists() {
  const filePath = sqliteFilePathFromUrl(env.databaseUrl);
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function applyMigrations() {
  ensureSqliteDirExists();

  if (!fs.existsSync(PRISMA_CLI_ENTRY)) {
    throw new Error(
      `Không tìm thấy Prisma CLI tại ${PRISMA_CLI_ENTRY}. Gói "prisma" phải là dependency runtime, không chỉ devDependency.`
    );
  }
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`Không tìm thấy schema Prisma tại ${SCHEMA_PATH}.`);
  }

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [PRISMA_CLI_ENTRY, "migrate", "deploy", "--schema", SCHEMA_PATH],
    { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: env.databaseUrl } }
  );

  if (stdout?.trim()) console.log(stdout.trim());
  if (stderr?.trim()) console.warn(stderr.trim());
}

/**
 * Đồng bộ danh mục quyền và vai trò từ mã nguồn xuống CSDL. Chạy mỗi lần khởi
 * động: thêm quyền mới, cập nhật tên, và cấp quyền còn thiếu cho vai trò hệ
 * thống — nhưng KHÔNG xoá quyền quản trị viên đã tự gán thêm cho vai trò.
 */
async function syncRbacCatalog() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      create: { code: p.code, module: p.module, action: p.action, name: p.name, isSpecial: p.isSpecial ?? false },
      update: { module: p.module, action: p.action, name: p.name, isSpecial: p.isSpecial ?? false },
    });
  }

  const permissionIdByCode = new Map(
    (await prisma.permission.findMany({ select: { id: true, code: true } })).map((p) => [p.code, p.id])
  );

  for (const roleDef of ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      create: { code: roleDef.code, name: roleDef.name, description: roleDef.description, isSystem: true },
      update: { name: roleDef.name, description: roleDef.description, isSystem: true },
    });

    for (const grant of roleDef.grants) {
      for (const item of grant.items) {
        for (const code of expandGrant(item)) {
          const permissionId = permissionIdByCode.get(code);
          if (!permissionId) {
            console.warn(`[rbac] vai trò ${roleDef.code} tham chiếu quyền không tồn tại: ${code}`);
            continue;
          }
          await prisma.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: role.id, permissionId } },
            create: { roleId: role.id, permissionId, scope: grant.scope },
            update: { scope: grant.scope },
          });
        }
      }
    }
  }
}

async function ensureBranches() {
  for (const b of BRANCHES) {
    await prisma.branch.upsert({
      where: { code: b.code },
      create: b,
      update: { name: b.name, shortName: b.shortName },
    });
  }
}

/**
 * Lần khởi động đầu: nếu chưa có người dùng nào, tạo tài khoản quản trị và gán
 * vai trò Quản trị hệ thống ở mọi cơ sở.
 */
async function ensureAdminAccount() {
  if ((await prisma.user.count()) > 0) return;

  const branches = await prisma.branch.findMany({ select: { id: true, code: true } });
  const adminRole = await prisma.role.findUnique({ where: { code: RoleCode.QUAN_LY_HE_THONG } });

  const user = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
      name: "Quản trị hệ thống",
      mustChangePassword: true,
      branches: {
        // Cơ sở đầu tiên là cơ sở chính của tài khoản quản trị.
        create: branches.map((b, i) => ({ branchId: b.id, isPrimary: i === 0 })),
      },
      ...(adminRole ? { roleLinks: { create: { roleId: adminRole.id } } } : {}),
    },
  });

  console.log("=================================================");
  console.log("Khởi động lần đầu — đã tạo tài khoản quản trị:");
  console.log(`  email:    ${user.email}`);
  console.log(`  mật khẩu: ${ADMIN_PASSWORD}`);
  console.log("Bắt buộc đổi mật khẩu ngay sau lần đăng nhập đầu tiên.");
  console.log("=================================================");
}

export async function bootstrap() {
  try {
    await applyMigrations();
    ensureStorageDir();
    await ensureBranches();
    await syncRbacCatalog();
    await ensureAdminAccount();
  } catch (err) {
    console.error("Bootstrap thất bại: không chuẩn bị được CSDL. Server sẽ không khởi động.");
    console.error(err);
    process.exit(1);
  }
}
