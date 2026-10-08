import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type DraftCell = { caption: string; visual: string };
type ImageApiProtocol = "responses" | "chat_completions";
type ModelConfig = {
  id: string;
  providerId: string;
  provider: string;
  protocol: ImageApiProtocol;
  name: string;
  endpoint: string;
  enabled: boolean;
  priceCoins: number;
  secretConfigured: boolean;
};
type JobOptions = {
  cellCount: number;
  originalStyle: boolean;
  noText: boolean;
  whiteBorder: boolean;
  cells: DraftCell[];
};
type GenerationJobRow = {
  id: string;
  user_id: string;
  title: string;
  topic: string;
  status: string;
  model_id: string;
  model_name?: string;
  price_coins: number;
  reference_path: string;
  options: JobOptions;
  worker_token?: string | null;
};
type ImagePayload = { bytes: Uint8Array; contentType: string };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const IMAGE_BUCKET = "jiwang-private";
const DEFAULT_PROMPT = "生成统一角色设定的聊天表情。每格保持清晰轮廓、单一动作和易读情绪；透明背景，主体居中。主题：{{topic}}；单格描述：{{caption}}；画面：{{visual}}。";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeText(value: unknown, maxLength: number, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function safeUpstreamDetail(body: string, apiKey: string): string {
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

function upstreamErrorMessage(protocol: string, status: number, detail = ""): string {
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
  return `${reason}${upstreamNote}\n建议：${action} 如本任务已经预扣汪币，系统会尝试自动退回；请以任务历史和余额为准，未到账时联系管理员核对退款记录。`;
}

function upstreamNetworkError(protocol: string, cause: unknown): Error {
  const name = cause && typeof cause === "object" && "name" in cause ? String((cause as Record<string, unknown>).name) : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new Error(`${protocol} 上游请求超过 40 秒仍未响应，已超时。\n建议：请先查看任务历史确认云端状态，稍后再试；如已预扣汪币，系统会尝试自动退回，请刷新余额确认。`);
  }
  return new Error(`连接 ${protocol} 上游失败，可能是 Base URL、DNS、TLS、代理或供应商网络异常。\n建议：请管理员核对 HTTPS Base URL 和网络连通性；先查看任务历史及余额确认本次状态，不要立即重复提交。`);
}

async function responseFailure(response: Response, protocol: string, apiKey: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(upstreamErrorMessage(protocol, response.status, safeUpstreamDetail(body, apiKey)));
}

function validateCells(value: unknown): DraftCell[] | null {
  if (!Array.isArray(value) || value.length !== 16) return null;
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

function safeEndpoint(value: string): string {
  const raw = value.trim() || "https://api.openai.com/v1";
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("模型 API Base URL 格式无效；请填写完整的 HTTPS 地址，例如 https://api.example.com/v1"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("模型 API Base URL 必须是干净的 HTTPS 地址");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isNonPublicAddress(host)) throw new Error("模型 API 地址不能指向本地或内网主机");
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" ||
      host === "127.0.0.1" || host === "::1" || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("模型 API 地址不能指向本地或内网主机");
  }
  return raw.replace(/\/+$/, "");
}

function promptForCell(template: string, topic: string, cell: DraftCell, index: number, options: JobOptions): string {
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

function bytesFromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isNonPublicAddress(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1" || value === "0.0.0.0" || value === "::") return true;
  if (value.includes(":")) return value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function imageFromResponse(data: Record<string, unknown>): Promise<ImagePayload> {
  const encoded = typeof data.b64_json === "string" ? data.b64_json : data.result;
  if (typeof encoded === "string" && encoded.length > 0) {
    let bytes: Uint8Array;
    try { bytes = bytesFromBase64(encoded); }
    catch { throw new Error("模型返回的图片数据不是有效的 Base64 编码；请管理员检查供应商响应格式"); }
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("模型返回的单张图为空或超过 10 MB 限制");
    const contentType = typeof data.content_type === "string" && /^image\/(png|jpeg|webp)$/.test(data.content_type) ? data.content_type : "image/png";
    return { bytes, contentType };
  }
  const nestedUrl = data.image_url && typeof data.image_url === "object" ? (data.image_url as Record<string, unknown>).url : undefined;
  const urlText = typeof data.url === "string" ? data.url : nestedUrl;
  if (typeof urlText === "string") {
    const dataUrl = urlText.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (dataUrl) return await imageFromResponse({ b64_json: dataUrl[2], content_type: dataUrl[1] });
    let imageUrl: URL;
    try { imageUrl = new URL(urlText); }
    catch { throw new Error("模型返回的图片地址格式无效；请管理员检查供应商响应格式"); }
    if (imageUrl.protocol !== "https:" || isNonPublicAddress(imageUrl.hostname)) throw new Error("模型返回了不安全的图片地址");
    let response: Response;
    try { response = await fetch(imageUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch (cause) {
      const name = cause && typeof cause === "object" && "name" in cause ? String((cause as Record<string, unknown>).name) : "";
      if (name === "AbortError" || name === "TimeoutError") throw new Error("下载上游生成图片超过 15 秒，图片链接可能已过期或网络超时；请稍后重试");
      throw new Error("无法下载上游返回的图片，可能是临时图片链接失效或网络中断；请管理员检查供应商输出方式");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
    if (!response.ok) throw new Error(`下载上游图片失败（HTTP ${response.status}）；图片链接可能失效或被供应商拒绝`);
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error(`模型返回的内容不是支持的 PNG、JPEG 或 WebP 图片（收到 ${contentType || "未知格式"}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("模型返回的图片为空或超过 10 MB 限制");
    return { bytes, contentType };
  }
  throw new Error("模型响应中没有可用图像（需要 data[0].b64_json 或 data[0].url）");
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function imageFromChatCompletion(payload: Record<string, unknown>, apiKey: string): Promise<ImagePayload> {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  const message = choice?.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
  const imageCandidates: Record<string, unknown>[] = [];
  if (Array.isArray(message.images)) {
    for (const image of message.images) {
      if (!image || typeof image !== "object") continue;
      const item = image as Record<string, unknown>;
      imageCandidates.push(item, item.image_url && typeof item.image_url === "object" ? item.image_url as Record<string, unknown> : {});
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const item = part as Record<string, unknown>;
      if (["image", "image_url", "output_image"].includes(String(item.type))) {
        imageCandidates.push(item, item.image_url && typeof item.image_url === "object" ? item.image_url as Record<string, unknown> : {});
      }
    }
  }
  let candidateError: unknown;
  for (const candidate of imageCandidates) {
    try { return await imageFromResponse(candidate); }
    catch (cause) { candidateError = cause; }
  }
  if (typeof message.content === "string") {
    const dataUrl = message.content.match(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/);
    const markdownUrl = message.content.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/);
    const plainUrl = message.content.match(/https:\/\/[^\s)\]]+/);
    const imageRef = dataUrl?.[0] || markdownUrl?.[1] || plainUrl?.[0];
    if (imageRef) return await imageFromResponse({ url: imageRef });
  }
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const first = rows.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  if (first) return await imageFromResponse(first);
  if (candidateError instanceof Error) throw new Error(`Chat Completions 返回了图片字段，但读取失败：${candidateError.message}`);
  const refusal = safeText(message.refusal, 300);
  const textParts = Array.isArray(message.content)
    ? message.content.flatMap((part) => part && typeof part === "object" ? [safeText((part as Record<string, unknown>).text, 300)] : []).filter(Boolean)
    : [];
  const text = typeof message.content === "string" ? message.content : textParts.join(" ");
  const note = safeUpstreamDetail(JSON.stringify({ message: refusal || text }), apiKey);
  throw new Error(`Chat Completions 未返回可用图像；上游可能拒绝了请求、只返回了文字，或所选模型不支持图像输出${note ? `（上游说明：${note}）` : ""}。请管理员确认该模型的图像输入/输出能力、内容策略和响应格式。`);
}

async function callImageModel(endpoint: string, apiKey: string, model: ModelConfig, reference: Blob, prompt: string): Promise<ImagePayload> {
  const referenceUrl = `data:${reference.type || "image/png"};base64,${base64FromBytes(new Uint8Array(await reference.arrayBuffer()))}`;
  if (model.protocol === "responses") {
    let response: Response;
    try {
      response = await fetch(`${endpoint}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.name,
          input: [{ role: "user", content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: referenceUrl, detail: "high" },
          ] }],
          tools: [{ type: "image_generation", model: model.name, action: "edit", size: "1024x1024", background: "transparent" }],
          tool_choice: { type: "image_generation" },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(40_000),
      });
    } catch (cause) { throw upstreamNetworkError("Responses API", cause); }
    if (!response.ok) throw await responseFailure(response, "Responses API", apiKey);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("Responses API 返回的不是有效 JSON（可能是代理错误页或供应商响应格式不兼容）。请管理员检查接口地址和协议。"); }
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const output = Array.isArray(root.output) ? root.output : [];
    const imageCall = output.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "image_generation_call") as Record<string, unknown> | undefined;
    if (typeof imageCall?.result === "string") return await imageFromResponse({ b64_json: imageCall.result });
    const dataRows = Array.isArray(root.data) ? root.data : [];
    const first = dataRows.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    if (first) return await imageFromResponse(first);
    const responseError = typeof root.error === "string"
      ? safeText(root.error, 300)
      : root.error && typeof root.error === "object"
        ? safeText((root.error as Record<string, unknown>).message, 300)
        : "";
    const incomplete = root.incomplete_details && typeof root.incomplete_details === "object"
      ? safeText((root.incomplete_details as Record<string, unknown>).reason, 160)
      : "";
    const textOutputs = output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const content = Array.isArray(row.content) ? row.content : [];
      return content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const value = part as Record<string, unknown>;
        return value.type === "refusal" || value.type === "output_text" ? [safeText(value.refusal || value.text, 300)] : [];
      });
    }).filter(Boolean).join(" ");
    const outputNote = textOutputs ? safeUpstreamDetail(JSON.stringify({ message: textOutputs }), apiKey) : "";
    const detail = responseError || incomplete || outputNote;
    throw new Error(`Responses API 请求已响应，但未返回可用图片结果${detail ? `（上游说明：${detail}）` : ""}。请管理员确认该模型支持 image_generation 工具，并检查内容策略或响应格式。`);
  }

  let response: Response;
  try {
    response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: referenceUrl, detail: "high" } },
        ] }],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
  } catch (cause) { throw upstreamNetworkError("Chat Completions", cause); }
  if (!response.ok) throw await responseFailure(response, "Chat Completions", apiKey);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Chat Completions 返回的不是有效 JSON（可能是代理错误页或供应商响应格式不兼容）。请管理员检查接口地址和协议。"); }
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return await imageFromChatCompletion(root, apiKey);
}

function extensionFor(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

function validateReferencePath(path: string, userId: string): boolean {
  return path.startsWith(`${userId}/references/`) && !path.includes("..") && path.length <= 512;
}

async function signedImages(admin: SupabaseClient, jobId: string) {
  const { data, error } = await admin.from("assets")
    .select("cell_index,storage_path")
    .eq("job_id", jobId)
    .eq("kind", "sticker")
    .order("cell_index", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ cell_index: number; storage_path: string }>;
  const paths = rows.map((row) => row.storage_path);
  const { data: signed, error: signedError } = await admin.storage.from(IMAGE_BUCKET).createSignedUrls(paths, 1800);
  if (signedError) throw signedError;
  return (signed ?? []).map((entry, index) => ({ cellIndex: rows[index]?.cell_index ?? index, url: entry.signedUrl ?? "" }));
}

async function failJob(admin: SupabaseClient, jobId: string, workerToken: string, error: unknown, uploadedPaths: string[]) {
  const message = error instanceof Error ? error.message : "图像生成失败";
  let failError: unknown = null;
  try {
    const result = await admin.rpc("worker_fail_generation", { p_job_id: jobId, p_worker_token: workerToken, p_error: message.slice(0, 900) });
    failError = result.error;
  } catch (cause) { failError = cause; }
  try {
    const { data: rows } = await admin.from("assets").select("storage_path").eq("job_id", jobId).eq("kind", "sticker");
    const paths = (rows ?? []).map((row: { storage_path: string }) => row.storage_path);
    await admin.from("assets").delete().eq("job_id", jobId).eq("kind", "sticker");
    const cleanupPaths = [...new Set([...paths, ...uploadedPaths])];
    if (cleanupPaths.length) await admin.storage.from(IMAGE_BUCKET).remove(cleanupPaths);
  } catch { /* Cleanup is best-effort; never hide whether refund persistence succeeded. */ }
  return !failError;
}

async function processJob(admin: SupabaseClient, job: GenerationJobRow, model: ModelConfig, promptTemplate: string) {
  const workerToken = crypto.randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc("worker_claim_generation", {
    p_job_id: job.id,
    p_worker_token: workerToken,
  });
  if (claimError) {
    await admin.from("generation_jobs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: "生成任务无法启动：服务端认领任务失败，未调用图像模型。请管理员检查数据库 RPC 权限和服务端配置。" })
      .eq("id", job.id).eq("status", "queued");
    throw new Error("生成任务无法启动：服务端认领任务失败，未调用图像模型。\n建议：请管理员检查数据库 RPC 权限和服务端配置；本次不会产生模型调用费用。若无法确认任务状态，请先查看任务历史和余额。");
  }
  if (!claimed) throw new Error("该任务正在处理中或已完成，请勿重复提交");

  const storedPaths: string[] = [];
  let balanceAfterReserve = 0;
  try {
    const secretResult = await admin.rpc("worker_get_image_provider_api_key", { p_provider_id: model.providerId });
    const { data: secret, error: secretError } = secretResult;
    if (secretError || typeof secret !== "string" || !secret) throw new Error("当前模型未启用、供应商密钥未保存或密钥读取失败；模型调用尚未开始。\n建议：请管理员检查模型启用状态、API Key 保存状态及数据库密钥读取权限。");

    const { data: reserved, error: reserveError } = await admin.rpc("worker_reserve_generation_coins", {
      p_job_id: job.id,
      p_worker_token: workerToken,
    });
    if (reserveError) {
      if (reserveError.message.toLowerCase().includes("insufficient wallet balance")) {
        throw new Error("汪币余额不足，本次模型调用未开始。\n建议：刷新余额，选择价格更低的已启用模型，或先补充汪币。");
      }
      throw new Error(`汪币预扣失败，模型调用尚未开始（${safeText(reserveError.message, 220)}）。\n建议：请刷新余额，并让管理员检查数据库结算 RPC、权限和服务状态；确认任务历史后再重试。`);
    }
    balanceAfterReserve = Number(reserved ?? 0);

    if (!validateReferencePath(job.reference_path, job.user_id)) throw new Error("角色参考图路径无效或不属于当前账号，模型调用尚未开始。请重新上传图片后再试。");
    const { data: reference, error: referenceError } = await admin.storage.from(IMAGE_BUCKET).download(job.reference_path);
    if (referenceError || !reference) throw new Error(`无法读取已上传的角色参考图${referenceError?.message ? `（${safeText(referenceError.message, 180)}）` : ""}。\n建议：请重新上传图片；若仍失败，请管理员检查私有存储桶 jiwang-private、对象路径和服务端读取权限。`);
    if (reference.size === 0 || reference.size > 12 * 1024 * 1024) throw new Error("角色参考图为空或超过 12 MB。请换一张有效且较小的 PNG、JPG 或 WebP 图片。");
    const referenceType = reference.type || "image/png";
    if (!/^image\/(png|jpeg|webp)$/.test(referenceType)) throw new Error(`角色参考图格式不受支持（${referenceType}）；请重新上传 PNG、JPG 或 WebP 图片。`);
    const apiEndpoint = safeEndpoint(model.endpoint);
    const { data: promptRow } = await admin.from("admin_settings").select("value").eq("setting_key", "prompts").maybeSingle();
    const template = typeof promptRow?.value?.sticker === "string" ? promptRow.value.sticker : DEFAULT_PROMPT;
    const options = job.options;
    const cells = validateCells(options?.cells);
    if (!cells || options?.cellCount !== 16) throw new Error("任务脚本不完整，必须包含 16 格且每格有短句和画面描述。请返回工坊检查脚本后再试。");

    for (let start = 0; start < cells.length; start += 8) {
      const batch = cells.slice(start, start + 8);
      const batchResults = await Promise.allSettled(batch.map((cell, offset) => {
        const index = start + offset;
        return callImageModel(
          apiEndpoint,
          secret,
          model,
          reference,
          promptForCell(template, job.topic, cell, index, options),
        );
      }));
      const failedResult = batchResults.find((result) => result.status === "rejected");
      if (failedResult?.status === "rejected") throw failedResult.reason;
      const outputs = batchResults.map((result) => result.status === "fulfilled" ? result.value : null).filter((result): result is ImagePayload => result !== null);
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < outputs.length; offset += 1) {
        const index = start + offset;
        const output = outputs[offset]!;
        const storagePath = `${job.user_id}/jobs/${job.id}/${String(index + 1).padStart(2, "0")}.${extensionFor(output.contentType)}`;
        const { error: uploadError } = await admin.storage.from(IMAGE_BUCKET).upload(storagePath, new Blob([output.bytes], { type: output.contentType }), {
          contentType: output.contentType,
          upsert: true,
        });
        if (uploadError) throw new Error(`第 ${index + 1} 张图片已生成，但保存到私有素材库失败（${safeText(uploadError.message, 220)}）。\n建议：本任务会标记失败并尝试退回已预扣汪币；请刷新任务历史和余额，并让管理员检查存储空间、存储桶权限和数据库连接。`);
        storedPaths.push(storagePath);
        rows.push({
          user_id: job.user_id,
          job_id: job.id,
          kind: "sticker",
          name: cells[index]?.caption || `表情 ${index + 1}`,
          storage_path: storagePath,
          mime_type: output.contentType,
          cell_index: index,
          caption: cells[index]?.caption || "",
        });
      }
      const { error: assetError } = await admin.from("assets").delete().eq("job_id", job.id).eq("kind", "sticker").gte("cell_index", start).lt("cell_index", start + outputs.length);
      if (assetError) throw new Error(`第 ${start + 1}–${start + outputs.length} 张图片生成后，更新素材记录失败（${safeText(assetError.message, 220)}）。\n建议：任务会尝试退款；请管理员检查 assets 表和数据库权限。`);
      const { error: insertError } = await admin.from("assets").insert(rows);
      if (insertError) throw new Error(`第 ${start + 1}–${start + outputs.length} 张图片生成后，写入素材记录失败（${safeText(insertError.message, 220)}）。\n建议：任务会尝试退款；请管理员检查 assets 表、数据库连接及权限。`);
      const progress = Math.min(95, 20 + Math.round(((start + outputs.length) / 16) * 75));
      const { error: progressError } = await admin.rpc("worker_update_generation_progress", {
        p_job_id: job.id,
        p_worker_token: workerToken,
        p_progress: progress,
      });
      if (progressError) throw new Error(`图片已生成，但更新任务进度失败（${safeText(progressError.message, 220)}）。\n建议：请管理员检查生成任务进度 RPC 权限；任务将尝试标记失败并退回已预扣汪币。`);
    }
    const { error: completeError } = await admin.rpc("worker_complete_generation", {
      p_job_id: job.id,
      p_worker_token: workerToken,
    });
    if (completeError) throw new Error(`图片已生成，但任务完成状态写入失败（${safeText(completeError.message, 220)}）。\n建议：请先查看任务历史和素材库；系统会尝试标记失败并退回已预扣汪币，如状态或余额不符请联系管理员核对。`);
  } catch (error) {
    const failureSaved = await failJob(admin, job.id, workerToken, error, storedPaths);
    if (!failureSaved) {
      const message = error instanceof Error ? error.message : "图像生成失败";
      throw new Error(`${message}\n\n严重提醒：服务端未能确认失败/退款记录已写入。请勿重复提交；立即刷新任务历史与汪币余额，并联系管理员核对该任务的退款流水。`);
    }
    throw error;
  }
  return { images: await signedImages(admin, job.id), balance: balanceAfterReserve };
}

async function currentModel(admin: SupabaseClient, modelId: string): Promise<ModelConfig> {
  const { data, error } = await admin.from("admin_settings").select("value").eq("setting_key", "model").maybeSingle();
  if (error) throw new Error(`无法读取模型配置（${safeText(error.message, 220)}），本次任务尚未调用模型或预扣汪币。\n建议：请管理员检查 admin_settings 表、数据库连接和服务端权限。`);
  const value = data?.value && typeof data.value === "object" ? data.value as Record<string, unknown> : {};
  const providers = Array.isArray(value.providers) ? value.providers as Array<Record<string, unknown>> : [];
  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : [];
    const configured = models.find((item) => item.id === modelId);
    if (!configured) continue;
    const model: ModelConfig = {
      id: String(configured.id || ""),
      providerId: String(provider.id || ""),
      provider: safeText(provider.name, 160),
      protocol: provider.protocol === "chat_completions" ? "chat_completions" : "responses",
      name: safeText(configured.name, 160),
      endpoint: safeText(provider.baseUrl, 2048),
      enabled: configured.enabled === true,
      priceCoins: Number(configured.priceCoins),
      secretConfigured: provider.secretConfigured === true,
    };
    if (!model.enabled || !model.secretConfigured) throw new Error("所选模型已停用或未配置 API Key");
    if (!Number.isInteger(model.priceCoins) || model.priceCoins < 1 || model.priceCoins > 100000) throw new Error("该模型尚未设置有效汪币价格");
    if (!safeText(model.name, 160) || !isUuid(model.id) || !isUuid(model.providerId)) throw new Error("模型配置无效");
    return model;
  }

  throw new Error("所选模型不存在或配置格式已更新");
}

async function handleModelList(admin: SupabaseClient, user: { id: string; app_metadata: Record<string, unknown> }, body: Record<string, unknown>) {
  if (user.app_metadata?.role !== "admin") return respond(403, { error: "只有管理员可以获取上游模型列表" });
  const providerId = body.providerId;
  const apiKeyInput = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const protocol = body.protocol;
  const baseUrlInput = safeText(body.baseUrl, 2048);
  if (!isUuid(providerId) || !baseUrlInput || !["responses", "chat_completions"].includes(String(protocol))) {
    return respond(400, { error: "供应商 ID、协议或 Base URL 无效" });
  }
  if (apiKeyInput.length > 8192 || (apiKeyInput && apiKeyInput.length < 8)) return respond(400, { error: "API Key 长度无效" });

  let apiKey = apiKeyInput;
  if (!apiKey) {
    const secretResult = await admin.rpc("worker_get_image_provider_api_key", { p_provider_id: providerId });
    if (secretResult.error || typeof secretResult.data !== "string" || !secretResult.data) {
      return respond(400, { error: "请先输入 API Key，或保存该供应商密钥后再获取模型" });
    }
    apiKey = secretResult.data;
  }

  let endpoint: string;
  try { endpoint = safeEndpoint(baseUrlInput); }
  catch (cause) { return respond(400, { error: cause instanceof Error ? cause.message : "Base URL 无效" }); }
  let upstream: Response;
  try {
    upstream = await fetch(`${endpoint}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return respond(502, { error: "无法连接上游模型列表，请检查 Base URL 和网络" });
  }
  if (!upstream.ok) return respond(502, { error: `上游模型列表请求失败（${upstream.status}）` });

  let payload: unknown;
  try { payload = await upstream.json(); }
  catch { return respond(502, { error: "上游模型列表不是有效 JSON" }); }
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const modelIds = [...new Set(rows.flatMap((item) => {
    if (typeof item === "string") return [item.trim()];
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
    return id.trim() ? [id.trim()] : [];
  }).filter((id) => id.length <= 160))].slice(0, 500);
  return respond(200, { models: modelIds });
}

async function handleRetry(admin: SupabaseClient, user: { id: string; app_metadata: Record<string, unknown> }, body: Record<string, unknown>) {
  if (user.app_metadata?.role !== "admin") return respond(403, { error: "只有管理员可以重试失败任务" });
  const jobId = body.jobId;
  if (!isUuid(jobId)) return respond(400, { error: "任务编号无效" });
  const { data: job, error } = await admin.from("generation_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error || !job) return respond(404, { error: "任务不存在" });
  if (job.status !== "failed") return respond(409, { error: "只有失败任务可以重试" });
  const model = await currentModel(admin, job.model_id);
  const { error: updateError } = await admin.from("generation_jobs").update({
    status: "queued",
    model_name: model.name,
    price_coins: model.priceCoins,
    error_message: null,
    finished_at: null,
    progress: 0,
    worker_token: null,
    worker_started_at: null,
  }).eq("id", job.id).eq("status", "failed");
  if (updateError) return respond(500, { error: updateError.message });
  const refreshed = { ...job, status: "queued", model_name: model.name, price_coins: model.priceCoins } as GenerationJobRow;
  const { data: promptRow } = await admin.from("admin_settings").select("value").eq("setting_key", "prompts").maybeSingle();
  try {
    const result = await processJob(admin, refreshed, model, typeof promptRow?.value?.sticker === "string" ? promptRow.value.sticker : DEFAULT_PROMPT);
    return respond(200, { jobId: job.id, images: result.images, balance: result.balance, priceCoins: model.priceCoins });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "任务重试失败";
    const status = message.includes("汪币余额不足") ? 402 : 502;
    return respond(status, { error: message, jobId: job.id });
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return respond(500, { error: "生成服务端环境变量未配置；任务尚未创建、模型未调用且未预扣汪币。请管理员检查 Supabase Edge Function 密钥配置。" });

  const authorization = request.headers.get("Authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "");
  if (!accessToken) return respond(401, { error: "请先登录后再生成" });
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResult, error: userError } = await userClient.auth.getUser(accessToken);
  if (userError || !userResult.user) {
    if (/fetch|network|timeout|timed out/i.test(userError?.message || "")) {
      return respond(503, { error: "暂时无法连接登录验证服务，尚未创建任务或预扣汪币。请检查网络后重新登录，再查看任务历史和余额。" });
    }
    return respond(401, { error: "登录状态无效或已过期，尚未创建任务或预扣汪币。请重新登录后再试。" });
  }

  let parsed: unknown;
  try { parsed = await request.json(); } catch { return respond(400, { error: "请求内容不是有效 JSON；任务尚未创建、模型未调用且未预扣汪币。请刷新页面后重试。" }); }
  const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (body.action === "list_models") {
    try { return await handleModelList(admin, userResult.user, body); }
    catch { return respond(500, { error: "获取上游模型列表失败" }); }
  }
  if (body.action === "retry") {
    try { return await handleRetry(admin, userResult.user, body); }
    catch (cause) { return respond(500, { error: cause instanceof Error ? cause.message : "任务重试失败" }); }
  }

  const jobId = body.jobId;
  const modelId = body.modelId;
  const referencePath = safeText(body.referencePath, 512);
  const topic = safeText(body.topic, 160);
  const title = safeText(body.title, 120, "未命名表情套装");
  const cells = validateCells(body.cells);
  const opts = body.options && typeof body.options === "object" ? body.options as Record<string, unknown> : {};
  if (!isUuid(jobId) || !isUuid(modelId) || !referencePath || !topic || !cells) return respond(400, { error: "任务参数不完整或无效：请确认任务编号、模型、主题、参考图和完整 16 格脚本；本次尚未创建任务或预扣汪币。" });
  if (!validateReferencePath(referencePath, userResult.user.id)) return respond(403, { error: "参考图路径无效或不属于当前账号；任务尚未创建、模型未调用且未预扣汪币。请重新上传角色图。" });
  const options: JobOptions = {
    cellCount: 16,
    cells,
    originalStyle: opts.originalStyle === true,
    noText: opts.noText === true,
    whiteBorder: opts.whiteBorder === true,
  };

  try {
    const { data: existing, error: existingError } = await admin.from("generation_jobs").select("id,user_id,status").eq("id", jobId).maybeSingle();
    if (existingError) return respond(500, { error: `无法检查重复任务（${safeText(existingError.message, 220)}），任务尚未开始计费。请管理员检查数据库连接和 generation_jobs 权限。` });
    if (existing) {
      if (existing.user_id !== userResult.user.id) return respond(404, { error: "任务不存在" });
      if (existing.status === "completed") return respond(200, { jobId, images: await signedImages(admin, jobId), reused: true });
      return respond(409, { error: `此任务已存在，当前状态为「${existing.status}」；为避免重复扣费，本次没有重新提交。请到任务历史查看该任务，确认失败退款后再开始新任务。`, jobId });
    }

    const model = await currentModel(admin, modelId);
    const { data: promptRow } = await admin.from("admin_settings").select("value").eq("setting_key", "prompts").maybeSingle();
    const { error: insertError } = await admin.from("generation_jobs").insert({
      id: jobId,
      client_request_id: jobId,
      user_id: userResult.user.id,
      kind: "sticker_grid",
      status: "queued",
      title,
      topic,
      model_id: model.id,
      model_name: model.name,
      price_coins: model.priceCoins,
      reference_path: referencePath,
      progress: 0,
      options,
    });
    if (insertError) {
      const duplicate = insertError.code === "23505";
      return respond(duplicate ? 409 : 500, {
        error: duplicate
          ? "任务编号已使用，尚未启动模型调用。请返回工坊重新发起任务。"
          : `无法创建生成任务（${safeText(insertError.message, 220)}），模型调用尚未开始且未预扣汪币。请管理员检查 generation_jobs 表、数据库连接和权限。`,
      });
    }

    const template = typeof promptRow?.value?.sticker === "string" ? promptRow.value.sticker : DEFAULT_PROMPT;
    const result = await processJob(admin, {
      id: jobId,
      user_id: userResult.user.id,
      title,
      topic,
      status: "queued",
      model_id: model.id,
      price_coins: model.priceCoins,
      reference_path: referencePath,
      options,
    }, model, template);
    return respond(200, { jobId, images: result.images, balance: result.balance, priceCoins: model.priceCoins });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "生成失败，请稍后重试";
    const status = message.includes("汪币余额不足") ? 402 : 502;
    return respond(status, { error: message, jobId: isUuid(jobId) ? jobId : undefined });
  }
});
