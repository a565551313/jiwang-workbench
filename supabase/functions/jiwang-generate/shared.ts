// 纯函数工具：只使用 Web 标准 API，不依赖 Deno 专有能力，因此可以在 Vitest 中直接测试。
// 注意：计费结算的数学必须与 supabase 迁移中的 settle_generation_job 保持一致。

export const CELL_COUNT = 16;
export const BATCH_SIZE = 8;
export const MODEL_TIMEOUT_MS = 40_000;
export const DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
export const SIGNED_URL_SECONDS = 1800;
export const STALE_MINUTES = 10;

/** 这些状态表示请求本身有问题（密钥、参数、权限、额度），同一批次的其它格子大概率也会失败，可以提前停止。 */
const FATAL_UPSTREAM_STATUSES = new Set([400, 401, 402, 403, 404, 413, 415, 422]);

export type DraftCell = { caption: string; visual: string };
export type ImageApiProtocol = "responses" | "chat_completions";
export type JobOptions = {
  cellCount: number;
  originalStyle: boolean;
  noText: boolean;
  whiteBorder: boolean;
  cells: DraftCell[];
};
export type ImagePayload = { bytes: Uint8Array<ArrayBuffer>; contentType: string };
export type CellFailure = { cell: number; message: string; fatal: boolean };

export class UpstreamHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamHttpError";
    this.status = status;
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function safeText(value: unknown, maxLength: number, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

export function safeUpstreamDetail(body: string, apiKey: string): string {
  if (!body) return "";
  let detail = "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : {};
    detail = safeText(error.message, 400) || safeText(parsed.message, 400);
  } catch {
    if (!/<html[\s>]/i.test(body)) detail = body.replace(/[\r\n\t]+/g, " ").slice(0, 240);
  }
  return (apiKey ? detail.replaceAll(apiKey, "[凭据已隐藏]") : detail)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [凭据已隐藏]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[凭据已隐藏]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

export function upstreamErrorMessage(protocol: string, status: number, detail = ""): string {
  const api = `${protocol} 上游接口`;
  let reason: string;
  let action: string;
  if (status === 400) {
    reason = `${api} 返回 HTTP 400，请求参数不被接受。`;
    action = "请管理员核对协议、模型 ID 以及供应商支持的图像输入/输出参数。";
  } else if (status === 401) {
    reason = `${api} 返回 HTTP 401，API Key 无效、过期或未被该接口接受。`;
    action = "请管理员重新核对并保存供应商 API Key，并确认密钥属于正确账户。";
  } else if (status === 402) {
    reason = `${api} 返回 HTTP 402，上游账户额度或付款状态不足。`;
    action = "请管理员检查供应商账户余额、配额和计费状态。";
  } else if (status === 403) {
    reason = `${api} 返回 HTTP 403，上游拒绝了这次请求。常见原因包括 API Key 无权调用该模型、账户/区域策略限制，或供应商不支持当前协议的图像生成方式。`;
    action = "请管理员逐项核对供应商协议、Base URL、模型 ID 与 API Key 权限；确认前不要连续重复提交。";
  } else if (status === 404) {
    reason = `${api} 返回 HTTP 404，接口路径或模型 ID 未找到。`;
    action = "请管理员核对 Base URL 是否含正确 API 前缀、协议类型与模型 ID。";
  } else if (status === 408 || status === 504) {
    reason = `${api} 返回 HTTP ${status}，上游处理超时。`;
    action = "请先在任务历史确认云端状态，稍后再试；不要短时间重复提交。";
  } else if (status === 413) {
    reason = `${api} 返回 HTTP 413，请求内容超过上游限制。`;
    action = "请换用更小的参考图（当前上限 12 MB），并让管理员检查供应商的请求体限制。";
  } else if (status === 415) {
    reason = `${api} 返回 HTTP 415，上游不接受当前请求或图片格式。`;
    action = "请管理员确认该协议支持图像输入与图像生成，并核对供应商要求的图片格式。";
  } else if (status === 422) {
    reason = `${api} 返回 HTTP 422，模型不接受本次参数或输入格式。`;
    action = "请管理员核对模型 ID、协议及该模型支持的图像生成参数。";
  } else if (status === 429) {
    reason = `${api} 返回 HTTP 429，供应商限流或配额暂不可用。`;
    action = "请稍后重试，并让管理员检查上游并发限制、速率限制和账户配额。";
  } else if (status >= 500) {
    reason = `${api} 返回 HTTP ${status}，供应商服务暂时异常。`;
    action = "请稍后重试，并让管理员检查供应商服务状态。";
  } else {
    reason = `${api} 返回 HTTP ${status}，上游未接受生成请求。`;
    action = "请管理员检查供应商配置和服务状态。";
  }
  const upstreamNote = detail ? `\n上游说明：${detail}` : "";
  return `${reason}${upstreamNote}\n建议：${action} 如本任务已经预扣汪币，系统会在任务结束时自动结算退回；请以任务历史和余额为准。`;
}

export function upstreamNetworkError(protocol: string, cause: unknown): Error {
  const name = cause && typeof cause === "object" && "name" in cause ? String((cause as Record<string, unknown>).name) : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new Error(`${protocol} 上游请求超过 40 秒仍未响应，已超时。\n建议：请先查看任务历史确认云端状态，稍后再试；如已预扣汪币，系统会自动结算，请刷新余额确认。`);
  }
  return new Error(`连接 ${protocol} 上游失败，可能是 Base URL、DNS、TLS、代理或供应商网络异常。\n建议：请管理员核对 HTTPS Base URL 和网络连通性；先查看任务历史及余额确认本次状态，不要立即重复提交。`);
}

export function validateCells(value: unknown): DraftCell[] | null {
  if (!Array.isArray(value) || value.length !== CELL_COUNT) return null;
  const cells: DraftCell[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const caption = safeText(row.caption, 80);
    const visual = safeText(row.visual, 1200);
    if (!caption || !visual) return null;
    cells.push({ caption, visual });
  }
  return cells;
}

function parseIPv4(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function isNonPublicIPv4(parts: number[]): boolean {
  const [a, b, c] = parts as [number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

/** IPv4 embedded in an IPv6 literal: ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64). */
function embeddedIPv4(value: string): number[] | null {
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (dotted && value.includes("::")) return parseIPv4(dotted[1]!);
  // WHATWG URL serialises the same addresses in hex, e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1
  const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255];
  }
  return null;
}

function isNonPublicIPv6(value: string): boolean {
  const embedded = embeddedIPv4(value);
  if (embedded) return isNonPublicIPv4(embedded);
  if (value === "::" || value === "::1") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(value)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // fe80::/10 link local
  if (value.startsWith("ff")) return true; // ff00::/8 multicast
  if (value.startsWith("2001:db8:")) return true; // documentation prefix
  return false;
}

/**
 * Hostname/literal check used before any server-side request.
 * It works on the canonical host produced by `new URL()`; DNS names that resolve to private addresses
 * still need network-level egress controls (not available in the Edge runtime).
 */
export function isNonPublicAddress(host: string): boolean {
  const value = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!value) return true;
  if (value.includes(":")) return isNonPublicIPv6(value);
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal")) return true;
  const ipv4 = parseIPv4(value);
  if (ipv4) return isNonPublicIPv4(ipv4);
  // Public HTTPS services always use dotted DNS names; single-label names resolve inside private networks.
  return !value.includes(".");
}

/** Validate an upstream API Base URL and return it without a trailing slash. Throws a user-facing Chinese error. */
export function safeEndpoint(value: string): string {
  const raw = value.trim() || "https://api.openai.com/v1";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("模型 API Base URL 格式无效；请填写完整的 HTTPS 地址，例如 https://api.example.com/v1");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("模型 API Base URL 必须是干净的 HTTPS 地址");
  }
  if (parsed.port) throw new Error("模型 API Base URL 只能使用默认的 HTTPS 端口（443）");
  if (isNonPublicAddress(parsed.hostname)) throw new Error("模型 API 地址不能指向本地或内网主机");
  return parsed.href.replace(/\/+$/, "");
}

/** Mirror of the SQL normalisation used for the Base URL ↔ API key binding. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function promptForCell(template: string, topic: string, cell: DraftCell, index: number, options: JobOptions): string {
  const configured = template
    .replaceAll("{{topic}}", topic)
    .replaceAll("{{caption}}", cell.caption)
    .replaceAll("{{visual}}", cell.visual);
  const textRule = options.noText
    ? "Do not render any letters, words, captions, watermarks, or logos."
    : `Include only this short Chinese caption as visible text if the model can render it accurately: “${cell.caption}”.`;
  const styleRule = options.originalStyle
    ? "Preserve the reference character's identity, colors, and recognizable details."
    : "Use the reference character as inspiration while allowing a fresh, polished illustration style.";
  const borderRule = options.whiteBorder
    ? "Add a clean white sticker border around the character."
    : "Do not add an outer white sticker border.";
  return `${configured}\nCreate exactly one square chat sticker, cell ${index + 1} of 16. ${styleRule} ${borderRule} ${textRule} Follow this cell action: ${cell.visual}. Transparent background, centered full subject, no collage, no extra panels, no signature.`;
}

export function bytesFromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export function extensionFor(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

export function validateReferencePath(path: string, userId: string): boolean {
  return typeof path === "string" && path.startsWith(`${userId}/references/`) && !path.includes("..") && path.length <= 512;
}

export function stickerStoragePath(userId: string, jobId: string, index: number, contentType: string): string {
  return `${userId}/jobs/${jobId}/${String(index + 1).padStart(2, "0")}.${extensionFor(contentType)}`;
}

/**
 * Read a response body while enforcing a byte limit. The limit is checked while streaming, so an oversized
 * upstream body is cancelled instead of being buffered in full first.
 */
export async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function isFatalUpstreamStatus(status: number): boolean {
  return FATAL_UPSTREAM_STATUSES.has(status);
}

/** One readable explanation for the user: the first failure in full, plus how many other cells also failed. */
export function summarizeCellFailures(failures: CellFailure[]): string {
  if (failures.length === 0) return "";
  const [first] = failures;
  const others = failures.length - 1;
  return others > 0 ? `${first!.message}\n另有 ${others} 张也未能生成。` : first!.message;
}

/** Progress shown while generating: 5% at the start, 95% when all 16 cells are delivered. */
export function progressForDelivered(delivered: number): number {
  const count = Math.min(Math.max(Math.trunc(delivered), 0), CELL_COUNT);
  return 5 + Math.round((count / CELL_COUNT) * 90);
}

/** Amount kept for a partial set: ceil(charged × delivered ÷ 16). A full set keeps exactly the price. */
export function chargeForDelivered(charged: number, delivered: number): number {
  return Math.ceil((charged * delivered) / CELL_COUNT);
}
