-- Replace per-model connection details with supplier-level protocol, URL and Vault secret.
-- Keep the previous JSON value as an admin-only recovery record and duplicate, rather than delete, each Vault key.

create extension if not exists supabase_vault with schema vault;

do $$
declare
  old_value jsonb;
  old_models jsonb;
  old_row jsonb;
  providers_value jsonb := '[]'::jsonb;
  provider_models jsonb;
  model_id uuid;
  provider_id uuid;
  provider_name text;
  base_url text;
  secret_id uuid;
  provider_secret_id uuid;
  secret_value text;
  is_configured boolean;
  legacy_secret_name text;
  provider_secret_name text;
  fallback_model_id constant uuid := 'd9e6fc44-67ef-4b11-9c4d-7f86b8e3025b';
begin
  select value into old_value
    from public.admin_settings
   where setting_key = 'model'
   for update;

  if old_value is null or jsonb_typeof(old_value -> 'providers') = 'array' then
    return;
  end if;

  insert into public.admin_settings(setting_key, value)
  values ('model_legacy_backup_20261008', old_value)
  on conflict (setting_key) do nothing;

  if jsonb_typeof(old_value -> 'models') = 'array' then
    old_models := old_value -> 'models';
  elsif coalesce(old_value ->> 'name', '') <> '' then
    old_models := jsonb_build_array(jsonb_build_object(
      'id', fallback_model_id::text,
      'provider', coalesce(nullif(old_value ->> 'provider', ''), 'OpenAI 兼容接口'),
      'name', old_value ->> 'name',
      'endpoint', coalesce(old_value ->> 'endpoint', ''),
      'enabled', coalesce((old_value ->> 'enabled')::boolean, false),
      'priceCoins', 0,
      'secretConfigured', coalesce((old_value ->> 'secretConfigured')::boolean, false)
    ));
  else
    old_models := '[]'::jsonb;
  end if;

  for old_row in select value from jsonb_array_elements(old_models)
  loop
    begin
      model_id := (old_row ->> 'id')::uuid;
    exception when others then
      model_id := gen_random_uuid();
    end;
    provider_id := model_id;
    provider_name := coalesce(nullif(old_row ->> 'provider', ''), 'OpenAI 兼容接口');
    base_url := coalesce(old_row ->> 'endpoint', '');
    legacy_secret_name := 'jiwang-image-model-' || model_id::text;
    provider_secret_name := 'jiwang-image-provider-' || provider_id::text;
    secret_id := null;
    provider_secret_id := null;
    secret_value := null;

    select s.id into secret_id
      from vault.secrets s
     where s.name = legacy_secret_name
     order by s.created_at desc
     limit 1;
    if secret_id is null and model_id = fallback_model_id then
      select s.id into secret_id
        from vault.secrets s
       where s.name = 'jiwang-third-party-image-model-key'
       order by s.created_at desc
       limit 1;
    end if;

    if secret_id is not null then
      select d.decrypted_secret into secret_value
        from vault.decrypted_secrets d
       where d.id = secret_id
       limit 1;
    end if;
    is_configured := secret_value is not null;

    if is_configured then
      select s.id into provider_secret_id
        from vault.secrets s
       where s.name = provider_secret_name
       order by s.created_at desc
       limit 1;
      if provider_secret_id is null then
        perform vault.create_secret(
          secret_value,
          provider_secret_name,
          '极汪供应商 ' || provider_id::text || ' API Key'
        );
      else
        perform vault.update_secret(
          provider_secret_id,
          secret_value,
          provider_secret_name,
          '极汪供应商 ' || provider_id::text || ' API Key'
        );
      end if;
    end if;

    provider_models := jsonb_build_array(jsonb_build_object(
      'id', model_id::text,
      'name', coalesce(nullif(old_row ->> 'name', ''), '图像模型'),
      'enabled', coalesce((old_row ->> 'enabled')::boolean, false),
      'priceCoins', case
        when coalesce(old_row ->> 'priceCoins', '') ~ '^[0-9]{1,6}$'
          then least((old_row ->> 'priceCoins')::integer, 100000)
        else 0
      end
    ));

    providers_value := providers_value || jsonb_build_array(jsonb_build_object(
      'id', provider_id::text,
      'name', provider_name,
      'protocol', 'responses',
      'baseUrl', base_url,
      'secretConfigured', is_configured,
      'models', provider_models
    ));
  end loop;

  update public.admin_settings
     set value = jsonb_build_object('providers', providers_value),
         updated_at = now()
   where setting_key = 'model';
end;
$$;

create or replace function public.admin_set_image_provider_api_key(p_provider_id uuid, p_api_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
  provider_exists boolean;
  secret_name text;
  updated_providers jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if p_provider_id is null or p_api_key is null or length(trim(p_api_key)) < 8 or length(p_api_key) > 8192 then
    raise exception 'invalid provider id or API key length' using errcode = '22023';
  end if;

  select exists (
    select 1
      from public.admin_settings s,
           jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) as p(item)
     where s.setting_key = 'model'
       and p.item ->> 'id' = p_provider_id::text
  ) into provider_exists;
  if not provider_exists then
    raise exception 'provider configuration not found' using errcode = '22023';
  end if;

  secret_name := 'jiwang-image-provider-' || p_provider_id::text;
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
     );
$$;

create or replace function public.worker_get_image_provider_api_key(p_provider_id uuid)
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
         jsonb_array_elements(coalesce(s.value -> 'providers', '[]'::jsonb)) as p(item)
    where s.setting_key = 'model'
      and p.item ->> 'id' = p_provider_id::text
      and p.item ->> 'secretConfigured' = 'true'
  ) into configured;
  if not configured then
    raise exception 'provider has no configured secret' using errcode = '22023';
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

revoke all on function public.admin_set_image_provider_api_key(uuid, text) from public, anon;
revoke all on function public.worker_get_image_provider_api_key(uuid) from public, anon, authenticated;
revoke all on function public.public_enabled_image_models() from public;
grant execute on function public.admin_set_image_provider_api_key(uuid, text) to authenticated;
grant execute on function public.worker_get_image_provider_api_key(uuid) to service_role;
grant execute on function public.public_enabled_image_models() to anon, authenticated;

-- Legacy RPCs are no longer part of the running app. Vault records are intentionally retained for recovery.
drop function if exists public.admin_set_image_model_api_key(uuid, text);
drop function if exists public.worker_get_image_model_api_key(uuid);
drop function if exists public.admin_set_model_api_key(text);
drop function if exists public.worker_get_model_api_key();
