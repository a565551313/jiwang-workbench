import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanupExpiredReferences } from "../_shared/reference-cleanup.ts";
import {
  admissionFailure,
  base64FromBytes,
  BATCH_SIZE,
  bytesFromBase64,
  CELL_COUNT,
  type CellFailure,
  type DraftCell,
  DOWNLOAD_TIMEOUT_MS,
  isFatalUpstreamStatus,
  isNonPublicAddress,
  isUuid,
  type ImageApiProtocol,
  type ImagePayload,
  type JobOptions,
  MAX_IMAGE_BYTES,
  MAX_REFERENCE_BYTES,
  MODEL_TIMEOUT_MS,
  normalizeBaseUrl,
  progressForDelivered,
  promptForCell,
  readLimitedBytes,
  safeEndpoint,
  safeText,
  safeUpstreamDetail,
  SIGNED_URL_SECONDS,
  STALE_MINUTES,
  stickerStoragePath,
  summarizeCellFailures,
  UpstreamHttpError,
  upstreamErrorMessage,
  upstreamNetworkError,
  USED_REFERENCE_DAYS,
  validateCells,
  validateReferencePath,
} from "./shared.ts";

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
};

type PreparedJob = {
  endpoint: string;
  secret: string;
  referenceUrl: string;
  template: string;
  cells: DraftCell[];
  balanceAfterReserve: number;
};

type Settlement = { status: "completed" | "partial" | "failed"; delivered: number; refunded: number };

type JobOutcome = {
  status: "completed" | "partial";
  images: Array<{ cellIndex: number; url: string }>;
  delivered: number;
  refunded: number;
  balance: number;
  priceCoins: number;
};

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

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function failureStatus(cause: unknown): number {
  return errorText(cause, "").includes("汪币余额不足") ? 402 : 502;
}

async function responseFailure(response: Response, protocol: string, apiKey: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new UpstreamHttpError(upstreamErrorMessage(protocol, response.status, safeUpstreamDetail(body, apiKey)), response.status);
}

function providerKeyFailure(detail?: string): string {
  if (detail && /endpoint changed/i.test(detail)) {
    return "供应商 API 地址已变更，但尚未重新保存 API Key。为防止密钥被发送到新地址，本次模型调用未开始，也未预扣汪币。\n建议：请管理员在后台重新输入并保存该供应商的 API Key。";
  }
  return "当前模型未启用、供应商密钥未保存或密钥读取失败；模型调用尚未开始。\n建议：请管理员检查模型启用状态、API Key 保存状态及数据库密钥读取权限。";
}

async function imageFromResponse(data: Record<string, unknown>): Promise<ImagePayload> {
  const encoded = typeof data.b64_json === "string" ? data.b64_json : data.result;
  if (typeof encoded === "string" && encoded.length > 0) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = bytesFromBase64(encoded);
    } catch {
      throw new Error("模型返回的图片数据不是有效的 Base64 编码；请管理员检查供应商响应格式");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("模型返回的单张图为空或超过 10 MB 限制");
    const contentType = typeof data.content_type === "string" && /^image\/(png|jpeg|webp)$/.test(data.content_type) ? data.content_type : "image/png";
    return { bytes, contentType };
  }
  const nestedUrl = data.image_url && typeof data.image_url === "object" ? (data.image_url as Record<string, unknown>).url : undefined;
  const urlText = typeof data.url === "string" ? data.url : nestedUrl;
  if (typeof urlText === "string") {
    const dataUrl = urlText.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (dataUrl) return await imageFromResponse({ b64_json: dataUrl[2], content_type: dataUrl[1] });
    let imageUrl: URL;
    try {
      imageUrl = new URL(urlText);
    } catch {
      throw new Error("模型返回的图片地址格式无效；请管理员检查供应商响应格式");
    }
    if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password || imageUrl.port || isNonPublicAddress(imageUrl.hostname)) {
      throw new Error("模型返回了不安全的图片地址");
    }
    let response: Response;
    try {
      response = await fetch(imageUrl, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (cause) {
      const name = cause && typeof cause === "object" && "name" in cause ? String((cause as Record<string, unknown>).name) : "";
      if (name === "AbortError" || name === "TimeoutError") throw new Error("下载上游生成图片超过 15 秒，图片链接可能已过期或网络超时；请稍后重试");
      throw new Error("无法下载上游返回的图片，可能是临时图片链接失效或网络中断；请管理员检查供应商输出方式");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
    if (!response.ok) throw new Error(`下载上游图片失败（HTTP ${response.status}）；图片链接可能失效或被供应商拒绝`);
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error(`模型返回的内容不是支持的 PNG、JPEG 或 WebP 图片（收到 ${contentType || "未知格式"}）`);
    const bytes = await readLimitedBytes(response, MAX_IMAGE_BYTES);
    if (bytes.byteLength === 0) throw new Error("模型返回的图片为空");
    return { bytes, contentType };
  }
  throw new Error("模型响应中没有可用图像（需要 data[0].b64_json 或 data[0].url）");
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
    try {
      return await imageFromResponse(candidate);
    } catch (cause) {
      candidateError = cause;
    }
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

async function callImageModel(endpoint: string, apiKey: string, model: ModelConfig, referenceUrl: string, prompt: string): Promise<ImagePayload> {
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
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      });
    } catch (cause) {
      throw upstreamNetworkError("Responses API", cause);
    }
    if (!response.ok) throw await responseFailure(response, "Responses API", apiKey);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Responses API 返回的不是有效 JSON（可能是代理错误页或供应商响应格式不兼容）。请管理员检查接口地址和协议。");
    }
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
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (cause) {
    throw upstreamNetworkError("Chat Completions", cause);
  }
  if (!response.ok) throw await responseFailure(response, "Chat Completions", apiKey);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Chat Completions 返回的不是有效 JSON（可能是代理错误页或供应商响应格式不兼容）。请管理员检查接口地址和协议。");
  }
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return await imageFromChatCompletion(root, apiKey);
}

async function signedImages(admin: SupabaseClient, jobId: string): Promise<Array<{ cellIndex: number; url: string }>> {
  const { data, error } = await admin.from("assets")
    .select("cell_index,storage_path")
    .eq("job_id", jobId)
    .eq("kind", "sticker")
    .order("cell_index", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ cell_index: number; storage_path: string }>;
  if (rows.length === 0) return [];
  const { data: signed, error: signedError } = await admin.storage.from(IMAGE_BUCKET).createSignedUrls(rows.map((row) => row.storage_path), SIGNED_URL_SECONDS);
  if (signedError) throw signedError;
  return (signed ?? []).map((entry: { signedUrl?: string | null }, index: number) => ({ cellIndex: rows[index]?.cell_index ?? index, url: entry.signedUrl ?? "" }));
}

/** Objects under the job folder, whether or not they are referenced by an asset row (a failed insert can leave strays). */
async function listJobObjects(admin: SupabaseClient, userId: string, jobId: string): Promise<string[]> {
  const folder = `${userId}/jobs/${jobId}`;
  const { data, error } = await admin.storage.from(IMAGE_BUCKET).list(folder, { limit: 200 });
  if (error || !data) return [];
  return data.filter((entry: { name?: string }) => Boolean(entry.name)).map((entry: { name?: string }) => `${folder}/${entry.name}`);
}

async function cleanupJobArtifacts(admin: SupabaseClient, userId: string, jobId: string): Promise<void> {
  const { data: rows } = await admin.from("assets").select("storage_path").eq("job_id", jobId).eq("kind", "sticker");
  const paths = new Set<string>((rows ?? []).map((row: { storage_path: string }) => row.storage_path));
  for (const path of await listJobObjects(admin, userId, jobId)) paths.add(path);
  const { error } = await admin.from("assets").delete().eq("job_id", jobId).eq("kind", "sticker");
  if (error) throw error;
  if (paths.size > 0) await admin.storage.from(IMAGE_BUCKET).remove([...paths]);
}

/** For jobs that keep their delivered images, remove only stray objects that no asset row references. */
async function removeUndeliveredObjects(admin: SupabaseClient, userId: string, jobId: string): Promise<void> {
  const { data: rows } = await admin.from("assets").select("storage_path").eq("job_id", jobId).eq("kind", "sticker");
  const keep = new Set<string>((rows ?? []).map((row: { storage_path: string }) => row.storage_path));
  const stray = (await listJobObjects(admin, userId, jobId)).filter((path) => !keep.has(path));
  if (stray.length > 0) await admin.storage.from(IMAGE_BUCKET).remove(stray);
}

async function failJob(admin: SupabaseClient, job: { id: string; user_id: string }, workerToken: string, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message : "图像生成失败";
  try {
    const { error: failError } = await admin.rpc("worker_fail_generation", { p_job_id: job.id, p_worker_token: workerToken, p_error: message.slice(0, 900) });
    if (failError) return false;
  } catch {
    return false;
  }
  // Only clean up after the failure (and refund) was recorded; never delete artifacts of a job we do not own.
  await cleanupJobArtifacts(admin, job.user_id, job.id).catch(() => undefined);
  return true;
}

async function settleJob(admin: SupabaseClient, jobId: string, workerToken: string, note: string | null): Promise<Settlement> {
  const { data, error } = await admin.rpc("worker_complete_generation", { p_job_id: jobId, p_worker_token: workerToken, p_note: note });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { result_status?: string; result_delivered?: number; result_refunded?: number } | undefined;
  if (!row?.result_status) throw new Error("结算函数没有返回结果");
  return {
    status: row.result_status as Settlement["status"],
    delivered: Number(row.result_delivered ?? 0),
    refunded: Number(row.result_refunded ?? 0),
  };
}

async function loadPromptTemplate(admin: SupabaseClient): Promise<string> {
  const { data } = await admin.from("admin_settings").select("value").eq("setting_key", "prompts").maybeSingle();
  const value = data?.value as Record<string, unknown> | undefined;
  return typeof value?.sticker === "string" ? value.sticker : DEFAULT_PROMPT;
}

async function currentBalance(admin: SupabaseClient, userId: string, fallback: number): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).maybeSingle();
  return data ? Number(data.balance) : fallback;
}

/**
 * Everything that must succeed before any coin is reserved. Failures here leave the job failed with no charge.
 * Validation runs first so a malformed script or unsafe endpoint never reaches the wallet.
 */
async function prepareJob(admin: SupabaseClient, job: GenerationJobRow, model: ModelConfig, workerToken: string): Promise<PreparedJob> {
  const endpoint = safeEndpoint(model.endpoint);
  const cells = validateCells(job.options?.cells);
  if (!cells || job.options?.cellCount !== CELL_COUNT) {
    throw new Error("任务脚本不完整，必须包含 16 格且每格有短句和画面描述。请返回工坊检查脚本后再试。");
  }
  if (!validateReferencePath(job.reference_path, job.user_id)) {
    throw new Error("角色参考图路径无效或不属于当前账号，模型调用尚未开始。请重新上传图片后再试。");
  }
  const template = await loadPromptTemplate(admin);

  const { data: secret, error: secretError } = await admin.rpc("worker_get_image_provider_api_key", {
    p_provider_id: model.providerId,
    p_base_url: model.endpoint,
  });
  if (secretError || typeof secret !== "string" || !secret) throw new Error(providerKeyFailure(secretError?.message));

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
  const balanceAfterReserve = Number(reserved ?? 0);

  const { data: reference, error: referenceError } = await admin.storage.from(IMAGE_BUCKET).download(job.reference_path);
  if (referenceError || !reference) {
    throw new Error(`无法读取已上传的角色参考图${referenceError?.message ? `（${safeText(referenceError.message, 180)}）` : ""}。\n建议：请重新上传图片；若仍失败，请管理员检查私有存储桶 jiwang-private、对象路径和服务端读取权限。`);
  }
  if (reference.size === 0 || reference.size > MAX_REFERENCE_BYTES) {
    throw new Error("角色参考图为空或超过 12 MB。请换一张有效且较小的 PNG、JPG 或 WebP 图片。");
  }
  const referenceType = reference.type || "image/png";
  if (!/^image\/(png|jpeg|webp)$/.test(referenceType)) {
    throw new Error(`角色参考图格式不受支持（${referenceType}）；请重新上传 PNG、JPG 或 WebP 图片。`);
  }
  // Encode once; every cell request reuses the same data URL.
  const referenceUrl = `data:${referenceType};base64,${base64FromBytes(new Uint8Array(await reference.arrayBuffer()))}`;
  return { endpoint, secret, referenceUrl, template, cells, balanceAfterReserve };
}

/** Upload a batch of successful cells, record their asset rows, then publish progress. */
async function storeBatch(
  admin: SupabaseClient,
  job: { id: string; user_id: string },
  workerToken: string,
  ready: Array<{ index: number; output: ImagePayload }>,
  cells: DraftCell[],
  delivered: Map<number, string>,
): Promise<void> {
  if (ready.length > 0) {
    const uploaded: Array<{ index: number; path: string; row: Record<string, unknown> }> = [];
    for (const { index, output } of ready) {
      const storagePath = stickerStoragePath(job.user_id, job.id, index, output.contentType);
      const { error: uploadError } = await admin.storage.from(IMAGE_BUCKET).upload(storagePath, new Blob([output.bytes], { type: output.contentType }), {
        contentType: output.contentType,
        upsert: true,
      });
      if (uploadError) {
        throw new Error(`第 ${index + 1} 张图片已生成，但保存到私有素材库失败（${safeText(uploadError.message, 220)}）。\n建议：请管理员检查存储空间与存储桶权限；已保存的图片会按实际张数结算。`);
      }
      uploaded.push({
        index,
        path: storagePath,
        row: {
          user_id: job.user_id,
          job_id: job.id,
          kind: "sticker",
          name: cells[index]?.caption || `表情 ${index + 1}`,
          storage_path: storagePath,
          mime_type: output.contentType,
          cell_index: index,
          caption: cells[index]?.caption || "",
        },
      });
    }
    const { error: deleteError } = await admin.from("assets").delete()
      .eq("job_id", job.id)
      .eq("kind", "sticker")
      .in("cell_index", uploaded.map((item) => item.index));
    if (deleteError) throw new Error(`图片已保存，但更新素材记录失败（${safeText(deleteError.message, 220)}）。\n建议：请管理员检查 assets 表和数据库权限。`);
    const { error: insertError } = await admin.from("assets").insert(uploaded.map((item) => item.row));
    if (insertError) throw new Error(`图片已保存，但写入素材记录失败（${safeText(insertError.message, 220)}）。\n建议：请管理员检查 assets 表、数据库连接及权限。`);
    for (const item of uploaded) delivered.set(item.index, item.path);
  }
  const { error: progressError } = await admin.rpc("worker_update_generation_progress", {
    p_job_id: job.id,
    p_worker_token: workerToken,
    p_progress: progressForDelivered(delivered.size),
    p_completed_count: delivered.size,
  });
  if (progressError) throw new Error(`图片已生成，但更新任务进度失败（${safeText(progressError.message, 220)}）。\n建议：请管理员检查生成任务进度 RPC 权限。`);
}

/**
 * Run one claimed attempt end to end and settle it.
 * Cells are generated in batches of 8. A failed cell no longer discards its batch-mates: every image that
 * succeeded is stored and paid for, and the settlement function decides completed / partial / failed.
 */
async function processJob(admin: SupabaseClient, job: GenerationJobRow, model: ModelConfig): Promise<JobOutcome> {
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

  let prepared: PreparedJob;
  try {
    prepared = await prepareJob(admin, job, model, workerToken);
  } catch (error) {
    const failureSaved = await failJob(admin, job, workerToken, error);
    if (!failureSaved) {
      throw new Error(`${errorText(error, "图像生成失败")}\n\n严重提醒：服务端未能确认失败/退款记录已写入。请勿重复提交；立即刷新任务历史与汪币余额，并联系管理员核对该任务的退款流水。`);
    }
    throw error;
  }

  const failures: CellFailure[] = [];
  const delivered = new Map<number, string>();
  let storageError = "";
  try {
    storageError = await generateBatches(admin, job, model, prepared, workerToken, failures, delivered);
  } catch (cause) {
    // Anything unexpected still goes through settlement, so the wallet is never left reserved.
    storageError = `生成流程异常中断（${safeText(errorText(cause, "未知错误"), 180)}）`;
  }

  const note = [summarizeCellFailures(failures), storageError ? `图片保存中断：${storageError}` : ""].filter(Boolean).join("\n") || null;
  let settlement: Settlement;
  try {
    settlement = await settleJob(admin, job.id, workerToken, note);
  } catch (cause) {
    throw new Error(`图片已处理，但任务结算失败（${safeText(errorText(cause, ""), 220)}）。\n\n严重提醒：服务端未能确认结算结果。请勿重复提交；立即刷新任务历史与汪币余额，并联系管理员核对该任务的退款流水。`);
  }

  if (settlement.status === "failed") {
    await cleanupJobArtifacts(admin, job.user_id, job.id).catch(() => undefined);
    throw new Error(`${note || "图像模型没有返回任何可用图片。"}\n本次任务未交付图片，预扣汪币已全额退回（以余额为准）。`);
  }
  await removeUndeliveredObjects(admin, job.user_id, job.id).catch(() => undefined);
  return {
    status: settlement.status,
    images: await signedImages(admin, job.id),
    delivered: settlement.delivered,
    refunded: settlement.refunded,
    balance: await currentBalance(admin, job.user_id, prepared.balanceAfterReserve),
    priceCoins: model.priceCoins,
  };
}

/**
 * Generate the 16 cells in batches. Returns the reason the loop stopped early ("" when it ran to the end).
 * Failures are recorded in `failures`; successful cells are stored as they arrive.
 */
async function generateBatches(
  admin: SupabaseClient,
  job: GenerationJobRow,
  model: ModelConfig,
  prepared: PreparedJob,
  workerToken: string,
  failures: CellFailure[],
  delivered: Map<number, string>,
): Promise<string> {
  for (let start = 0; start < CELL_COUNT; start += BATCH_SIZE) {
    const indexes = Array.from({ length: BATCH_SIZE }, (_, offset) => start + offset);
    const results = await Promise.allSettled(indexes.map((index) => callImageModel(
      prepared.endpoint,
      prepared.secret,
      model,
      prepared.referenceUrl,
      promptForCell(prepared.template, job.topic, prepared.cells[index]!, index, job.options),
    )));
    const ready: Array<{ index: number; output: ImagePayload }> = [];
    const batchFailures: CellFailure[] = [];
    results.forEach((result, offset) => {
      const index = start + offset;
      if (result.status === "fulfilled") {
        ready.push({ index, output: result.value });
        return;
      }
      const reason = result.reason;
      batchFailures.push({
        cell: index + 1,
        message: errorText(reason, "图像生成失败"),
        fatal: reason instanceof UpstreamHttpError && isFatalUpstreamStatus(reason.status),
      });
    });
    failures.push(...batchFailures);
    try {
      await storeBatch(admin, job, workerToken, ready, prepared.cells, delivered);
    } catch (cause) {
      // Storage or progress failures stop the loop; what was already stored is still settled by the caller.
      return errorText(cause, "保存图片失败");
    }
    // If the whole batch was rejected for a reason that will repeat for every cell (bad key, quota, parameters), stop early.
    if (ready.length === 0 && batchFailures.length > 0 && batchFailures.every((failure) => failure.fatal)) break;
  }
  return "";
}

/** Recover jobs whose worker died. Runs on every generation request and from pg_cron when it is installed. */
async function sweepStaleGenerations(admin: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await admin.rpc("worker_reap_stale_generations", { p_stale_minutes: STALE_MINUTES, p_limit: 20 });
    if (!error && Array.isArray(data)) {
      for (const row of data as Array<{ result_job_id: string; result_user_id: string; result_status: string }>) {
        if (row.result_status === "failed") await cleanupJobArtifacts(admin, row.result_user_id, row.result_job_id).catch(() => undefined);
        else await removeUndeliveredObjects(admin, row.result_user_id, row.result_job_id).catch(() => undefined);
      }
    }
  } catch {
    // Recovery is best-effort and must not block the current request.
  }
  // A small batch of expired reference photos is also removed here; the scheduled cleanup does the rest.
  await cleanupExpiredReferences(admin, 1, 20).catch(() => undefined);
}

async function maintenanceEnabled(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin.from("admin_settings").select("value").eq("setting_key", "features").maybeSingle();
  if (error) throw new Error(`无法读取站点维护状态（${safeText(error.message, 180)}），尚未创建任务或预扣汪币。`);
  return (data?.value as Record<string, unknown> | undefined)?.maintenance === true;
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

  let endpoint: string;
  try {
    endpoint = safeEndpoint(baseUrlInput);
  } catch (cause) {
    return respond(400, { error: errorText(cause, "Base URL 无效") });
  }

  let apiKey = apiKeyInput;
  if (!apiKey) {
    // The stored key is only released for the Base URL it was saved with.
    const { data: stored, error: storedError } = await admin.rpc("worker_get_image_provider_api_key", {
      p_provider_id: providerId,
      p_base_url: normalizeBaseUrl(baseUrlInput),
    });
    if (storedError || typeof stored !== "string" || !stored) {
      return respond(400, { error: "请输入 API Key。若已修改 Base URL，必须重新输入 API Key；若尚未保存密钥，请先保存后再获取模型。" });
    }
    apiKey = stored;
  }

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
  try {
    payload = await upstream.json();
  } catch {
    return respond(502, { error: "上游模型列表不是有效 JSON" });
  }
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

function jobResponse(jobId: string, outcome: JobOutcome) {
  return {
    jobId,
    status: outcome.status,
    images: outcome.images,
    deliveredCount: outcome.delivered,
    refundedCoins: outcome.refunded,
    balance: outcome.balance,
    priceCoins: outcome.priceCoins,
  };
}

/** Owners retry their own failed jobs. The new attempt is charged at the current price the user confirmed. */
async function handleRetry(admin: SupabaseClient, user: { id: string }, body: Record<string, unknown>) {
  const jobId = body.jobId;
  if (!isUuid(jobId)) return respond(400, { error: "任务编号无效" });
  if (await maintenanceEnabled(admin)) {
    return respond(503, { error: "极汪正在维护，暂不接受重新生成；本次未开始生成，也未扣费。", code: "maintenance", maintenance: true });
  }
  await sweepStaleGenerations(admin);
  const { data: job, error } = await admin.from("generation_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error || !job || job.user_id !== user.id) return respond(404, { error: "任务不存在" });
  if (job.status !== "failed") return respond(409, { error: "只有失败的任务可以重新生成", jobId });
  if (!validateReferencePath(job.reference_path, user.id)) return respond(409, { error: "参考图已不可用，请重新创建任务。", jobId });
  // Reference photos are deleted after USED_REFERENCE_DAYS since the last generation; without one there is no retry.
  const { data: reference, error: referenceError } = await admin
    .from("assets")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "reference")
    .eq("storage_path", job.reference_path)
    .maybeSingle();
  if (referenceError) return respond(500, { error: `无法检查参考图（${safeText(referenceError.message, 160)}）。本次未重新生成，也未扣费。`, jobId });
  if (!reference) {
    return respond(409, {
      error: `参考图已超过 ${USED_REFERENCE_DAYS} 天保留期限并被自动删除，无法重新生成。请重新上传角色图创建新任务。本次未扣费。`,
      code: "reference_missing",
      jobId,
    });
  }

  let model: ModelConfig;
  try {
    model = await currentModel(admin, job.model_id);
  } catch (cause) {
    return respond(409, { error: errorText(cause, "所选模型不可用"), jobId });
  }
  const { error: beginError } = await admin.rpc("worker_begin_retry", {
    p_job_id: jobId,
    p_model_name: model.name,
    p_price_coins: model.priceCoins,
  });
  if (beginError) {
    const admission = admissionFailure(beginError.message);
    if (admission) return respond(admission.status, { error: admission.message, code: admission.code, jobId });
    return respond(409, { error: `无法开始重新生成：${safeText(beginError.message, 160)}。请刷新任务历史后再试。`, jobId });
  }

  // Remove files left by the previous attempt before the new attempt writes its own.
  await cleanupJobArtifacts(admin, user.id, jobId).catch(() => undefined);
  try {
    const outcome = await processJob(admin, { ...(job as GenerationJobRow), status: "queued", model_name: model.name, price_coins: model.priceCoins }, model);
    return respond(200, jobResponse(jobId, outcome));
  } catch (cause) {
    return respond(failureStatus(cause), { error: errorText(cause, "任务重新生成失败"), jobId });
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return respond(500, { error: "生成服务端环境变量未配置；任务尚未创建、模型未调用且未预扣汪币。请管理员检查 Supabase Edge Function 密钥配置。" });
  }

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
  try {
    parsed = await request.json();
  } catch {
    return respond(400, { error: "请求内容不是有效 JSON；任务尚未创建、模型未调用且未预扣汪币。请刷新页面后重试。" });
  }
  const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (body.action === "list_models") {
    try {
      return await handleModelList(admin, userResult.user, body);
    } catch {
      return respond(500, { error: "获取上游模型列表失败" });
    }
  }
  if (body.action === "retry") {
    try {
      return await handleRetry(admin, userResult.user, body);
    } catch (cause) {
      console.error("jiwang-generate retry crashed", { message: errorText(cause, "").slice(0, 300) });
      return respond(500, { error: errorText(cause, "任务重新生成失败") });
    }
  }

  const jobId = body.jobId;
  const modelId = body.modelId;
  const referencePath = safeText(body.referencePath, 512);
  const topic = safeText(body.topic, 160);
  const title = safeText(body.title, 120, "未命名表情套装");
  const cells = validateCells(body.cells);
  const opts = body.options && typeof body.options === "object" ? body.options as Record<string, unknown> : {};
  if (!isUuid(jobId) || !isUuid(modelId) || !referencePath || !topic || !cells) {
    return respond(400, { error: "任务参数不完整或无效：请确认任务编号、模型、主题、参考图和完整 16 格脚本；本次尚未创建任务或预扣汪币。" });
  }
  if (!validateReferencePath(referencePath, userResult.user.id)) {
    return respond(403, { error: "参考图路径无效或不属于当前账号；任务尚未创建、模型未调用且未预扣汪币。请重新上传角色图。" });
  }
  const options: JobOptions = {
    cellCount: CELL_COUNT,
    cells,
    originalStyle: opts.originalStyle === true,
    noText: opts.noText === true,
    whiteBorder: opts.whiteBorder === true,
  };

  await sweepStaleGenerations(admin);

  try {
    const { data: existing, error: existingError } = await admin.from("generation_jobs").select("id,user_id,status").eq("id", jobId).maybeSingle();
    if (existingError) return respond(500, { error: `无法检查重复任务（${safeText(existingError.message, 220)}），任务尚未开始计费。请管理员检查数据库连接和 generation_jobs 权限。` });
    if (existing) {
      if (existing.user_id !== userResult.user.id) return respond(404, { error: "任务不存在" });
      if (existing.status === "completed" || existing.status === "partial") {
        const images = await signedImages(admin, jobId);
        return respond(200, { jobId, status: existing.status, images, deliveredCount: images.length, reused: true });
      }
      return respond(409, { error: `此任务已存在，当前状态为「${existing.status}」；为避免重复扣费，本次没有重新提交。请到任务历史查看该任务。`, jobId });
    }

    if (await maintenanceEnabled(admin)) {
      return respond(503, { error: "极汪正在维护，暂不接受新的生成任务；尚未创建任务，也未预扣汪币。", code: "maintenance", maintenance: true });
    }

    const model = await currentModel(admin, modelId);
    // Creating the job also checks the reference photo, the concurrency cap and the daily cap in one transaction.
    // If any check fails nothing is inserted and nothing is charged.
    const { error: admitError } = await admin.rpc("worker_create_generation_job", {
      p_job_id: jobId,
      p_user_id: userResult.user.id,
      p_title: title,
      p_topic: topic,
      p_model_id: model.id,
      p_model_name: model.name,
      p_price_coins: model.priceCoins,
      p_reference_path: referencePath,
      p_options: options,
    });
    if (admitError) {
      const admission = admissionFailure(admitError.message);
      if (admission) return respond(admission.status, { error: admission.message, code: admission.code });
      const duplicate = admitError.code === "23505";
      return respond(duplicate ? 409 : 500, {
        error: duplicate
          ? "任务编号已使用，尚未启动模型调用。请返回工坊重新发起任务。"
          : `无法创建生成任务（${safeText(admitError.message, 220)}），模型调用尚未开始且未预扣汪币。请管理员检查 generation_jobs 表、数据库连接和权限。`,
      });
    }

    const outcome = await processJob(admin, {
      id: jobId,
      user_id: userResult.user.id,
      title,
      topic,
      status: "queued",
      model_id: model.id,
      model_name: model.name,
      price_coins: model.priceCoins,
      reference_path: referencePath,
      options,
    }, model);
    return respond(200, jobResponse(jobId, outcome));
  } catch (cause) {
    const message = errorText(cause, "生成失败，请稍后重试");
    // Server-side breadcrumb; the message has already been sanitised and never contains credentials.
    console.error("jiwang-generate failed", { jobId: isUuid(jobId) ? jobId : undefined, message: message.slice(0, 300) });
    return respond(failureStatus(cause), { error: message, jobId: isUuid(jobId) ? jobId : undefined });
  }
});
