-- Multi-model image generation and server-side wallet settlement.
-- Existing single-model settings and its Vault secret are migrated without exposing the secret.

alter table public.generation_jobs
  add column if not exists model_id uuid,
  add column if not exists model_name text not null default '',
  add column if not exists price_coins integer check (price_coins is null or price_coins >= 0),
  add column if not exists client_request_id uuid,
  add column if not exists reference_path text,
  add column if not exists progress integer not null default 0 check (progress between 0 and 100),
  add column if not exists worker_token uuid,
  add column if not exists worker_started_at timestamptz;

create unique index if not exists generation_jobs_user_request_id_uidx
  on public.generation_jobs(user_id, client_request_id)
  where client_request_id is not null;

alter table public.wallet_transactions
  add column if not exists generation_job_id uuid references public.generation_jobs(id) on delete set null,
  add column if not exists transaction_type text not null default 'adjustment'
    check (transaction_type in ('adjustment', 'generation_charge', 'generation_refund'));

create unique index if not exists wallet_transactions_generation_once_uidx
  on public.wallet_transactions(generation_job_id, transaction_type)
  where generation_job_id is not null;

create or replace function public.admin_list_jobs_with_model(p_limit integer default 50)
returns table(job_id uuid, user_email text, title text, topic text, status text, created_at timestamptz, finished_at timestamptz, asset_count integer, model_name text, price_coins integer)
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
         coalesce(nullif(j.options ->> 'cellCount', '')::integer, 16), j.model_name, j.price_coins
  from public.generation_jobs j
  left join auth.users u on u.id = j.user_id
  order by j.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- The browser no longer writes generation task state. The authenticated Edge Function uses service_role.
drop policy if exists "jobs manage own" on public.generation_jobs;
drop policy if exists "jobs read own" on public.generation_jobs;
create policy "jobs read own" on public.generation_jobs
  for select to authenticated using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.generation_jobs from anon, authenticated;
grant select on public.generation_jobs to authenticated;

revoke insert, update, delete on public.wallet_transactions from anon, authenticated;

-- Preserve the legacy model's ID and existing encrypted key. It remains disabled and unpriced until an admin configures it.
do $$
declare
  old_model jsonb;
  old_secret_id uuid;
  old_secret_value text;
  legacy_model_id constant uuid := 'd9e6fc44-67ef-4b11-9c4d-7f86b8e3025b';
  configured boolean := false;
begin
  select value into old_model
    from public.admin_settings
   where setting_key = 'model';

  if old_model is null then
    old_model := '{}'::jsonb;
  end if;

  if jsonb_typeof(old_model -> 'models') is distinct from 'array' then
    select s.id into old_secret_id
      from vault.secrets s
     where s.name = 'jiwang-third-party-image-model-key'
     order by s.created_at desc
     limit 1;

    if old_secret_id is not null then
      select d.decrypted_secret into old_secret_value
        from vault.decrypted_secrets d
       where d.id = old_secret_id
       limit 1;
      configured := old_secret_value is not null;
      if configured then
        perform vault.update_secret(
          old_secret_id,
          old_secret_value,
          'jiwang-image-model-' || legacy_model_id::text,
          '极汪图像模型 ' || legacy_model_id::text || ' API Key'
        );
      end if;
    end if;

    update public.admin_settings
       set value = jsonb_build_object('models', jsonb_build_array(jsonb_build_object(
         'id', legacy_model_id::text,
         'provider', coalesce(nullif(old_model ->> 'provider', ''), 'OpenAI 兼容接口'),
         'name', coalesce(nullif(old_model ->> 'name', ''), 'gpt-image-2.5'),
         'endpoint', coalesce(old_model ->> 'endpoint', ''),
         'enabled', coalesce((old_model ->> 'enabled')::boolean, false),
         'priceCoins', 0,
         'secretConfigured', configured
       ))),
           updated_at = now()
     where setting_key = 'model';
  end if;
end;
$$;

create or replace function public.admin_set_image_model_api_key(p_model_id uuid, p_api_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
  model_exists boolean;
  secret_name text;
  updated_models jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if p_model_id is null or p_api_key is null or length(trim(p_api_key)) < 8 or length(p_api_key) > 8192 then
    raise exception 'invalid model id or API key length' using errcode = '22023';
  end if;

  select exists (
    select 1
      from public.admin_settings s,
           jsonb_array_elements(coalesce(s.value -> 'models', '[]'::jsonb)) as m(item)
     where s.setting_key = 'model'
       and m.item ->> 'id' = p_model_id::text
  ) into model_exists;
  if not model_exists then
    raise exception 'model configuration not found' using errcode = '22023';
  end if;

  secret_name := 'jiwang-image-model-' || p_model_id::text;
  select s.id into existing_secret_id
    from vault.secrets s
   where s.name = secret_name
   order by s.created_at desc
   limit 1;

  if existing_secret_id is null then
    perform vault.create_secret(trim(p_api_key), secret_name, '极汪图像模型 ' || p_model_id::text || ' API Key');
  else
    perform vault.update_secret(existing_secret_id, trim(p_api_key), secret_name, '极汪图像模型 ' || p_model_id::text || ' API Key');
  end if;

  select jsonb_agg(
    case when m.item ->> 'id' = p_model_id::text
      then jsonb_set(m.item, '{secretConfigured}', 'true'::jsonb, true)
      else m.item end
    order by m.ordinality
  ) into updated_models
  from public.admin_settings s,
       jsonb_array_elements(coalesce(s.value -> 'models', '[]'::jsonb)) with ordinality as m(item, ordinality)
  where s.setting_key = 'model';

  update public.admin_settings
     set value = jsonb_set(value, '{models}', coalesce(updated_models, '[]'::jsonb), true),
         updated_at = now(),
         updated_by = auth.uid()
   where setting_key = 'model';
end;
$$;

create or replace function public.public_enabled_image_models()
returns table(id uuid, provider text, name text, price_coins integer)
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(m.item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (m.item ->> 'id')::uuid else null end,
         coalesce(m.item ->> 'provider', ''),
         coalesce(m.item ->> 'name', ''),
         case when coalesce(m.item ->> 'priceCoins', '') ~ '^[1-9][0-9]{0,5}$' then (m.item ->> 'priceCoins')::integer else null end
    from public.admin_settings s,
         jsonb_array_elements(coalesce(s.value -> 'models', '[]'::jsonb)) as m(item)
   where s.setting_key = 'model'
     and m.item ->> 'enabled' = 'true'
     and m.item ->> 'secretConfigured' = 'true'
     and case
       when coalesce(m.item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       then true else false end
     and case
       when coalesce(m.item ->> 'priceCoins', '') ~ '^[1-9][0-9]{0,5}$'
       then (m.item ->> 'priceCoins')::integer between 1 and 100000 else false end
     and coalesce(m.item ->> 'name', '') <> ''
     and exists (
       select 1 from vault.secrets v
        where v.name = 'jiwang-image-model-' || (m.item ->> 'id')
     );
$$;

create or replace function public.worker_get_image_model_api_key(p_model_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  result text;
  configured boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select exists (
    select 1 from public.admin_settings s,
         jsonb_array_elements(coalesce(s.value -> 'models', '[]'::jsonb)) as m(item)
    where s.setting_key = 'model'
      and m.item ->> 'id' = p_model_id::text
      and m.item ->> 'enabled' = 'true'
      and m.item ->> 'secretConfigured' = 'true'
  ) into configured;
  if not configured then
    raise exception 'model is disabled or has no configured secret' using errcode = '22023';
  end if;
  select d.decrypted_secret into result
    from vault.decrypted_secrets d
   where d.name = 'jiwang-image-model-' || p_model_id::text
   order by d.created_at desc
   limit 1;
  if result is null then
    raise exception 'model secret not found' using errcode = '22023';
  end if;
  return result;
end;
$$;

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
     and (status = 'queued' or (status = 'processing' and worker_started_at < now() - interval '3 minutes'))
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
  refunded boolean;
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

  if exists (select 1 from public.wallet_transactions t where t.generation_job_id = p_job_id and t.transaction_type = 'generation_charge') then
    select exists (select 1 from public.wallet_transactions t where t.generation_job_id = p_job_id and t.transaction_type = 'generation_refund') into refunded;
    if refunded then raise exception 'generation reservation was already refunded' using errcode = '22023'; end if;
    select w.balance into balance_now from public.wallet_balances w where w.user_id = job.user_id;
    return coalesce(balance_now, 0);
  end if;

  insert into public.wallet_balances(user_id, balance) values(job.user_id, 0)
    on conflict (user_id) do nothing;
  select w.balance into balance_now from public.wallet_balances w where w.user_id = job.user_id for update;
  if balance_now < charge_amount then
    raise exception 'insufficient wallet balance' using errcode = 'P0001';
  end if;
  update public.wallet_balances set balance = balance - charge_amount, updated_at = now() where user_id = job.user_id returning balance into balance_now;
  insert into public.wallet_transactions(user_id, actor_id, amount, note, generation_job_id, transaction_type)
  values(job.user_id, null, -charge_amount, left('图像生成汪币预扣：' || job.title, 240), job.id, 'generation_charge');
  return balance_now;
end;
$$;

create or replace function public.worker_update_generation_progress(p_job_id uuid, p_worker_token uuid, p_progress integer)
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
     set progress = least(greatest(coalesce(p_progress, 0), 1), 99)
   where id = p_job_id and status = 'processing' and worker_token = p_worker_token;
  if not found then raise exception 'generation job claim is invalid' using errcode = '42501'; end if;
end;
$$;

create or replace function public.worker_complete_generation(p_job_id uuid, p_worker_token uuid)
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
     set status = 'completed', progress = 100, finished_at = now(), error_message = null
   where id = p_job_id and status = 'processing' and worker_token = p_worker_token;
  if not found then raise exception 'generation job claim is invalid' using errcode = '42501'; end if;
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
  already_refunded boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select * into job from public.generation_jobs where id = p_job_id for update;
  if not found or job.status <> 'processing' or job.worker_token is distinct from p_worker_token then
    return;
  end if;
  select -t.amount into charged
    from public.wallet_transactions t
   where t.generation_job_id = p_job_id and t.transaction_type = 'generation_charge'
   limit 1;
  select exists (
    select 1 from public.wallet_transactions t
     where t.generation_job_id = p_job_id and t.transaction_type = 'generation_refund'
  ) into already_refunded;
  if charged is not null and not already_refunded then
    update public.wallet_balances
       set balance = balance + charged, updated_at = now()
     where user_id = job.user_id;
    insert into public.wallet_transactions(user_id, actor_id, amount, note, generation_job_id, transaction_type)
    values(job.user_id, null, charged, left('图像生成失败退回汪币：' || coalesce(p_error, '未知错误'), 240), job.id, 'generation_refund');
  end if;
  update public.generation_jobs
     set status = 'failed', finished_at = now(), error_message = left(coalesce(p_error, '生成失败'), 1000)
   where id = p_job_id and worker_token = p_worker_token;
end;
$$;

revoke all on function public.admin_set_image_model_api_key(uuid, text) from public, anon;
revoke all on function public.admin_list_jobs_with_model(integer) from public;
revoke all on function public.public_enabled_image_models() from public;
revoke all on function public.worker_get_image_model_api_key(uuid) from public, anon, authenticated;
revoke all on function public.worker_claim_generation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_reserve_generation_coins(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_update_generation_progress(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.worker_complete_generation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_fail_generation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_image_model_api_key(uuid, text) to authenticated;
grant execute on function public.admin_list_jobs_with_model(integer) to authenticated;
grant execute on function public.public_enabled_image_models() to anon, authenticated;
grant execute on function public.worker_get_image_model_api_key(uuid) to service_role;
grant execute on function public.worker_claim_generation(uuid, uuid) to service_role;
grant execute on function public.worker_reserve_generation_coins(uuid, uuid) to service_role;
grant execute on function public.worker_update_generation_progress(uuid, uuid, integer) to service_role;
grant execute on function public.worker_complete_generation(uuid, uuid) to service_role;
grant execute on function public.worker_fail_generation(uuid, uuid, text) to service_role;
