-- 主题预设后台化。
-- 预设作为 admin_settings 中的 'themePresets' 保存，只有管理员可写（沿用既有 RLS）。
-- 前台通过下面的只读 RPC 读取；未保存过时返回 null，前台使用内置默认预设。

create or replace function public.public_theme_presets()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s.value from public.admin_settings s where s.setting_key = 'themePresets'
$$;

revoke all on function public.public_theme_presets() from public;
grant execute on function public.public_theme_presets() to anon, authenticated;
