-- 生成任务恢复、按尝试记账与部分交付结算。
-- 1) 每次“重新生成”都是新的尝试：扣费与退款按 (任务, 类型, 尝试号) 唯一记账，旧尝试的退款不再阻挡重试。
-- 2) 按实际交付张数结算：应收 = ceil(单价 × 交付张数 ÷ 16)，未交付部分原子退回；满 16 张正好等于单价。
-- 3) 超时或中断的任务由 worker_reap_stale_generations 自动结算；可用 pg_cron 定时调用，未启用时由 Edge Function 顺带回收。
-- 4) 供应商 API Key 与 Base URL 绑定：修改地址后必须重新保存密钥，旧密钥不会再发往新地址。
-- 5) 用户不能再直接写入素材表；前台功能开关通过只读 RPC 暴露。

-- ---------------------------------------------------------------------------
-- 表结构
-- ---------------------------------------------------------------------------
alter table public.generation_jobs
  add column if not exists attempt integer not null default 1 check (attempt >= 1),
  add column if not exists completed_count integer not null default 0 check (completed_count between 0 and 16),
  add column if not exists queued_at timestamptz not null default now();

alter table public.generation_jobs drop constraint if exists generation_jobs_status_check;
alter table public.generation_jobs
  add constraint generation_jobs_status_check
  check (status in ('queued', 'processing', 'completed', 'partial', 'failed'));

alter table public.wallet_transactions
  add column if not exists attempt integer check (attempt is null or attempt >= 1);

update public.wallet_transactions
   set attempt = 1
 where generation_job_id is not null and attempt is null;

alter table public.wallet_transactions drop constraint if exists wallet_transactions_generation_attempt_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_generation_attempt_check
  check (generation_job_id is null or attempt is not null);

drop index if exists public.wallet_transactions_generation_once_uidx;
create unique index if not exists wallet_transactions_generation_attempt_uidx
  on public.wallet_transactions(generation_job_id, transaction_type, attempt)
  where generation_job_id is not null;

-- ---------------------------------------------------------------------------
-- 内部辅助函数（不授予任何 API 角色执行权限，只供其它 security definer 函数调用）
-- ---------------------------------------------------------------------------
create or replace function public.normalize_provider_base_url(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(trim(coalesce(p_url, '')), '/+$', '')
$$;

create or replace function public.generation_attempt_charge(p_job_id uuid, p_attempt integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(-t.amount), 0)::integer
    from public.wallet_transactions t
   where t.generation_job_id = p_job_id
     and t.transaction_type = 'generation_charge'
     and t.attempt = p_attempt
$$;

create or replace function public.refund_generation_attempt(p_job_id uuid, p_attempt integer, p_amount integer, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_user uuid;
begin
  if p_amount is null or p_amount <= 0 then
    return 0;
  end if;
  if exists (
    select 1
      from public.wallet_transactions t
     where t.generation_job_id = p_job_id
       and t.transaction_type = 'generation_refund'
       and t.attempt = p_attempt
  ) then
    return 0;
  end if;
  select j.user_id into job_user from public.generation_jobs j where j.id = p_job_id;
  if job_user is null then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;
  insert into public.wallet_balances(user_id, balance) values (job_user, 0)
    on conflict (user_id) do nothing;
  update public.wallet_balances
     set balance = balance + p_amount,
         updated_at = now()
   where user_id = job_user;
  insert into public.wallet_transactions(user_id, actor_id, amount, note, generation_job_id, transaction_type, attempt)
  values (job_user, null, p_amount, left(coalesce(p_note, '图像生成汪币退回'), 240), p_job_id, 'generation_refund', p_attempt);
  return p_amount;
end;
$$;

-- 按已交付张数结算当前尝试：满 16 张全额保留；部分交付按比例保留；零交付全额退回。
create or replace function public.settle_generation_job(p_job_id uuid, p_note text)
returns table(result_status text, result_delivered integer, result_refunded integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.generation_jobs%rowtype;
  delivered_now integer;
  charged integer;
  kept integer;
  refunded_now integer;
  final_status text;
  final_note text;
begin
  select * into job from public.generation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;
  if job.status <> 'processing' then
    raise exception 'generation job is not processing' using errcode = '22023';
  end if;

  select count(distinct a.cell_index)::integer into delivered_now
    from public.assets a
   where a.job_id = p_job_id
     and a.kind = 'sticker'
     and a.cell_index is not null;
  charged := public.generation_attempt_charge(p_job_id, job.attempt);

  if delivered_now >= 16 then
    final_status := 'completed';
    kept := charged;
    final_note := null;
  elsif delivered_now >= 1 then
    final_status := 'partial';
    kept := ((charged * delivered_now) + 15) / 16;
    final_note := format('部分交付：已交付 %s/16 张，未交付的 %s 张已退回 %s 汪币。', delivered_now, 16 - delivered_now, charged - kept);
  else
    final_status := 'failed';
    kept := 0;
    final_note := '未生成任何图片，已退回全部预扣汪币。';
  end if;

  refunded_now := public.refund_generation_attempt(
    p_job_id,
    job.attempt,
    charged - kept,
    case final_status
      when 'failed' then '图像生成失败退回汪币：' || coalesce(nullif(p_note, ''), '未知错误')
      when 'partial' then '部分交付结算：退回未交付部分。' || coalesce(nullif(p_note, ''), '')
      else '图像生成完成'
    end
  );

  update public.generation_jobs
     set status = final_status,
         completed_count = delivered_now,
         progress = case when final_status = 'failed' then progress else 100 end,
         finished_at = now(),
         worker_token = null,
         error_message = case
           when final_status = 'completed' then null
           when final_status = 'partial' then left(concat_ws(chr(10), final_note, nullif(p_note, '')), 1000)
           else left(coalesce(nullif(p_note, ''), final_note), 1000)
         end
   where id = p_job_id;

  result_status := final_status;
  result_delivered := delivered_now;
  result_refunded := refunded_now;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 服务端任务生命周期（仅 service_role，Edge Function 与 pg_cron 调用）
-- ---------------------------------------------------------------------------
create or replace function public.worker_claim_generation(p_job_id uuid, p_worker_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  update public.generation_jobs
     set status = 'processing',
         worker_token = p_worker_token,
         worker_started_at = now(),
         progress = greatest(progress, 1),
         error_message = null,
         finished_at = null
   where id = p_job_id
     and status = 'queued'
   returning id into claimed;
  return claimed is not null;
end;
$$;

create or replace function public.worker_reserve_generation_coins(p_job_id uuid, p_worker_token uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.generation_jobs%rowtype;
  balance_now bigint;
  charge_amount integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select * into job from public.generation_jobs where id = p_job_id for update;
  if not found or job.status <> 'processing' or job.worker_token is distinct from p_worker_token then
    raise exception 'generation job claim is invalid' using errcode = '42501';
  end if;
  if job.price_coins is null or job.price_coins < 1 or job.price_coins > 100000 then
    raise exception 'invalid generation price' using errcode = '22023';
  end if;
  charge_amount := job.price_coins;

  -- 同一尝试只预扣一次；重复调用返回当前余额。
  if exists (
    select 1 from public.wallet_transactions t
     where t.generation_job_id = p_job_id
       and t.transaction_type = 'generation_charge'
       and t.attempt = job.attempt
  ) then
    select w.balance into balance_now from public.wallet_balances w where w.user_id = job.user_id;
    return coalesce(balance_now, 0);
  end if;

  insert into public.wallet_balances(user_id, balance) values (job.user_id, 0)
    on conflict (user_id) do nothing;
  select w.balance into balance_now from public.wallet_balances w where w.user_id = job.user_id for update;
  if balance_now < charge_amount then
    raise exception 'insufficient wallet balance' using errcode = 'P0001';
  end if;
  update public.wallet_balances
     set balance = balance - charge_amount,
         updated_at = now()
   where user_id = job.user_id
   returning balance into balance_now;
  insert into public.wallet_transactions(user_id, actor_id, amount, note, generation_job_id, transaction_type, attempt)
  values (job.user_id, null, -charge_amount, left('图像生成汪币预扣：' || job.title, 240), job.id, 'generation_charge', job.attempt);
  return balance_now;
end;
$$;

drop function if exists public.worker_update_generation_progress(uuid, uuid, integer);
create or replace function public.worker_update_generation_progress(p_job_id uuid, p_worker_token uuid, p_progress integer, p_completed_count integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  update public.generation_jobs
     set progress = least(greatest(coalesce(p_progress, 0), 1), 99),
         completed_count = least(greatest(coalesce(p_completed_count, 0), 0), 16)
   where id = p_job_id
     and status = 'processing'
     and worker_token = p_worker_token;
  if not found then
    raise exception 'generation job claim is invalid' using errcode = '42501';
  end if;
end;
$$;

drop function if exists public.worker_complete_generation(uuid, uuid);
create or replace function public.worker_complete_generation(p_job_id uuid, p_worker_token uuid, p_note text default null)
returns table(result_status text, result_delivered integer, result_refunded integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  perform 1
    from public.generation_jobs j
   where j.id = p_job_id
     and j.status = 'processing'
     and j.worker_token = p_worker_token
   for update;
  if not found then
    raise exception 'generation job claim is invalid' using errcode = '42501';
  end if;
  return query select * from public.settle_generation_job(p_job_id, p_note);
end;
$$;

create or replace function public.worker_fail_generation(p_job_id uuid, p_worker_token uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.generation_jobs%rowtype;
  charged integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select * into job from public.generation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;
  -- 幂等：已经失败并完成退款的任务再次收到失败回调时不做任何事。
  if job.status = 'failed' then
    return;
  end if;
  if job.status in ('completed', 'partial') then
    raise exception 'generation job is already settled' using errcode = '22023';
  end if;
  if job.status <> 'processing' or job.worker_token is distinct from p_worker_token then
    raise exception 'generation job claim is invalid' using errcode = '42501';
  end if;

  charged := public.generation_attempt_charge(p_job_id, job.attempt);
  perform public.refund_generation_attempt(
    p_job_id,
    job.attempt,
    charged,
    '图像生成失败退回汪币：' || coalesce(nullif(p_error, ''), '未知错误')
  );
  update public.generation_jobs
     set status = 'failed',
         completed_count = 0,
         finished_at = now(),
         worker_token = null,
         error_message = left(coalesce(nullif(p_error, ''), '生成失败'), 1000)
   where id = p_job_id;
end;
$$;

-- 管理员已取消“代为重试”；失败任务只能由任务所有者在确认价格后重新生成。
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

-- 回收超时任务：processing 按已交付张数结算；queued 从未启动，直接结束且无需退款。
-- pg_cron 与 Edge Function 都调用它；它不检查 JWT，因此只能通过 service_role/数据库所有者执行。
create or replace function public.worker_reap_stale_generations(p_stale_minutes integer default 10, p_limit integer default 50)
returns table(result_job_id uuid, result_user_id uuid, result_status text, result_refunded integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  stale record;
  settled record;
  stale_minutes integer := greatest(coalesce(p_stale_minutes, 10), 1);
  threshold interval;
begin
  threshold := make_interval(mins => stale_minutes);
  for stale in
    select j.id, j.user_id, j.status
      from public.generation_jobs j
     where (j.status = 'processing' and j.worker_started_at < now() - threshold)
        or (j.status = 'queued' and j.queued_at < now() - threshold)
     order by coalesce(j.worker_started_at, j.queued_at)
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
     for update skip locked
  loop
    if stale.status = 'queued' then
      update public.generation_jobs
         set status = 'failed',
             completed_count = 0,
             finished_at = now(),
             worker_token = null,
             error_message = '任务长时间没有启动，服务端已自动结束；尚未预扣汪币，无需退款。'
       where id = stale.id;
      result_job_id := stale.id;
      result_user_id := stale.user_id;
      result_status := 'failed';
      result_refunded := 0;
      return next;
    else
      select s.result_status, s.result_refunded into settled
        from public.settle_generation_job(
          stale.id,
          format('任务超过 %s 分钟没有完成，服务端已自动结算。', stale_minutes)
        ) s;
      result_job_id := stale.id;
      result_user_id := stale.user_id;
      result_status := settled.result_status;
      result_refunded := settled.result_refunded;
      return next;
    end if;
  end loop;
  return;
end;
$$;

-- 每 5 分钟回收一次。未安装 pg_cron 时只输出提示；生成请求仍会顺带回收。
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'jiwang-reap-generations',
    '*/5 * * * *',
    $cron$select * from public.worker_reap_stale_generations()$cron$
  );
exception when others then
  raise notice '未能启用 pg_cron（%）；超时任务将由生成请求顺带回收。', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 供应商密钥与 Base URL 绑定
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_image_provider_api_key(p_provider_id uuid, p_api_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
  existing_url_secret_id uuid;
  provider_base_url text;
  secret_name text;
  url_secret_name text;
  updated_providers jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if p_provider_id is null or p_api_key is null or length(trim(p_api_key)) < 8 or length(p_api_key) > 8192 then
    raise exception 'invalid provider id or API key length' using errcode = '22023';
  end if;

  select public.normalize_provider_base_url(p.item ->> 'baseUrl') into provider_base_url
    from public.admin_settings s,
         jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) as p(item)
   where s.setting_key = 'model'
     and p.item ->> 'id' = p_provider_id::text
   limit 1;
  if provider_base_url is null then
    raise exception 'provider configuration not found' using errcode = '22023';
  end if;
  if provider_base_url not like 'https://%' then
    raise exception 'provider base URL must be HTTPS before an API key is saved' using errcode = '22023';
  end if;

  secret_name := 'jiwang-image-provider-' || p_provider_id::text;
  url_secret_name := 'jiwang-image-provider-url-' || p_provider_id::text;

  select s.id into existing_secret_id
    from vault.secrets s
   where s.name = secret_name
   order by s.created_at desc
   limit 1;
  if existing_secret_id is null then
    perform vault.create_secret(trim(p_api_key), secret_name, '极汪供应商 ' || p_provider_id::text || ' API Key');
  else
    perform vault.update_secret(existing_secret_id, trim(p_api_key), secret_name, '极汪供应商 ' || p_provider_id::text || ' API Key');
  end if;

  select s.id into existing_url_secret_id
    from vault.secrets s
   where s.name = url_secret_name
   order by s.created_at desc
   limit 1;
  if existing_url_secret_id is null then
    perform vault.create_secret(provider_base_url, url_secret_name, '极汪供应商 ' || p_provider_id::text || ' API Base URL 绑定');
  else
    perform vault.update_secret(existing_url_secret_id, provider_base_url, url_secret_name, '极汪供应商 ' || p_provider_id::text || ' API Base URL 绑定');
  end if;

  select jsonb_agg(
    case when p.item ->> 'id' = p_provider_id::text
      then jsonb_set(p.item, '{secretConfigured}', 'true'::jsonb, true)
      else p.item end
    order by p.ordinality
  ) into updated_providers
  from public.admin_settings s,
       jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) with ordinality as p(item, ordinality)
  where s.setting_key = 'model';

  update public.admin_settings
     set value = jsonb_set(value, '{providers}', coalesce(updated_providers, '[]'::jsonb), true),
         updated_at = now(),
         updated_by = auth.uid()
   where setting_key = 'model';
end;
$$;

drop function if exists public.worker_get_image_provider_api_key(uuid);
create or replace function public.worker_get_image_provider_api_key(p_provider_id uuid, p_base_url text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  result text;
  bound_url text;
  configured boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select exists (
    select 1
      from public.admin_settings s,
           jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) as p(item)
     where s.setting_key = 'model'
       and p.item ->> 'id' = p_provider_id::text
       and p.item ->> 'secretConfigured' = 'true'
  ) into configured;
  if not configured then
    raise exception 'provider has no configured secret' using errcode = '22023';
  end if;

  -- 密钥只会发往保存时绑定的 Base URL；修改地址后必须重新保存密钥。
  select d.decrypted_secret into bound_url
    from vault.decrypted_secrets d
   where d.name = 'jiwang-image-provider-url-' || p_provider_id::text
   order by d.created_at desc
   limit 1;
  if bound_url is null or bound_url <> public.normalize_provider_base_url(p_base_url) then
    raise exception 'provider endpoint changed; API key must be saved again' using errcode = '22023';
  end if;

  select d.decrypted_secret into result
    from vault.decrypted_secrets d
   where d.name = 'jiwang-image-provider-' || p_provider_id::text
   order by d.created_at desc
   limit 1;
  if result is null then
    raise exception 'provider secret not found' using errcode = '22023';
  end if;
  return result;
end;
$$;

-- 为升级前已保存密钥的供应商补上绑定，绑定值取迁移时的 Base URL。
-- 若升级前曾修改过 Base URL，请在后台重新保存该供应商的 API Key。
do $$
declare
  provider_row jsonb;
  provider_id text;
  bound_base_url text;
begin
  for provider_row in
    select p.item
      from public.admin_settings s,
           jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) as p(item)
     where s.setting_key = 'model'
  loop
    provider_id := provider_row ->> 'id';
    continue when coalesce(provider_row ->> 'secretConfigured', 'false') <> 'true';
    continue when provider_id is null or provider_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
    continue when not exists (select 1 from vault.secrets v where v.name = 'jiwang-image-provider-' || provider_id);
    continue when exists (select 1 from vault.secrets v where v.name = 'jiwang-image-provider-url-' || provider_id);
    bound_base_url := public.normalize_provider_base_url(provider_row ->> 'baseUrl');
    continue when bound_base_url not like 'https://%';
    perform vault.create_secret(
      bound_base_url,
      'jiwang-image-provider-url-' || provider_id,
      '极汪供应商 ' || provider_id || ' API Base URL 绑定'
    );
  end loop;
end;
$$;

-- 只有“已保存密钥且 Base URL 仍与绑定一致”的模型才会出现在前台。
create or replace function public.public_enabled_image_models()
returns table(id uuid, provider text, name text, price_coins integer)
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when coalesce(m.item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then (m.item ->> 'id')::uuid else null
         end,
         coalesce(p.item ->> 'name', ''),
         coalesce(m.item ->> 'name', ''),
         case when coalesce(m.item ->> 'priceCoins', '') ~ '^[1-9][0-9]{0,5}$'
           then (m.item ->> 'priceCoins')::integer else null end
    from public.admin_settings s,
         jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) as p(item),
         jsonb_array_elements(coalesce(p.item -> 'models', '[]'::jsonb)) as m(item)
   where s.setting_key = 'model'
     and coalesce(p.item ->> 'secretConfigured', 'false') = 'true'
     and coalesce(m.item ->> 'enabled', 'false') = 'true'
     and coalesce(m.item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and case
       when coalesce(m.item ->> 'priceCoins', '') ~ '^[1-9][0-9]{0,5}$'
       then (m.item ->> 'priceCoins')::integer between 1 and 100000 else false end
     and coalesce(m.item ->> 'name', '') <> ''
     and coalesce(p.item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and exists (
       select 1 from vault.secrets v
        where v.name = 'jiwang-image-provider-' || (p.item ->> 'id')
     )
     and exists (
       select 1 from vault.decrypted_secrets d
        where d.name = 'jiwang-image-provider-url-' || (p.item ->> 'id')
          and d.decrypted_secret = public.normalize_provider_base_url(p.item ->> 'baseUrl')
     );
$$;

-- ---------------------------------------------------------------------------
-- 管理后台任务列表：返回真实交付数、尝试号和错误说明（替代旧的 cellCount 推断）。
-- ---------------------------------------------------------------------------
drop function if exists public.admin_list_jobs_with_model(integer);
create function public.admin_list_jobs_with_model(p_limit integer default 50)
returns table(job_id uuid, user_email text, title text, topic text, status text, created_at timestamptz, finished_at timestamptz, completed_count integer, attempt integer, model_name text, price_coins integer, error_message text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  return query
  select j.id, u.email::text, j.title, j.topic, j.status, j.created_at, j.finished_at,
         j.completed_count, j.attempt, j.model_name, j.price_coins, j.error_message
    from public.generation_jobs j
    left join auth.users u on u.id = j.user_id
   order by j.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- ---------------------------------------------------------------------------
-- 前台功能开关（只读，匿名可读；管理后台仍由 admin_settings 的 RLS 保护）。
-- ---------------------------------------------------------------------------
create or replace function public.public_site_features()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  features jsonb;
begin
  select s.value into features from public.admin_settings s where s.setting_key = 'features';
  features := coalesce(features, '{}'::jsonb);
  return jsonb_build_object(
    'signup', coalesce(features ->> 'signup', 'true') <> 'false',
    'customThemes', coalesce(features ->> 'customThemes', 'true') <> 'false',
    'maintenance', coalesce(features ->> 'maintenance', 'false') = 'true'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 素材表：用户只能登记自己的参考图；生成结果只能由服务端写入。
-- ---------------------------------------------------------------------------
drop policy if exists "assets manage own" on public.assets;
drop policy if exists "assets read own" on public.assets;
create policy "assets read own" on public.assets
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "assets insert own reference" on public.assets;
create policy "assets insert own reference" on public.assets
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and kind = 'reference'
    and job_id is null
    and storage_path like ((select auth.uid())::text || '/references/%')
  );
drop policy if exists "assets delete own reference" on public.assets;
create policy "assets delete own reference" on public.assets
  for delete to authenticated
  using ((select auth.uid()) = user_id and kind = 'reference');

revoke all on public.assets from anon, authenticated;
grant select on public.assets to authenticated;
grant insert (user_id, kind, name, storage_path, mime_type) on public.assets to authenticated;
grant delete on public.assets to authenticated;

-- 旧策略“admin update jobs”依赖已被撤销的 UPDATE 权限，属于无效配置，一并移除。
drop policy if exists "admin update jobs" on public.generation_jobs;

-- 匿名角色不需要任何业务表权限；余额与后台设置只允许经由 RLS/RPC 读写。
revoke all on public.profiles, public.generation_jobs, public.assets, public.admin_settings,
  public.wallet_balances, public.wallet_transactions from anon;
revoke delete on public.admin_settings from authenticated;
revoke insert, update, delete on public.wallet_balances from authenticated;

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
revoke all on function public.normalize_provider_base_url(text) from public, anon, authenticated;
revoke all on function public.generation_attempt_charge(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.refund_generation_attempt(uuid, integer, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.settle_generation_job(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.worker_claim_generation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_reserve_generation_coins(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_update_generation_progress(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.worker_complete_generation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.worker_fail_generation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.worker_begin_retry(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.worker_reap_stale_generations(integer, integer) from public, anon, authenticated;
revoke all on function public.worker_get_image_provider_api_key(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_set_image_provider_api_key(uuid, text) from public, anon;
revoke all on function public.public_enabled_image_models() from public;
revoke all on function public.public_site_features() from public;
revoke all on function public.admin_list_jobs_with_model(integer) from public;

grant execute on function public.worker_claim_generation(uuid, uuid) to service_role;
grant execute on function public.worker_reserve_generation_coins(uuid, uuid) to service_role;
grant execute on function public.worker_update_generation_progress(uuid, uuid, integer, integer) to service_role;
grant execute on function public.worker_complete_generation(uuid, uuid, text) to service_role;
grant execute on function public.worker_fail_generation(uuid, uuid, text) to service_role;
grant execute on function public.worker_begin_retry(uuid, text, integer) to service_role;
grant execute on function public.worker_reap_stale_generations(integer, integer) to service_role;
grant execute on function public.worker_get_image_provider_api_key(uuid, text) to service_role;
grant execute on function public.admin_set_image_provider_api_key(uuid, text) to authenticated;
grant execute on function public.public_enabled_image_models() to anon, authenticated;
grant execute on function public.public_site_features() to anon, authenticated;
grant execute on function public.admin_list_jobs_with_model(integer) to authenticated;
