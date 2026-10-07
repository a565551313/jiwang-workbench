# 极汪 · AI 表情创作工作台

基于 **Vue 3、Vite、TypeScript、Element Plus、Pinia、Vue Router** 的响应式单页应用。包含用户侧创作工作台、素材库、生成历史和独立管理后台。全站使用蓝色主题。

## 当前能力边界

- 目前尚未接入真实图像模型。`src/lib/mockGenerator.ts` 是清晰隔离的 Mock Provider：在浏览器画布中合成演示贴图，不会把图片或提示词提交给第三方推理服务，也不会扣汪币。
- 未配置云端时，用户可以本机预览和下载；生成记录与 PNG 暂存在当前浏览器。登录按钮只有在 Supabase 配置完成后才启用邮箱注册/登录。
- 配置 Supabase 后，参考图和生成贴图会进入私有 Storage；资料、任务及资产元信息保存在 Postgres。迁移开启 Row Level Security，按 `auth.uid()` 隔离用户记录和存储目录。
- 不包含真实扣费、订单、会员、广场发布/审核或邀请奖励。
- 管理后台提供运营概览、跨用户任务查看与失败任务重排、用户/汪币管理、主题/提示词配置、模型展示参数和功能开关；数据库端以 `app_metadata.role=admin` 和 RLS/RPC 校验管理权限。
- 未配置 Supabase 时，后台显示有标识的本地演示数据；演示设置只保存在当前浏览器，不代表真实线上运营数据。
- 管理后台可以配置 OpenAI 兼容的第三方模型服务商、模型 ID、Base URL，并通过受权 RPC 将 API Key 加密保存到 [Supabase Vault](https://supabase.com/docs/guides/database/vault)。密钥不会进入普通配置表、`localStorage` 或浏览器回显。
- **配置模型不等于已经启用真实生成**：当前创作流程仍使用 Mock。服务端生成 Worker 尚未接入；部署 Worker 后可通过只授予 `service_role` 的数据库函数在服务端取用 Vault 密钥，再调用配置的第三方模型。

## 本地运行

```bash
npm install
cp .env.example .env.local
# 填入 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 后启用邮箱登录和云端保存
npm run dev
```

不填 Supabase 配置也可查看创作流程、在浏览器本地生成预览并下载 ZIP；邮箱注册/登录和云端同步会保持关闭。

## 配置 Supabase

1. 创建 Supabase 项目，在项目的 API 设置中取得 **Project URL** 和 **publishable/anon key**。
2. 将它们填入 `.env.local`：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. 按顺序在 Supabase SQL Editor 中执行 [`supabase/migrations/20261008070000_initial.sql`](supabase/migrations/20261008070000_initial.sql) 和 [`supabase/migrations/20261008073000_admin_console.sql`](supabase/migrations/20261008073000_admin_console.sql)。第二个迁移会增加后台设置、汪币账户/不可由用户直接改写的账本、管理员数据 RPC、Vault 密钥写入/服务端读取函数和跨用户管理策略。
4. 在 Supabase Auth 配置中启用 Email provider，并按需要设置邮箱确认和站点回跳 URL。生产环境的 Site URL 与重定向白名单需包含 Vercel 域名。
5. 在 Supabase Auth 的可信管理端为获准的管理员用户设置 `app_metadata`：`{"role":"admin"}`。更改后让该用户重新登录，以取得包含新角色的 access token。不要把角色写入用户可自行更改的 `user_metadata`。
6. **不要**将 Supabase `service_role` key 放进 `VITE_*` 变量或浏览器代码；它绕过 RLS。前端仅用公开 anon/publishable key，数据授权由 RLS 和 Storage policy 限制。
7. 以管理员账号打开 `/admin`，在“模型与系统”填写第三方的 OpenAI 兼容 Base URL、模型 ID 和 API Key。非敏感连接参数保存在后台配置表；密钥由 `admin_set_model_api_key` 存入 Vault。确认密钥已保存后，可单独打开模型开关；真正生成仍需后续部署服务端 Worker。

## Vercel 部署

1. 将 `jiwang-workbench` GitHub 仓库导入 Vercel。
2. Framework Preset 选择 **Vite**；Build Command `npm run build`；Output Directory `dist`。
3. 在 Vercel Project → Settings → Environment Variables 添加 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`，然后重新部署。
4. 将 Vercel 域名添加到 Supabase Auth 的站点 URL / Redirect URLs。

仓库含有 `vercel.json` 深层路由重写。每次变更前端环境变量后都需重新构建部署。

## 真实模型接入点

当前 `generate()` 流程先建立 16 格草案，再将角色图、逐格 caption 与 visual、选项传给 `src/lib/mockGenerator.ts`。后续需将其替换为 `GenerationProvider`，由 Vercel Function 或 Supabase Edge Function 调用管理员已配置的兼容服务；只允许该服务端组件通过 `worker_get_model_api_key()` 读取 Vault 密钥。异步任务状态继续映射到 `generation_jobs`，模型输出按 4×4 边界/网格切成 16 张后存入私有 bucket。

## 校验

```bash
npm run typecheck
npm test
npm run build
```
