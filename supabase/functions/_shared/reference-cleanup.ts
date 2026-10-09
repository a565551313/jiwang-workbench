// 过期参考图清理：先通过 Storage API 删除文件，再删除数据库记录。
// 被 jiwang-generate（生成请求时顺带清理一小批）与 jiwang-cleanup（定时任务）共用。
//
// 注意：直接删除 storage.objects 中的行不会删除文件，只会留下孤儿文件，因此必须走 Storage API。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const REFERENCE_BUCKET = "jiwang-private";

/**
 * Delete up to `maxRounds` batches of expired reference photos. If a round fails, the error is thrown and the same
 * rows are retried by the next run. Returns how many photos were removed.
 */
export async function cleanupExpiredReferences(admin: SupabaseClient, maxRounds: number, batchSize: number): Promise<number> {
  let removed = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const { data, error } = await admin.rpc("worker_expired_reference_images", { p_limit: batchSize });
    if (error) throw new Error(`读取过期参考图失败：${shortMessage(error.message)}`);
    const rows = Array.isArray(data) ? data as Array<{ result_storage_path: string }> : [];
    if (rows.length === 0) break;
    const paths = rows.map((row) => row.result_storage_path);
    const { error: removeError } = await admin.storage.from(REFERENCE_BUCKET).remove(paths);
    if (removeError) throw new Error(`删除过期参考图文件失败：${shortMessage(removeError.message)}`);
    const { error: rowsError } = await admin.rpc("worker_delete_reference_rows", { p_paths: paths });
    if (rowsError) throw new Error(`清理过期参考图记录失败：${shortMessage(rowsError.message)}`);
    removed += paths.length;
    if (rows.length < batchSize) break;
  }
  return removed;
}

function shortMessage(text: unknown): string {
  return typeof text === "string" ? text.slice(0, 160) : "未知错误";
}
