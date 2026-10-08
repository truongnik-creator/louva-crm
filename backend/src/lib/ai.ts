import type { Request } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { writeAccessLog } from "./audit";
import { getSettingBool } from "./settings-catalog";
import { AccessResourceType } from "../types/enums";

// Lớp gọi AI dùng chung cho mọi lô (AI1 tách thông tin, AI2 gợi ý trả lời, ...).
//
// Ba luật cứng (Pháp lý dữ liệu, Nghị định 13/2023):
//   1. Thiếu ANTHROPIC_API_KEY thì AI TỰ TẮT: getAiClient() trả null, giao diện
//      báo "chưa cấu hình", nghiệp vụ không lỗi. Khoá không bao giờ nằm trong repo.
//   2. Khách chưa đồng ý xử lý dữ liệu (Customer.aiDataConsent) thì không gửi
//      nội dung chat của khách lên AI: dùng customerAllowsAi() trước khi gọi.
//   3. Mọi lần gọi AI có dữ liệu khách đều ghi DataAccessLog (AI_PROCESSING):
//      dùng callAiLogged() thay vì gọi client trực tiếp.
//
// Test KHÔNG gọi API thật: setAiClientForTests() thay client bằng bản giả.

export const AI_MODELS = {
  /** Việc rẻ: tách số, tóm tắt. */
  CHEAP: "claude-haiku-4-5-20251001",
  /** Gợi ý trả lời, chấm hội thoại (lô sau). */
  SMART: "claude-sonnet-5",
} as const;

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

/** Một khối system; cache = true thì gắn cache_control để Anthropic lưu đệm tiền tố (AI2: kịch bản dài). */
export interface AiSystemBlock {
  text: string;
  cache?: boolean;
}

export interface AiRequest {
  model: string;
  system?: string | AiSystemBlock[];
  messages: AiMessage[];
  maxTokens?: number;
}

export interface AiResponse {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Giao diện tối thiểu để lô sau và test thay được client. */
export interface AiClient {
  complete(req: AiRequest): Promise<AiResponse>;
}

class AnthropicAiClient implements AiClient {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  }
  async complete(req: AiRequest): Promise<AiResponse> {
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      ...(typeof req.system === "string"
        ? { system: req.system }
        : req.system?.length
          ? {
              system: req.system.map((b) => ({
                type: "text" as const,
                text: b.text,
                ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
              })),
            }
          : {}),
      messages: req.messages,
    });
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return {
      text,
      model: response.model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
      cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? undefined,
    };
  }
}

let override: AiClient | null | undefined;
let cached: { key: string; client: AiClient } | null = null;

/** Chỉ dùng trong test: truyền client giả, null = giả lập chưa cấu hình, undefined = trả về mặc định. */
export function setAiClientForTests(client: AiClient | null | undefined): void {
  override = client;
}

export function isAiConfigured(): boolean {
  if (override !== undefined) return override !== null;
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function getAiClient(): AiClient | null {
  if (override !== undefined) return override;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!cached || cached.key !== key) cached = { key, client: new AnthropicAiClient(key) };
  return cached.client;
}

/** Khách đã đồng ý cho xử lý dữ liệu bằng AI chưa. Không có hồ sơ = chưa đồng ý. */
export async function customerAllowsAi(customerId: string | null | undefined): Promise<boolean> {
  if (!customerId) return false;
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { aiDataConsent: true } });
  return Boolean(c?.aiDataConsent);
}

export type AiGateStatus = "OK" | "NOT_CONFIGURED" | "DISABLED" | "NO_CONSENT";

/** Kiểm cả ba cổng trước khi gọi AI cho một khách. */
export async function aiGate(opts: { customerId: string | null | undefined; settingKey?: string }): Promise<AiGateStatus> {
  if (!isAiConfigured()) return "NOT_CONFIGURED";
  if (opts.settingKey && !(await getSettingBool(opts.settingKey))) return "DISABLED";
  if (!(await customerAllowsAi(opts.customerId))) return "NO_CONSENT";
  return "OK";
}

/** Gọi AI có ghi DataAccessLog. Ném lỗi nếu AI chưa cấu hình (người gọi phải kiểm aiGate trước). */
export async function callAiLogged(opts: {
  req?: Request;
  customerId?: string | null;
  branchId?: string | null;
  purpose: string;
  request: AiRequest;
}): Promise<AiResponse> {
  const client = getAiClient();
  if (!client) throw new Error("AI chưa cấu hình");
  await writeAccessLog({
    req: opts.req,
    customerId: opts.customerId ?? null,
    branchId: opts.branchId,
    resourceType: AccessResourceType.AI_PROCESSING,
    resourceId: null,
    reason: `${opts.purpose} (${opts.request.model})`,
  });
  try {
    return await client.complete(opts.request);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), purpose: opts.purpose }, "[ai] gọi AI lỗi");
    throw err;
  }
}

/** Lấy khối JSON đầu tiên trong câu trả lời (model đôi khi bọc trong ```json). */
export function parseJsonFromText<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
