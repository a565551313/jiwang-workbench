# 极汪 · AI 表情创作工作台

基于 Vue 3、Vite、TypeScript、Element Plus、Pinia 和 Vue Router。前台和管理后台是同一套应用、同一域名和同一端口：前台可匿名访问，管理后台固定在 `/admin`，使用独立管理员账号密码登录。

## 访问方式

- 本地开发：前台 `http://localhost:5173/`，后台 `http://localhost:5173/admin`。
- Vercel：前台 `https://你的域名/`，后台 `https://你的域名/admin`。
- 两个入口共享主机和端口；不启动另一个后台服务、不另开后台端口。普通用户可直接使用前台，访问 `/admin` 只会看到管理员登录页。
- 管理员登录由服务端校验，使用签名的 12 小时 `HttpOnly`、`SameSite=Strict` Cookie；登录端点校验同源请求并对连续失败尝试限流。账号、密码和会话签名密钥只从环境变量读取。
- Supabase 云端运营数据还会检查可信的 `app_metadata.role=admin`，数据库继续由 RLS/RPC 校验；它是数据授权的第二道保护，不取代 `/admin` 的独立管理员账号。

## 当前能力边界

- 目前尚未接入真实图像模型。`src/lib/mockGenerator.ts` 是独立的 Mock Provider：在浏览器画布中合成演示贴图，不会把图片或提示词提交给第三方推理服务，也不会扣汪币。
- 未配置云端时，用户可以本地预览和下载；生成记录与 PNG 暂存在当前浏览器。前台邮箱注册/登录仅在 Supabase 配置完成后启用。
- 配置 Supabase 后，参考图和生成贴图会进入私有 Storage；资料、任务及资产元信息保存在 Postgres。迁移开启 Row Level Security，按 `auth.uid()` 隔离用户记录和存储目录。
- 不包含真实扣费、订单、会员、广场发布/审核或邀请奖励。
- 管理后台提供运营概览、跨用户任务查看与失败任务重排、用户/汪币管理、主题/提示词配置、第三方模型配置和功能开关。
- 未配置 Supabase 时，管理员登录后看到演示数据；设置保存在当前浏览器，不代表真实线上运营数据。
- 管理后台可以配置 OpenAI 兼容的第三方模型服务商、模型 ID、Base URL，并通过授权 RPC 将 API Key 加密保存到 [Supabase Vault](https://supabase.com/docs/guides/database/vault)。密钥不会从服务端回传，也不会写入普通配置表或 `localStorage`。
- **配置模型不等于已经启用真实生成**：当前创作流程仍使用 Mock。服务端生成 Worker 尚未接入；后续 Worker 才可通过只授权服务端的数据库函数读取 Vault 密钥并调用第三方模型。

## 本地启动

```bash
npm install
cp .env.example .env.local
cp .env.admin.example .env.admin.local
# 编辑 .env.admin.local，设置独立管理员账号、密码和随机会话密钥
npm run dev
```

打开 `http://localhost:5173/` 使用前台，打开 `http://localhost:5173/admin` 登录管理后台。管理员变量从 `.env.admin.local` 载入；Vite 在同一个 `5173` 服务中提供前台、后台入口和 `/api/admin/*` 会话端点。`.env.admin.local` 已被 Git 忽略，不要提交。

## Vercel 部署

1. 将 `jiwang-workbench` 仓库导入 Vercel，Framework Preset 选 **Vite**，Build Command 使用 `npm run build`，Output Directory 使用 `dist`。
2. 在 Vercel Project → Settings → Environment Variables 设置 `JIWANG_ADMIN_USERNAME`、`JIWANG_ADMIN_PASSWORD` 和 `JIWANG_ADMIN_SESSION_SECRET`。密码至少 12 个字符，会话密钥至少 32 个字符；使用随机强密码和随机会话密钥，不要复用普通用户邮箱密码。
3. 若启用 Supabase，在同一项目设置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，并在 Supabase Auth 的 Site URL / Redirect URLs 加入 Vercel 域名，然后重新部署。
4. 构建同时输出前台和后台入口；`vercel.json` 将 `/admin` 与其子路径重写到后台 SPA，并把后台 API 路由交给 Vercel Functions。最终用户只需使用同一个域名：前台 `/`，后台 `/admin`。

独立后台密码必须在 Vercel 环境变量中配置后，`/api/admin/session` 才会启用。若后台运营真实 Supabase 数据，还需在 Supabase Auth 管理端为指定账号设置可信 `app_metadata`：`{"role":"admin"}`，并以该 Supabase 账号通过后台的数据授权检查。不要把角色写入用户可以自行修改的 `user_metadata`，也不要把 `service_role` key 放进 `VITE_*` 变量或浏览器代码。

## 配置 Supabase

1. 创建 Supabase 项目，在 API 设置中取得 **Project URL** 和 **publishable/anon key**，分别放入本地 `.env.local` 或 Vercel 的 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`。
2. 按顺序在 Supabase SQL Editor 执行 [`supabase/migrations/20261008070000_initial.sql`](supabase/migrations/20261008070000_initial.sql) 和 [`supabase/migrations/20261008073000_admin_console.sql`](supabase/migrations/20261008073000_admin_console.sql)。后台迁移会增加设置、汪币账户/账本、管理员 RPC、Vault 密钥函数和跨用户管理策略。
3. 在 Supabase Auth 启用 Email provider，并按需设置邮箱确认。可信管理员账号需在 `app_metadata` 中设置 `{"role":"admin"}`。
4. 浏览器只使用公开 anon/publishable key；数据仍由 RLS、Storage policies 和数据库 RPC 授权。

在管理后台“模型与系统”填写第三方 OpenAI 兼容 Base URL、模型 ID 和 API Key。非敏感连接参数保存在后台配置表；API Key 通过 `admin_set_model_api_key` 存入 Vault。真实生成仍需后续部署服务端 Worker。

## 真实模型接入点与校验

当前 `generate()` 流程将角色图、逐格 caption 与 visual、选项传给 `src/lib/mockGenerator.ts`。后续应替换为 `GenerationProvider`，由 Vercel Function 或 Supabase Edge Function 调用兼容服务；仅服务端组件可以读取 Vault 密钥。异步任务映射到 `generation_jobs`，模型输出再按 4×4 网格切成 16 张并存入私有 bucket。

```bash
npm run typecheck
npm test
npm run build
```
