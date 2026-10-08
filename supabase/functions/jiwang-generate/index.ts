import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type DraftCell = { caption: string; visual: string };
type ImageApiProtocol = "responses" | "chat_completions" | "legacy_image_edits";
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
  legacy?: boolean;
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
  const parsed = new URL(raw);
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
    const bytes = bytesFromBase64(encoded);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("模型返回的单张图为空或超过 10 MB 限制");
    const contentType = typeof data.content_type === "string" && /^image\/(png|jpeg|webp)$/.test(data.content_type) ? data.content_type : "image/png";
    return { bytes, contentType };
  }
  const nestedUrl = data.image_url && typeof data.image_url === "object" ? (data.image_url as Record<string, unknown>).url : undefined;
  const urlText = typeof data.url === "string" ? data.url : nestedUrl;
  if (typeof urlText === "string") {
    const dataUrl = urlText.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (dataUrl) return await imageFromResponse({ b64_json: dataUrl[2], content_type: dataUrl[1] });
    const imageUrl = new URL(urlText);
    if (imageUrl.protocol !== "https:" || isNonPublicAddress(imageUrl.hostname)) throw new Error("模型返回了不安全的图片地址");
    const response = await fetch(imageUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
    if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error("模型返回了不支持的图片格式");
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

async function imageFromChatCompletion(payload: Record<string, unknown>): Promise<ImagePayload> {
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
  for (const candidate of imageCandidates) {
    try { return await imageFromResponse(candidate); } catch { /* Try the next advertised image candidate. */ }
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
  throw new Error("Chat Completions 未返回可用图像；请确认该上游模型支持图像输出");
}

async function callImageModel(endpoint: string, apiKey: string, model: ModelConfig, reference: Blob, prompt: string): Promise<ImagePayload> {
  const referenceExtension = reference.type === "image/jpeg" ? "jpg" : reference.type === "image/webp" ? "webp" : "png";
  const referenceUrl = `data:${reference.type || "image/png"};base64,${base64FromBytes(new Uint8Array(await reference.arrayBuffer()))}`;
  if (model.protocol === "responses") {
    const response = await fetch(`${endpoint}/responses`, {
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
    if (!response.ok) throw new Error(`Responses API 请求失败（${response.status}）；请检查协议及模型 ID`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("Responses API 返回的不是有效 JSON"); }
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const output = Array.isArray(root.output) ? root.output : [];
    const imageCall = output.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "image_generation_call") as Record<string, unknown> | undefined;
    if (typeof imageCall?.result === "string") return await imageFromResponse({ b64_json: imageCall.result });
    const dataRows = Array.isArray(root.data) ? root.data : [];
    const first = dataRows.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    if (first) return await imageFromResponse(first);
    throw new Error("Responses API 未返回图像结果");
  }

  if (model.protocol === "legacy_image_edits") {
    const form = new FormData();
    form.append("model", model.name);
    form.append("prompt", prompt);
    form.append("image[]", reference, `reference-image.${referenceExtension}`);
    form.append("n", "1");
    form.append("size", "1024x1024");
    const response = await fetch(`${endpoint}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) throw new Error(`模型 ${model.name} 请求失败（${response.status}）`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("模型返回的不是有效 JSON"); }
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const rows = Array.isArray(root.data) ? root.data : [];
    const first = rows.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    if (!first) throw new Error("模型没有返回图像数据");
    return await imageFromResponse(first);
  }

  const response = await fetch(`${endpoint}/chat/completions`, {
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
  if (!response.ok) throw new Error(`Chat Completions 请求失败（${response.status}）；请检查协议及模型 ID`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Chat Completions 返回的不是有效 JSON"); }
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return await imageFromChatCompletion(root);
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
  await admin.rpc("worker_fail_generation", { p_job_id: jobId, p_worker_token: workerToken, p_error: message.slice(0, 900) });
  const { data: rows } = await admin.from("assets").select("storage_path").eq("job_id", jobId).eq("kind", "sticker");
  const paths = (rows ?? []).map((row: { storage_path: string }) => row.storage_path);
  await admin.from("assets").delete().eq("job_id", jobId).eq("kind", "sticker");
  const cleanupPaths = [...new Set([...paths, ...uploadedPaths])];
  if (cleanupPaths.length) await admin.storage.from(IMAGE_BUCKET).remove(cleanupPaths);
}

async function processJob(admin: SupabaseClient, job: GenerationJobRow, model: ModelConfig, promptTemplate: string) {
  const workerToken = crypto.randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc("worker_claim_generation", {
    p_job_id: job.id,
    p_worker_token: workerToken,
  });
  if (claimError) {
    await admin.from("generation_jobs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: "生成任务无法启动，请稍后重试" })
      .eq("id", job.id).eq("status", "queued");
    throw new Error("生成任务无法启动，请稍后重试");
  }
  if (!claimed) throw new Error("该任务正在处理中或已完成，请勿重复提交");

  const storedPaths: string[] = [];
  let balanceAfterReserve = 0;
  try {
    const secretResult = model.legacy
      ? await admin.rpc("worker_get_image_model_api_key", { p_model_id: model.id })
      : await admin.rpc("worker_get_image_provider_api_key", { p_provider_id: model.providerId });
    const { data: secret, error: secretError } = secretResult;
    if (secretError || typeof secret !== "string" || !secret) throw new Error("此模型未启用或尚未配置 API Key");

    const { data: reserved, error: reserveError } = await admin.rpc("worker_reserve_generation_coins", {
      p_job_id: job.id,
      p_worker_token: workerToken,
    });
    if (reserveError) {
      if (reserveError.message.toLowerCase().includes("insufficient wallet balance")) {
        throw new Error("汪币余额不足，请选择价格更低的模型或先充值");
      }
      throw new Error(reserveError.message);
    }
    balanceAfterReserve = Number(reserved ?? 0);

    if (!validateReferencePath(job.reference_path, job.user_id)) throw new Error("角色参考图路径无效");
    const { data: reference, error: referenceError } = await admin.storage.from(IMAGE_BUCKET).download(job.reference_path);
    if (referenceError || !reference) throw new Error("无法读取已上传的角色参考图");
    if (reference.size === 0 || reference.size > 12 * 1024 * 1024) throw new Error("角色参考图为空或超过 12 MB");
    const referenceType = reference.type || "image/png";
    if (!/^image\/(png|jpeg|webp)$/.test(referenceType)) throw new Error("角色参考图格式不受支持");
    const apiEndpoint = safeEndpoint(model.endpoint);
    const { data: promptRow } = await admin.from("admin_settings").select("value").eq("setting_key", "prompts").maybeSingle();
    const template = typeof promptRow?.value?.sticker === "string" ? promptRow.value.sticker : DEFAULT_PROMPT;
    const options = job.options;
    const cells = validateCells(options?.cells);
    if (!cells || options?.cellCount !== 16) throw new Error("任务脚本不完整，必须包含 16 格描述");

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
        if (uploadError) throw uploadError;
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
      if (assetError) throw assetError;
      const { error: insertError } = await admin.from("assets").insert(rows);
      if (insertError) throw insertError;
      const progress = Math.min(95, 20 + Math.round(((start + outputs.length) / 16) * 75));
      const { error: progressError } = await admin.rpc("worker_update_generation_progress", {
        p_job_id: job.id,
        p_worker_token: workerToken,
        p_progress: progress,
      });
      if (progressError) throw progressError;
    }
    const { error: completeError } = await admin.rpc("worker_complete_generation", {
      p_job_id: job.id,
      p_worker_token: workerToken,
    });
    if (completeError) throw completeError;
  } catch (error) {
    await failJob(admin, job.id, workerToken, error, storedPaths);
    throw error;
  }
  return { images: await signedImages(admin, job.id), balance: balanceAfterReserve };
}

async function currentModel(admin: SupabaseClient, modelId: string): Promise<ModelConfig> {
  const { data, error } = await admin.from("admin_settings").select("value").eq("setting_key", "model").maybeSingle();
  if (error) throw new Error(error.message);
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

  // Transitional read support lets the newly deployed function continue working before the data migration is applied.
  const legacyModels = Array.isArray(value.models) ? value.models as Array<Record<string, unknown>> : [];
  const legacy = legacyModels.find((item) => item.id === modelId);
  if (!legacy) throw new Error("所选模型不存在或配置格式已更新");
  const legacyModel: ModelConfig = {
    id: String(legacy.id || ""),
    providerId: String(legacy.id || ""),
    provider: safeText(legacy.provider, 160),
    protocol: "legacy_image_edits",
    name: safeText(legacy.name, 160),
    endpoint: safeText(legacy.endpoint, 2048),
    enabled: legacy.enabled === true,
    priceCoins: Number(legacy.priceCoins),
    secretConfigured: legacy.secretConfigured === true,
    legacy: true,
  };
  if (!legacyModel.enabled || !legacyModel.secretConfigured) throw new Error("所选模型已停用或未配置 API Key");
  if (!Number.isInteger(legacyModel.priceCoins) || legacyModel.priceCoins < 1 || legacyModel.priceCoins > 100000) throw new Error("该模型尚未设置有效汪币价格");
  if (!safeText(legacyModel.name, 160) || !isUuid(legacyModel.id)) throw new Error("模型配置无效");
  return legacyModel;
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
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return respond(500, { error: "生成服务未配置" });

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
  if (userError || !userResult.user) return respond(401, { error: "登录状态无效，请重新登录" });

  let parsed: unknown;
  try { parsed = await request.json(); } catch { return respond(400, { error: "请求 JSON 无效" }); }
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
  if (!isUuid(jobId) || !isUuid(modelId) || !referencePath || !topic || !cells) return respond(400, { error: "任务参数不完整或无效" });
  if (!validateReferencePath(referencePath, userResult.user.id)) return respond(403, { error: "不能读取其他用户的参考图" });
  const options: JobOptions = {
    cellCount: 16,
    cells,
    originalStyle: opts.originalStyle === true,
    noText: opts.noText === true,
    whiteBorder: opts.whiteBorder === true,
  };

  try {
    const { data: existing, error: existingError } = await admin.from("generation_jobs").select("id,user_id,status").eq("id", jobId).maybeSingle();
    if (existingError) return respond(500, { error: existingError.message });
    if (existing) {
      if (existing.user_id !== userResult.user.id) return respond(404, { error: "任务不存在" });
      if (existing.status === "completed") return respond(200, { jobId, images: await signedImages(admin, jobId), reused: true });
      return respond(409, { error: "此任务已提交或正在处理，请稍后查看任务记录", jobId });
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
    if (insertError) return respond(409, { error: "任务编号已使用，请重新发起生成" });

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
