/**
 * Khôi phục từ một bản sao lưu do scripts/backup.ts tạo (T1).
 *
 *   cd backend && npx tsx scripts/restore.ts --from backups/louva-hang-ngay-20260930-020000 --yes
 *
 * BẮT BUỘC TẮT SERVER TRƯỚC KHI CHẠY. Script:
 *   1. chụp CSDL hiện tại thành crm.db.truoc-khoi-phuc-<thời gian> (phòng khi chọn nhầm bản);
 *   2. chép crm.db của bản sao lưu đè lên CSDL đang dùng;
 *   3. nếu bản sao lưu có storage/: đổi tên thư mục storage hiện tại thành
 *      storage.truoc-khoi-phuc-<thời gian> rồi chép storage của bản sao lưu vào;
 *   4. khoá mã hoá: chỉ chép khi thêm --with-key (mặc định chỉ cảnh báo nếu khác).
 * Không xoá gì của hiện trạng: mọi thứ cũ đều được giữ lại bên cạnh.
 */
import fs from "node:fs";
import path from "node:path";
import { env, encryptionKeyFilePath } from "../src/lib/env";
import { sqliteFilePath, stamp } from "../src/lib/backup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const from = arg("from");
  if (!from) throw new Error("Thiếu --from <thư mục bản sao lưu>");
  const src = path.resolve(from);
  const srcDb = path.join(src, "crm.db");
  if (!fs.existsSync(srcDb)) throw new Error(`Không thấy ${srcDb}`);

  const dbFile = sqliteFilePath();
  if (!dbFile) throw new Error("Chỉ khôi phục được CSDL SQLite (DATABASE_URL dạng file:)");

  if (!process.argv.includes("--yes")) {
    console.log(`Sẽ khôi phục ${srcDb}\n  đè lên ${dbFile}\nĐã TẮT server chưa? Chạy lại kèm --yes để thực hiện.`);
    process.exit(2);
  }

  const ts = stamp();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  if (fs.existsSync(dbFile)) {
    const keep = `${dbFile}.truoc-khoi-phuc-${ts}`;
    fs.copyFileSync(dbFile, keep);
    console.log(`Đã giữ CSDL hiện tại tại ${keep}`);
  }
  // Tệp WAL/SHM của CSDL cũ không còn khớp với CSDL mới: bỏ đi (đã có bản giữ ở trên).
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (fs.existsSync(dbFile + suffix)) fs.renameSync(dbFile + suffix, `${dbFile}${suffix}.truoc-khoi-phuc-${ts}`);
  }
  fs.copyFileSync(srcDb, dbFile);
  console.log(`Đã khôi phục CSDL từ ${srcDb}`);

  const srcStorage = path.join(src, "storage");
  if (fs.existsSync(srcStorage) && !process.argv.includes("--no-storage")) {
    if (fs.existsSync(env.storageDir)) {
      const keep = `${env.storageDir}.truoc-khoi-phuc-${ts}`;
      fs.renameSync(env.storageDir, keep);
      console.log(`Đã giữ kho tệp hiện tại tại ${keep}`);
    }
    fs.cpSync(srcStorage, env.storageDir, { recursive: true });
    console.log(`Đã khôi phục kho tệp vào ${env.storageDir}`);
  }

  const srcKey = path.join(src, "enc-key");
  const keyFile = encryptionKeyFilePath();
  if (fs.existsSync(srcKey)) {
    const current = keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : null;
    const backup = fs.readFileSync(srcKey, "utf8").trim();
    if (current === backup) {
      console.log("Khoá mã hoá hiện tại trùng với bản sao lưu.");
    } else if (process.argv.includes("--with-key") && keyFile) {
      if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, `${keyFile}.truoc-khoi-phuc-${ts}`);
      fs.copyFileSync(srcKey, keyFile);
      fs.chmodSync(keyFile, 0o600);
      console.log(`Đã khôi phục khoá mã hoá vào ${keyFile}`);
    } else {
      console.warn(
        "CẢNH BÁO: khoá mã hoá trong bản sao lưu KHÁC khoá đang dùng. Ảnh và token sẽ không giải mã được. Chạy lại kèm --with-key nếu đây là máy dựng lại."
      );
    }
  }
  console.log("Xong. Khởi động lại server rồi kiểm tra đăng nhập, hồ sơ khách và ảnh.");
}

try {
  main();
} catch (err) {
  console.error("Khôi phục thất bại:", err);
  process.exit(1);
}
