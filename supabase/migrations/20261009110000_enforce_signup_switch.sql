-- 后台“邮箱注册”开关真正生效。
-- 之前该开关只隐藏前台入口；直接调用 Supabase Auth 接口仍可注册。
-- 现在在 auth.users 插入新用户之前检查 admin_settings['features'].signup，关闭时由数据库拒绝。
-- 默认值与 public_site_features() 保持一致：缺省视为开启。

create or replace function public.signup_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.value ->> 'signup' from public.admin_settings s where s.setting_key = 'features'),
    'true'
  ) <> 'false'
$$;

create or replace function public.enforce_signup_switch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.signup_enabled() then
    raise exception '当前暂未开放注册，请使用已有账号登录' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- 只拦截新用户插入；已有账号登录不会插入 auth.users，不受影响。
drop trigger if exists enforce_signup_switch on auth.users;
create trigger enforce_signup_switch
before insert on auth.users
for each row execute function public.enforce_signup_switch();

revoke all on function public.signup_enabled() from public;
revoke all on function public.enforce_signup_switch() from public;
