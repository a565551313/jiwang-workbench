# 极汪 · AI 表情创作工作台

基于 Vue 3、Vite、TypeScript、Element Plus、Pinia 和 Vue Router 的响应式单页应用。公开用户站仅包含创作工作台、素材库和生成历史；管理端是独立的本机应用，不属于公开站点。

## 当前能力边界

- 目前尚未接入真实图像模型。`src/lib/mockGenerator.ts` 是独立的 Mock Provider：在浏览器画布中合成演示贴图，不会把图片或提示词提交给第三方推理服务，也不会扣汪币。
- 未配置云端时，用户可以本机预览和下载；生成记录与 PNG 暂存在当前浏览器。用户邮箱注册/登录仅在 Supabase 配置完成后启用。
- 配置 Supabase 后，参考图和生成贴图会进入私有 Storage；资料、任务及资产元信息保存在 Postgres。迁移开启 Row Level Security，按 `auth.uid()` 隔离用户记录和存储目录。
- 不包含真实扣费、订单、会员、广场发布/审核或邀请奖励。
- 本机管理端提供运营概览、跨用户任务查看与失败任务重排、用户/汪币管理、主题/提示词配置、第三方模型配置和功能开关。Supabase 管理操作仍要求可信的 `app_metadata.role=admin`，并由 RLS/RPC 再次校验。
- 未配置 Supabase 时，本机管理端显示带有演示标识的本地示例数据；设置保存在本机管理端浏览器，不代表真实线上运营数据。
- 管理端可以配置 OpenAI 兼容的第三方模型服务商、模型 ID、Base URL，并通过授权 RPC 将 API Key 加密保存到 [Supabase Vault](https://supabase.com/docs/guides/database/vault)。保存后不会从服务端回传密钥原文，也不会写入普通配置表或 `localStorage`。
- **配置模型不等于已经启用真实生成**：当前创作流程仍使用 Mock。服务端生成 Worker 尚未接入；部署 Worker 后可通过只授予 `service_role` 的数据库函数在服务端取用 Vault 密钥，再调用配置的第三方模型。

## 运行用户站

```bash
npm install
cp .env.example .env.local
# 如需邮箱登录及云端数据，填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY
npm run dev
```

用户站开发服务器会监听 `0.0.0.0:5173`，用于本地开发/预览；`/admin` 不会进入该站的路由，开发服务器也会拒绝 `/admin` 和 `/admin-ui` 路径。正式构建只以用户站 `index.html` 为入口，不会将管理页面打进 `dist/`。

## 运行本机管理端

本机管理端是单独的 Vite 应用和服务，默认只绑定 `127.0.0.1:4175`，不监听局域网或公网。启动前在项目根目录设置专用账号密码；若 4175 已被占用，可在本机环境文件中修改 `JIWANG_ADMIN_PORT`：

```bash
cp .env.admin.example .env.admin.local
# 编辑 .env.admin.local，设置 JIWANG_ADMIN_USERNAME 和至少 12 位的 JIWANG_ADMIN_PASSWORD；端口可选
npm run admin
```

然后在**运行该服务的同一台电脑**打开 `http://127.0.0.1:4175/admin`。`.env.admin.local` 已被 Git 忽略；本机登录通过 HttpOnly、SameSite Strict Cookie 建立 12 小时会话，失败尝试会限流。请勿把本机管理端反向代理或转发到公网，也不要把 `.env.admin.local` 提交到仓库。

本机账号密码与用户站账号相互独立。若已配置 Supabase，进入管理面板后还必须使用拥有 `app_metadata.role=admin` 的 Supabase 账号；这是数据库层的第二道授权，不会因为本机登录而绕过 RLS。未配置 Supabase 时，后台只能操作当前浏览器中的演示数据。

## 配置 Supabase

1. 创建 Supabase 项目，在项目的 API 设置中取得 **Project URL** 和 **publishable/anon key**。
2. 将它们填入 `.env.local`：`VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`。
3. 按顺序在 Supabase SQL Editor 中执行 [`supabase/migrations/20261008070000_initial.sql`](supabase/migrations/20261008070000_initial.sql) 和 [`supabase/migrations/20261008073000_admin_console.sql`](supabase/migrations/20261008073000_admin_console.sql)。第二个迁移会增加后台设置、汪币账户/不可由用户直接改写的账本、管理员数据 RPC、Vault 密钥写入/服务端读取函数和跨用户管理策略。
4. 在 Supabase Auth 配置中启用 Email provider，并按需设置邮箱确认和站点回跳 URL。生产环境的 Site URL 与重定向白名单需包含 Vercel 域名。
5. 在 Supabase Auth 的可信管理端为获准的管理员用户设置 `app_metadata`：`{"role":"admin"}`。更改后让该用户重新登录，以取得包含新角色的 access token。不要把角色写入用户可自行更改的 `user_metadata`。
6. **不要**将 Supabase `service_role` key 放进 `VITE_*` 变量或浏览器代码；它可以绕过 RLS。前端只使用公开 anon/publishable key，数据授权由 RLS 和 Storage policy 限制。
7. 先使用独立本机账号运行管理端，再使用上述 Supabase 管理员账号进入管理面板。在“模型与系统”填写第三方 OpenAI 兼容 Base URL、模型 ID 和 API Key。非敏感连接参数保存在后台配置表；密钥由 `admin_set_model_api_key` 存入 Vault。真实生成仍需后续部署服务端 Worker。

## Vercel 部署

1. 将 `jiwang-workbench` GitHub 仓库导入 Vercel。
2. Framework Preset 选择 **Vite**；Build Command 为 `npm run build`；Output Directory 为 `dist`。
3. 在 Vercel Project → Settings → Environment Variables 添加 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`，然后重新部署。
4. 将 Vercel 域名添加到 Supabase Auth 的站点 URL / Redirect URLs。

仓库含有 `vercel.json` 深层路由重写。Vercel 输出只包含用户站，管理页面组件不属于用户站路由，也不进入公开构建；访问用户站的 `/admin` 会被重定向回用户工作台。管理端必须单独在本机运行，不能通过 Vercel 域名访问。

## 真实模型接入点

当前 `generate()` 流程先建立 16 格草案，再将角色图、逐格 caption 与 visual、选项传给 `src/lib/mockGenerator.ts`。后续需将其替换为 `GenerationProvider`，由 Vercel Function 或 Supabase Edge Function 调用管理员已配置的兼容服务；只允许该服务端组件通过 `worker_get_model_api_key()` 读取 Vault 密钥。异步任务状态继续映射到 `generation_jobs`，模型输出按 4×4 边界/网格切成 16 张后存入私有 bucket。

## 校验

```bash
npm run typecheck
npm test
npm run build
```
