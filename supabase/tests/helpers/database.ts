// 测试用数据库：用 PGlite（WASM 版 Postgres）按顺序加载仓库里的真实迁移文件。
// Supabase 专有的 auth / storage / vault 对象用最小桩替代；迁移 SQL 本身不做任何改写，
// 只把无法在 PGlite 中加载的扩展语句替换为注释（gen_random_uuid 在 PG13+ 为内置函数）。
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const migrationsDir = join(here, '..', '..', 'migrations')

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now(), metadata jsonb
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;

create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$
  insert into vault.secrets(secret, name, description) values (new_secret, new_name, new_description) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
returns void language sql as $$
  update vault.secrets
     set secret = coalesce(new_secret, secret),
         name = coalesce(new_name, name),
         description = coalesce(new_description, description),
         updated_at = now()
   where id = secret_id
$$;

-- Supabase grants broad default privileges on public objects; RLS and the migrations' revokes do the restricting.
grant usage on schema public, auth, storage, vault to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

/** Migration file names in the order Supabase applies them (lexicographic by timestamp prefix). */
export function migrationFiles(throughFile?: string): string[] {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  if (!throughFile) return files
  const index = files.indexOf(throughFile)
  if (index < 0) throw new Error(`migration not found: ${throughFile}`)
  return files.slice(0, index + 1)
}

function prepareMigrationSql(sql: string): string {
  return sql.replace(/^create extension if not exists (supabase_vault|pgcrypto)[^\n]*$/gm, '-- (test harness) extension $1 provided by stubs')
}

/**
 * Create an in-memory database with the Supabase stubs and every migration applied.
 * Pass `throughFile` to stop after a given migration (used to test upgrades from older schemas).
 */
export async function createTestDatabase(options: { throughFile?: string } = {}): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SUPABASE_STUBS)
  await applyMigrations(db, migrationFiles(options.throughFile))
  return db
}

/** Apply migration files (by name) in the given order. */
export async function applyMigrations(db: PGlite, files: string[]): Promise<void> {
  for (const file of files) {
    await db.exec(prepareMigrationSql(readFileSync(join(migrationsDir, file), 'utf8')))
  }
}

export type SessionRole = 'postgres' | 'anon' | 'authenticated' | 'service_role'

/**
 * Switch the connection to a Supabase-like request context.
 * `postgres` is the migration/owner role; `anon`, `authenticated` and `service_role` mirror PostgREST.
 */
export async function useSession(
  db: PGlite,
  role: SessionRole,
  options: { userId?: string; admin?: boolean } = {},
): Promise<void> {
  const claims: Record<string, unknown> = { role: role === 'postgres' ? 'postgres' : role }
  if (options.userId) claims.sub = options.userId
  if (options.admin) claims.app_metadata = { role: 'admin' }
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false), set_config('request.jwt.claims', $3, false)",
    [options.userId ?? '', String(claims.role), JSON.stringify(claims)],
  )
  await db.exec(role === 'postgres' ? 'reset role' : `set role ${role}`)
}
