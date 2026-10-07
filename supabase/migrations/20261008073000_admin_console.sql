-- 极汪管理后台：仅可信 Supabase app_metadata.role=admin 可跨用户读取和管理。
-- 绝不能从浏览器端提供或写入 service_role key。
create extension if not exists supabase_vault with schema vault;

create table if not exists public.admin_settings (
  setting_key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.wallet_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  amount integer not null check (amount <> 0),
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists wallet_transactions_user_created_idx on public.wallet_transactions(user_id, created_at desc);

alter table public.admin_settings enable row level security;
alter table public.wallet_balances enable row level security;
alter table public.wallet_transactions enable row level security;

-- 未登录用户不能读后台配置；管理员只能通过受 RLS 保护的表访问。
grant select, insert, update on public.admin_settings to authenticated;
grant select on public.wallet_balances to authenticated;
grant select on public.wallet_transactions to authenticated;

drop policy if exists "admin settings manage admins" on public.admin_settings;
create policy "admin settings manage admins" on public.admin_settings
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "wallet balances read own or admin" on public.wallet_balances;
create policy "wallet balances read own or admin" on public.wallet_balances
  for select to authenticated
  using ((select auth.uid()) = user_id or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "wallet transactions read own or admin" on public.wallet_transactions;
create policy "wallet transactions read own or admin" on public.wallet_transactions
  for select to authenticated
  using ((select auth.uid()) = user_id or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "admin read all profiles" on public.profiles;
create policy "admin read all profiles" on public.profiles
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "admin read all jobs" on public.generation_jobs;
create policy "admin read all jobs" on public.generation_jobs
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "admin update jobs" on public.generation_jobs;
create policy "admin update jobs" on public.generation_jobs
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "admin read all assets" on public.assets;
create policy "admin read all assets" on public.assets
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

insert into public.wallet_balances(user_id, balance)
select u.id, 0 from auth.users u
on conflict (user_id) do nothing;

insert into public.admin_settings(setting_key, value) values
  ('themes', '{"presets":["日常聊天","可爱撒娇","上班摸鱼","节日限定","自定义主题"]}'::jsonb),
  ('prompts', '{"sticker":"生成一套统一角色设定的聊天表情。每格保持清晰轮廓、单一动作和易读情绪；透明背景，主体居中。主题：{{topic}}；单格描述：{{caption}}；画面：{{visual}}。"}'::jsonb),
  ('model', '{"provider":"OpenAI 兼容接口","name":"gpt-image-2.5","endpoint":"","enabled":false,"secretConfigured":false}'::jsonb),
  ('features', '{"signup":true,"customThemes":true,"communitySubmissions":false,"maintenance":false}'::jsonb)
on conflict (setting_key) do nothing;

create or replace function public.admin_dashboard_metrics()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'users', (select count(*) from auth.users),
    'jobs', (select count(*) from public.generation_jobs),
    'today_jobs', (select count(*) from public.generation_jobs where created_at >= now() - interval '1 day'),
    'failed_jobs', (select count(*) from public.generation_jobs where status = 'failed'),
    'assets', (select count(*) from public.assets),
    'coins_in_circulation', (select coalesce(sum(balance), 0) from public.wallet_balances)
  );
end;
$$;

create or replace function public.admin_list_users(p_limit integer default 50, p_offset integer default 0)
returns table(user_id uuid, email text, display_name text, created_at timestamptz, coins bigint, total_count bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  return query
  select u.id, u.email::text, coalesce(p.display_name, ''), u.created_at,
         coalesce(w.balance, 0), count(*) over ()
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.wallet_balances w on w.user_id = u.id
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.admin_list_jobs(p_limit integer default 50)
returns table(job_id uuid, user_email text, title text, topic text, status text, created_at timestamptz, finished_at timestamptz, asset_count integer)
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
         coalesce(nullif(j.options ->> 'cellCount', '')::integer, 16)
  from public.generation_jobs j
  left join auth.users u on u.id = j.user_id
  order by j.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

create or replace function public.admin_adjust_wallet(p_user_id uuid, p_delta integer, p_note text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_balance bigint;
  clean_note text := left(trim(coalesce(p_note, '')), 240);
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if p_delta is null or p_delta = 0 or abs(p_delta::bigint) > 100000 then
    raise exception 'invalid wallet adjustment' using errcode = '22023';
  end if;
  if clean_note = '' then
    raise exception 'note is required' using errcode = '22023';
  end if;
  insert into public.wallet_balances(user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;
  update public.wallet_balances
     set balance = balance + p_delta,
         updated_at = now()
   where user_id = p_user_id and balance + p_delta >= 0
   returning balance into new_balance;
  if new_balance is null then
    raise exception 'user not found or balance cannot be negative' using errcode = '22023';
  end if;
  insert into public.wallet_transactions(user_id, actor_id, amount, note)
  values (p_user_id, auth.uid(), p_delta, clean_note);
  return new_balance;
end;
$$;

create or replace function public.admin_set_model_api_key(p_api_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if p_api_key is null or length(trim(p_api_key)) < 8 or length(p_api_key) > 8192 then
    raise exception 'invalid API key length' using errcode = '22023';
  end if;
  select s.id into existing_secret_id
    from vault.secrets s
   where s.name = 'jiwang-third-party-image-model-key'
   order by s.created_at desc
   limit 1;
  if existing_secret_id is null then
    perform vault.create_secret(trim(p_api_key), 'jiwang-third-party-image-model-key', '极汪第三方图像模型 API Key');
  else
    perform vault.update_secret(existing_secret_id, trim(p_api_key), 'jiwang-third-party-image-model-key', '极汪第三方图像模型 API Key');
  end if;
  update public.admin_settings
     set value = jsonb_set(value, '{secretConfigured}', 'true'::jsonb, true),
         updated_at = now(),
         updated_by = auth.uid()
   where setting_key = 'model';
end;
$$;

-- 仅可信后端 Worker 可读取解密后的密钥；普通登录用户永远无权调用。
create or replace function public.worker_get_model_api_key()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  result text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select s.decrypted_secret into result
    from vault.decrypted_secrets s
   where s.name = 'jiwang-third-party-image-model-key'
   order by s.created_at desc
   limit 1;
  return result;
end;
$$;

revoke all on function public.admin_dashboard_metrics() from public;
revoke all on function public.admin_list_users(integer, integer) from public;
revoke all on function public.admin_list_jobs(integer) from public;
revoke all on function public.admin_adjust_wallet(uuid, integer, text) from public;
revoke all on function public.admin_set_model_api_key(text) from public;
revoke all on function public.worker_get_model_api_key() from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to authenticated;
grant execute on function public.admin_list_users(integer, integer) to authenticated;
grant execute on function public.admin_list_jobs(integer) to authenticated;
grant execute on function public.admin_adjust_wallet(uuid, integer, text) to authenticated;
grant execute on function public.admin_set_model_api_key(text) to authenticated;
grant execute on function public.worker_get_model_api_key() to service_role;
