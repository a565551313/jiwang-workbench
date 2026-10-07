-- 极汪初始数据库结构：仅保存用户自己的资料、任务和素材。
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'sticker_grid' check (kind in ('sticker_grid')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  title text not null default '未命名表情套装',
  topic text not null default '',
  options jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.generation_jobs(id) on delete set null,
  kind text not null check (kind in ('reference', 'sticker', 'grid')),
  name text not null,
  storage_path text not null,
  mime_type text not null default 'image/png',
  cell_index integer check (cell_index is null or cell_index between 0 and 15),
  caption text,
  created_at timestamptz not null default now()
);

create index if not exists generation_jobs_user_created_idx on public.generation_jobs(user_id, created_at desc);
create index if not exists assets_user_created_idx on public.assets(user_id, created_at desc);
create index if not exists assets_job_idx on public.assets(job_id);

alter table public.profiles enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.assets enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own" on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "jobs manage own" on public.generation_jobs;
create policy "jobs manage own" on public.generation_jobs for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "assets manage own" on public.assets;
create policy "assets manage own" on public.assets for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.generation_jobs to authenticated;
grant select, insert, update, delete on public.assets to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 私有桶；对象路径必须以登录用户 UUID 开头。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jiwang-private', 'jiwang-private', false, 12582912, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 12582912,
  allowed_mime_types = array['image/png','image/jpeg','image/webp'];

drop policy if exists "jiwang objects read own" on storage.objects;
create policy "jiwang objects read own" on storage.objects for select to authenticated
using (bucket_id = 'jiwang-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "jiwang objects insert own" on storage.objects;
create policy "jiwang objects insert own" on storage.objects for insert to authenticated
with check (bucket_id = 'jiwang-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "jiwang objects update own" on storage.objects;
create policy "jiwang objects update own" on storage.objects for update to authenticated
using (bucket_id = 'jiwang-private' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'jiwang-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "jiwang objects delete own" on storage.objects;
create policy "jiwang objects delete own" on storage.objects for delete to authenticated
using (bucket_id = 'jiwang-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
