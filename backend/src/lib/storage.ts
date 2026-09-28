import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "./env";
import { encryptBuffer, decryptBuffer } from "./crypto";

// Kho tệp cục bộ, MÃ HOÁ KHI NGHỈ (encryption at rest).
//
// Ảnh trước-sau và chữ ký cam kết không bao giờ nằm trong CSDL và không bao
// giờ nằm dạng thô trên đĩa. Ở production lớp này đổi sang S3/R2 với
// server-side encryption; giao diện hàm giữ nguyên nên tầng route không đổi.

function fullPath(storageKey: string): string {
  // storageKey do hệ thống sinh (xem putEncrypted); chặn path traversal
  // phòng trường hợp khoá đến từ dữ liệu cũ hoặc nhập tay.
  const resolved = path.resolve(env.storageDir, storageKey);
  if (!resolved.startsWith(path.resolve(env.storageDir) + path.sep)) {
    throw new Error("storageKey không hợp lệ");
  }
  return resolved;
}

export interface StoredFile {
  storageKey: string;
  iv: string;
  tag: string;
  size: number; // kích thước bản rõ
}

/** Ghi buffer đã mã hoá, trả về khoá + IV + auth tag để lưu vào CSDL. */
export function putEncrypted(prefix: string, fileName: string, data: Buffer): StoredFile {
  const ext = path.extname(fileName).slice(0, 10);
  const key = path.join(prefix, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}.enc`);
  const target = fullPath(key);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const blob = encryptBuffer(data);
  fs.writeFileSync(target, blob.data, { mode: 0o600 });
  return { storageKey: key, iv: blob.iv, tag: blob.tag, size: data.length };
}

export function getDecrypted(storageKey: string, iv: string, tag: string): Buffer {
  const data = fs.readFileSync(fullPath(storageKey));
  return decryptBuffer({ data, iv, tag });
}

export function removeStored(storageKey: string): void {
  const target = fullPath(storageKey);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

export function ensureStorageDir(): void {
  fs.mkdirSync(env.storageDir, { recursive: true });
}
