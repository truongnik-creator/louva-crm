import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import { HttpError } from "../middleware/errorHandler";

// Kiểm loại tệp tải lên (T5).
//
// Hai lớp: (1) multer lọc theo MIME + đuôi tệp ngay khi nhận; (2) sau khi nhận
// xong, soi "chữ ký" vài byte đầu của nội dung. MIME và đuôi do máy khách tự
// khai, đổi tên virus.exe thành anh.jpg là qua lớp 1; lớp 2 thì không.

export type UploadKind = "image" | "pdf";

const MIME: Record<UploadKind, string[]> = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
  pdf: ["application/pdf"],
};
const EXT: Record<UploadKind, string[]> = {
  image: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"],
  pdf: [".pdf"],
};

/** Nhận diện loại tệp theo byte đầu. Trả null nếu không thuộc loại cho phép nào. */
export function sniffFileKind(buf: Buffer): UploadKind | null {
  if (buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString("hex");
  if (hex.startsWith("ffd8ff")) return "image"; // JPEG
  if (hex.startsWith("89504e470d0a1a0a")) return "image"; // PNG
  if (hex.startsWith("47494638")) return "image"; // GIF
  if (hex.startsWith("52494646") && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image";
  }
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  return null;
}

/** multer giữ tệp trong RAM (để mã hoá ngay, không có bản thô trên đĩa) và lọc MIME + đuôi. */
export function createUpload(opts: { kinds: UploadKind[]; maxFileSize?: number; maxFiles?: number }) {
  const mimes = opts.kinds.flatMap((k) => MIME[k]);
  const exts = opts.kinds.flatMap((k) => EXT[k]);
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxFileSize ?? 15 * 1024 * 1024, files: opts.maxFiles ?? 12 },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (!mimes.includes(file.mimetype) || (ext && !exts.includes(ext))) {
        return cb(new HttpError(415, `Loại tệp không được phép: ${file.originalname}. Chỉ nhận ${exts.join(", ")}`));
      }
      cb(null, true);
    },
  });
}

/** Đặt ngay sau middleware multer: soi nội dung thật của từng tệp đã nhận. */
export function verifyFileSignatures(kinds: UploadKind[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (Array.isArray(req.files)) files.push(...req.files);
    else if (req.files) for (const list of Object.values(req.files)) files.push(...list);

    for (const f of files) {
      const kind = sniffFileKind(f.buffer);
      if (!kind || !kinds.includes(kind)) {
        return next(new HttpError(415, `Nội dung tệp ${f.originalname} không phải ${kinds.includes("pdf") ? "ảnh hoặc PDF" : "ảnh"} hợp lệ`));
      }
    }
    next();
  };
}
