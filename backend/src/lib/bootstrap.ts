import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { env, BACKEND_ROOT } from "./env";
import { ensureStorageDir } from "./storage";
import { PERMISSIONS, ROLES, RoleCode, WORK_REPORT_DEPARTMENTS, expandGrant } from "./rbac-catalog";
import { logger } from "./logger";
import { backupBeforeMigrate } from "./backup";
import { randomToken } from "./crypto";

const execFileAsync = promisify(execFile);

const SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
// We deliberately do NOT shell out to `npx prisma ...`. `npx` requires
// resolving `prisma` from PATH/registry, which isn't guaranteed in a packaged
// desktop app. Instead we invoke the prisma CLI's own JS entrypoint directly
// with `node`, using a path resolved from this file's location — this works
// identically in dev (tsx, from src/lib) and in a built app (from dist/lib).
const PRISMA_CLI_ENTRY = path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@louva.vn";
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, "prisma", "migrations");

const ADMIN_EMAIL_DEFAULT_PASSWORD = "admin123";

/**
 * Mật khẩu tài khoản quản trị đầu tiên. Máy phát triển giữ `admin123` cho
 * tiện; production (S1) không bao giờ dùng mật khẩu đoán được: không đặt
 * ADMIN_PASSWORD thì sinh ngẫu nhiên và in ra đúng một lần.
 */
function initialAdminPassword(): string {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  return env.isProduction ? randomToken(15) : ADMIN_EMAIL_DEFAULT_PASSWORD;
}

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

  // T1: có migration mới thì chụp CSDL trước khi áp. Migration SQLite hay
  // "dựng lại bảng" (tạo bảng mới, chép dữ liệu, xoá bảng cũ); hỏng giữa chừng
  // mà không có bản chụp là mất dữ liệu thật.
  await backupBeforeMigrate(MIGRATIONS_DIR);

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

  if (stdout?.trim()) logger.info({ out: stdout.trim() }, "prisma migrate deploy");
  if (stderr?.trim()) logger.warn({ out: stderr.trim() }, "prisma migrate deploy (stderr)");
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
            logger.warn(`[rbac] vai trò ${roleDef.code} tham chiếu quyền không tồn tại: ${code}`);
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
/**
 * F36: bốn bộ phận dùng cơ chế báo cáo công việc theo trang tính (Media, MKT,
 * Design, Content) phải tồn tại ở MỌI cơ sở.
 *
 * Chạy mỗi lần khởi động và chỉ TẠO MỚI khi thiếu — không sửa tên, không bật
 * lại bộ phận quản lý đã cố ý tắt. Nếu không bootstrap thì sau khi cập nhật mã
 * nguồn, quản lý phải tự vào Cài đặt tạo tay bốn bộ phận ở từng cơ sở mới gắn
 * được trang tính cho nhân viên.
 */
async function ensureWorkReportDepartments() {
  const branches = await prisma.branch.findMany({ select: { id: true } });
  for (const branch of branches) {
    for (const dept of WORK_REPORT_DEPARTMENTS) {
      await prisma.department.upsert({
        where: { branchId_code: { branchId: branch.id, code: dept.code } },
        create: { branchId: branch.id, code: dept.code, name: dept.name },
        update: {},
      });
    }
  }
}

async function ensureAdminAccount() {
  if ((await prisma.user.count()) > 0) return;

  const branches = await prisma.branch.findMany({ select: { id: true, code: true } });
  const adminRole = await prisma.role.findUnique({ where: { code: RoleCode.QUAN_LY_HE_THONG } });

  const password = initialAdminPassword();
  const user = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(password, 10),
      name: "Quản trị hệ thống",
      mustChangePassword: true,
      branches: {
        // Cơ sở đầu tiên là cơ sở chính của tài khoản quản trị.
        create: branches.map((b, i) => ({ branchId: b.id, isPrimary: i === 0 })),
      },
      ...(adminRole ? { roleLinks: { create: { roleId: adminRole.id } } } : {}),
    },
  });

  // In thẳng ra stdout (không qua logger JSON) để người cài đặt đọc được,
  // và vì mật khẩu không được lọt vào hệ thống gom log.
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    console.log("=================================================");
    console.log("Khởi động lần đầu: đã tạo tài khoản quản trị");
    console.log(`  email:    ${user.email}`);
    console.log(`  mật khẩu: ${password}`);
    console.log("Bắt buộc đổi mật khẩu ngay sau lần đăng nhập đầu tiên.");
    console.log("=================================================");
  }
}

/**
 * B17: điền cột SĐT/tên chuẩn hoá cho dữ liệu có từ trước migration. Chạy mỗi
 * lần khởi động nhưng chỉ đụng các dòng còn trống, nên sau lần đầu gần như
 * không tốn gì. Việc tính toán nằm ở middleware trong lib/prisma.ts.
 */
export async function backfillNormalizedColumns(): Promise<{ customers: number; leads: number }> {
  let customers = 0;
  let leads = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows: Array<{ id: string; name: string; phone: string | null; updatedAt: Date }> =
      await prisma.customer.findMany({
      where: {
        OR: [
          { phone: { not: null }, phoneNormalized: null },
          { nameNormalized: null },
        ],
      },
      select: { id: true, name: true, phone: true, updatedAt: true },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const r of rows) {
      // Giữ nguyên updatedAt: backfill không phải là "khách vừa được sửa".
      await prisma.customer.update({
        where: { id: r.id },
        data: { phone: r.phone, name: r.name, updatedAt: r.updatedAt },
      });
      customers++;
    }
    cursor = rows[rows.length - 1].id;
  }
  cursor = undefined;
  for (;;) {
    const rows: Array<{ id: string; phone: string | null; updatedAt: Date }> = await prisma.lead.findMany({
      where: { phone: { not: null }, phoneNormalized: null },
      select: { id: true, phone: true, updatedAt: true },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const r of rows) {
      await prisma.lead.update({ where: { id: r.id }, data: { phone: r.phone, updatedAt: r.updatedAt } });
      leads++;
    }
    cursor = rows[rows.length - 1].id;
  }
  if (customers || leads) logger.info({ customers, leads }, "Đã chuẩn hoá SĐT/tên cho dữ liệu cũ");
  return { customers, leads };
}

/**
 * Chuẩn bị CSDL. `skipMigrate` dành cho bộ test: migration đã áp một lần ở
 * tests/global-setup.ts, mỗi tệp test chỉ cần danh mục quyền + cơ sở.
 * `exitOnError: false` để test thấy lỗi thật thay vì tiến trình bị kill.
 */
export async function bootstrap(opts: { skipMigrate?: boolean; exitOnError?: boolean } = {}) {
  try {
    if (!opts.skipMigrate) await applyMigrations();
    ensureStorageDir();
    await ensureBranches();
    await syncRbacCatalog();
    await ensureWorkReportDepartments();
    await ensureAdminAccount();
    await backfillNormalizedColumns();
  } catch (err) {
    logger.fatal({ err }, "Bootstrap thất bại: không chuẩn bị được CSDL. Server sẽ không khởi động.");
    if (opts.exitOnError === false) throw err;
    process.exit(1);
  }
}
