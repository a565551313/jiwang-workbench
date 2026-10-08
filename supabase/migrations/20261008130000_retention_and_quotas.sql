-- 参考图保留期限、并发与每日开始次数上限。
--
-- 规则（均以服务器时间计算；每日上限按北京时间自然日）：
--   1. 从未用于生成的参考图：上传 7 天后删除。
--   2. 用于生成过的参考图：最后一次使用（包括重新生成）后 30 天删除；删除后不能再点「重新生成」（不扣费）。
--   3. 每位用户同时最多 2 套进行中的任务（queued / processing）。
--   4. 每位用户每个北京时间自然日最多开始 10 套；「重新生成」也计入。
--
-- 注意：删除 storage.objects 表中的行并不会删除存储里的文件（会变成孤儿文件）。
-- 因此本迁移只提供“找出过期记录”和“删除数据库行”的函数；真正删除文件的是 Edge Function
-- jiwang-cleanup（定时）与 jiwang-generate（生成请求时顺带一小批）：先通过 Storage API 删除文件，再调用 worker_delete_reference_rows。

create index if not exists generation_jobs_reference_path_idx on public.generation_jobs(reference_path);

-- 每位用户每个北京时间自然日已开始的任务数。仅供数据库函数读写，客户端不可访问。
create table if not exists public.generation_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  starts integer not null default 0 check (starts >= 0),
  primary key (user_id, usage_date)
);
alter table public.generation_daily_usage enable row level security;
revoke all on public.generation_daily_usage from public, anon, authenticated, service_role;

create or replace function public.generation_day_key()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Shanghai')::date
$$;

-- 开始一套任务前检查并计数。失败时抛出 generation_quota_concurrent 或 generation_quota_daily，整个事务回滚，不会留下计数。
-- 与预扣汪币使用同一把钱包行锁，并发请求不能同时越过上限。
create or replace function public.admit_generation_start(p_user_id uuid, p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  in_progress integer;
  started_today integer;
begin
  insert into public.wallet_balances(user_id, balance) values (p_user_id, 0)
    on conflict (user_id) do nothing;
  perform 1 from public.wallet_balances w where w.user_id = p_user_id for update;

  select count(*)::integer into in_progress
    from public.generation_jobs j
   where j.user_id = p_user_id
     and j.status in ('queued', 'processing')
     and j.id <> p_job_id;
  if in_progress >= 2 then
    raise exception 'generation_quota_concurrent' using errcode = 'P0001';
  end if;

  insert into public.generation_daily_usage (user_id, usage_date, starts)
  values (p_user_id, public.generation_day_key(), 1)
  on conflict (user_id, usage_date) do update
    set starts = public.generation_daily_usage.starts + 1
    where public.generation_daily_usage.starts < 10
  returning starts into started_today;
  if started_today is null then
    raise exception 'generation_quota_daily' using errcode = 'P0001';
  end if;
end;
$$;

-- 创建任务：参考图必须属于该用户且仍存在（过期删除后的参考图不能再用）。
create or replace function public.worker_create_generation_job(
  p_job_id uuid,
  p_user_id uuid,
  p_title text,
  p_topic text,
  p_model_id uuid,
  p_model_name text,
  p_price_coins integer,
  p_reference_path text,
  p_options jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.assets a
     where a.user_id = p_user_id
       and a.kind = 'reference'
       and a.storage_path = p_reference_path
  ) then
    raise exception 'generation_reference_missing' using errcode = 'P0002';
  end if;

  perform public.admit_generation_start(p_user_id, p_job_id);

  insert into public.generation_jobs (
    id, client_request_id, user_id, kind, status, title, topic, model_id, model_name,
    price_coins, reference_path, progress, options
  ) values (
    p_job_id, p_job_id, p_user_id, 'sticker_grid', 'queued', p_title, p_topic, p_model_id, p_model_name,
    p_price_coins, p_reference_path, 0, p_options
  );
end;
$$;

-- 重新生成：在原有规则之外，同样计入并发与每日上限。
create or replace function public.worker_begin_retry(p_job_id uuid, p_model_name text, p_price_coins integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.generation_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select * into job from public.generation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;
  if job.status <> 'failed' then
    raise exception 'only failed generation jobs can be retried' using errcode = '22023';
  end if;
  if p_price_coins is null or p_price_coins < 1 or p_price_coins > 100000 then
    raise exception 'invalid generation price' using errcode = '22023';
  end if;

  perform public.admit_generation_start(job.user_id, p_job_id);

  delete from public.assets where job_id = p_job_id and kind = 'sticker';
  update public.generation_jobs
     set status = 'queued',
         attempt = job.attempt + 1,
         queued_at = now(),
         progress = 0,
         completed_count = 0,
         error_message = null,
         finished_at = null,
         worker_token = null,
         worker_started_at = null,
         model_name = left(coalesce(p_model_name, ''), 160),
         price_coins = p_price_coins
   where id = p_job_id;
  return job.attempt + 1;
end;
$$;

-- 找出应当删除的参考图（只读，不删除）。
-- 未使用：上传超过 7 天；已使用：最后一次使用超过 30 天。
-- “最后一次使用”包括重新生成：每次任务创建或重新排队（queued_at 被更新）都算一次使用，取两者中较晚的时间。
create or replace function public.worker_expired_reference_images(p_limit integer default 100)
returns table (result_user_id uuid, result_storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.user_id, a.storage_path
    from public.assets a
    left join lateral (
      select max(greatest(j.created_at, j.queued_at)) as last_used_at
        from public.generation_jobs j
       where j.reference_path = a.storage_path
    ) u on true
   where a.kind = 'reference'
     and (
       (u.last_used_at is null and a.created_at < now() - interval '7 days')
       or (u.last_used_at is not null and u.last_used_at < now() - interval '30 days')
     )
   order by a.created_at
   limit least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

-- 删除参考图的数据库行。只能在 Storage API 已成功删除这些文件之后调用。
create or replace function public.worker_delete_reference_rows(p_paths text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  delete from public.assets a
   where a.kind = 'reference'
     and a.storage_path = any(coalesce(p_paths, array[]::text[]));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- 定时清理口令比对。口令保存在 Vault（jiwang_cleanup_secret），Edge Function jiwang-cleanup 通过它校验定时调用。
-- 长度至少 32 个字符；不足时视为未配置，拒绝任何清理请求。
create or replace function public.worker_cleanup_secret_matches(p_candidate text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  return exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'jiwang_cleanup_secret'
       and length(s.decrypted_secret) >= 32
       and s.decrypted_secret = p_candidate
  );
end;
$$;

-- 一次性设置（在 SQL Editor 中运行一次，前提是已部署 jiwang-cleanup 且使用 --no-verify-jwt）：
--   1. 在 Vault 中保存 jiwang_project_url（项目网址，形如 https://xxxx.supabase.co，结尾不要加 /）
--   2. 在 Vault 中保存 jiwang_cleanup_secret（至少 32 个字符的随机口令，例如 openssl rand -hex 32 生成）
--   3. 运行 select public.enable_scheduled_cleanup();
-- 之后每天北京时间 03:17 由 pg_cron 通过 pg_net 调用 jiwang-cleanup。
-- 密钥只保存在 Vault 中：cron 命令运行时才读取，不会明文写入 cron.job 表；数据库中不保存 service_role 密钥。
create or replace function public.enable_scheduled_cleanup()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'jiwang_project_url') then
    raise exception '请先在 Vault 中保存名为 jiwang_project_url 的项目网址（形如 https://xxxx.supabase.co，结尾不要加 /）';
  end if;
  if coalesce((select length(decrypted_secret) from vault.decrypted_secrets where name = 'jiwang_cleanup_secret'), 0) < 32 then
    raise exception '请先在 Vault 中保存名为 jiwang_cleanup_secret 的随机口令（至少 32 个字符，例如 openssl rand -hex 32 生成）';
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net;
  perform cron.schedule(
    'jiwang-cleanup-reference-images',
    '17 19 * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'jiwang_project_url') || '/functions/v1/jiwang-cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jiwang_cleanup_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    )
    $cron$
  );
  return '已启用：每天北京时间 03:17 清理过期参考图。';
end;
$$;

-- 权限：内部函数不对外暴露；服务端函数只允许 service_role 调用。
revoke all on function public.generation_day_key() from public, anon, authenticated, service_role;
revoke all on function public.admit_generation_start(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.worker_create_generation_job(uuid, uuid, text, text, uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.worker_begin_retry(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.worker_expired_reference_images(integer) from public, anon, authenticated;
revoke all on function public.worker_delete_reference_rows(text[]) from public, anon, authenticated;
revoke all on function public.worker_cleanup_secret_matches(text) from public, anon, authenticated;
revoke all on function public.enable_scheduled_cleanup() from public, anon, authenticated, service_role;

grant execute on function public.worker_create_generation_job(uuid, uuid, text, text, uuid, text, integer, text, jsonb) to service_role;
grant execute on function public.worker_begin_retry(uuid, text, integer) to service_role;
grant execute on function public.worker_expired_reference_images(integer) to service_role;
grant execute on function public.worker_delete_reference_rows(text[]) to service_role;
grant execute on function public.worker_cleanup_secret_matches(text) to service_role;
