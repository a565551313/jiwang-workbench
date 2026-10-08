import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { cleanupExpiredReferences } from "../_shared/reference-cleanup.ts";

// 定时清理入口：由 pg_cron 经 pg_net 每天调用一次，删除超过保留期限的参考图。
//
// 部署时必须使用 --no-verify-jwt：定时调用没有用户登录令牌，也不能把密钥放在 Authorization 里
// （新版 sb_secret_ 密钥不是 JWT）。因此本函数自己校验 x-cleanup-secret 请求头，口令保存在 Vault 中，
// 与 public.worker_cleanup_secret_matches 比对。未通过校验的请求不会做任何删除。
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return respond(500, { error: "清理服务的环境变量未配置" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authorized, error: authError } = await admin.rpc("worker_cleanup_secret_matches", {
    p_candidate: request.headers.get("x-cleanup-secret") || "",
  });
  if (authError) return respond(500, { error: "无法校验清理口令" });
  if (authorized !== true) return respond(401, { error: "清理请求未通过校验" });

  try {
    const removed = await cleanupExpiredReferences(admin, 20, 100);
    return respond(200, { removed });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 300) : "清理过期参考图失败";
    console.error("jiwang-cleanup failed", { message });
    return respond(500, { error: message });
  }
});
