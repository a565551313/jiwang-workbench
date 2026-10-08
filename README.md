# 极汪 · AI 表情创作工作台

基于 Vue 3、Vite、TypeScript、Element Plus、Pinia 和 Vue Router。前台与管理后台共用同一套应用；前台入口为 `/`，管理后台为 `/admin`。

## 产品与生成流程

- 管理员可以维护多条图像模型配置，分别填写服务商、模型 ID、API Base URL、Vault API Key、启停状态，以及一套 16 张贴图的汪币价格。
- 前台只展示已启用、价格大于 0 且密钥存在的模型；用户选择模型后会看到本套价格和当前余额。创建生成任务需要登录。
- 图像推理只由 `supabase/functions/jiwang-generate` 在服务端执行。它从 Supabase Vault 按模型编号读取 API Key，向 OpenAI 兼容的图像编辑接口提交参考图和 16 格脚本，结果写入私有 Storage。
- 每套任务使用管理员设定的固定价格。扣款、退款、账本流水与任务状态由受限数据库函数处理；失败时会原子退回预扣汪币。重复请求以任务 ID 防止重复扣款，管理员可按当前模型价格重试失败任务。
- `src/lib/archive.ts` 只负责下载图片并打包 ZIP；浏览器不再本地模拟生成，也不会直接写入生成任务或扣款记录。
- 本地未连接 Supabase 时，前台可编辑主题草案和预览布局，但不能发起真实模型调用或扣汪币。

## 模型接口要求

每条模型的 Base URL 留空时使用 `https://api.openai.com/v1`；否则须是 HTTPS 地址。服务端调用 Base URL 下的 `/images/edits`，以 multipart/form-data 发送 `model`、`prompt`、`image[]`、`n=1` 和 `size=1024x1024`。供应商应兼容 OpenAI 图像编辑协议，并返回 `data[0].b64_json` 或一个可公开读取的 HTTPS `data[0].url`。不支持该协议的供应商需要增加独立适配器，不能仅靠改模型 ID 接入。

一次完整任务会生成 16 张独立图片，每 8 张并发一组，单张模型请求超时为 40 秒、下载返回图片最多等待 15 秒。Supabase Edge Functions 的 wall-clock 上限依项目套餐而定（Free 为 150 秒）；供应商响应较慢或遇到限流时任务会失败并自动退款。生成完成后，私有图片使用限时签名 URL 提供预览和下载。

## 登录与权限

Supabase 云端运营数据通过 RLS 和数据库 RPC 校验。管理员数据权限依赖可信的 Supabase Auth `app_metadata.role=admin`，不能写入用户可自行编辑的 `user_metadata`。浏览器只使用公开 anon/publishable key；`service_role` 和第三方模型 API Key 绝不能放进 `VITE_*` 变量或浏览器代码。

管理后台的独立账号仍由服务端环境变量配置：签名的 12 小时 `HttpOnly`、`SameSite=Strict` Cookie、同源校验与失败限流继续生效。它与 Supabase 运营数据授权是两道独立检查。

## 本地启动

```bash
npm install
cp .env.example .env.local
cp .env.admin.example .env.admin.local
# 编辑 .env.admin.local，设置独立管理员账号、密码和随机会话密钥
npm run dev
```

本地前台地址为 `http://localhost:5173/`，后台地址为 `http://localhost:5173/admin`。Supabase 浏览器配置放在 `.env.local`，管理员变量放在 `.env.admin.local`；两个文件都已被 Git 忽略。

常用校验：

```bash
npm run typecheck
npm test
npm run build
```

## Supabase 迁移与生成函数

按顺序在目标 Supabase 项目的 SQL Editor 执行：

1. [`supabase/migrations/20261008070000_initial.sql`](supabase/migrations/20261008070000_initial.sql)
2. [`supabase/migrations/20261008073000_admin_console.sql`](supabase/migrations/20261008073000_admin_console.sql)
3. [`supabase/migrations/20261008090000_multi_model_billing.sql`](supabase/migrations/20261008090000_multi_model_billing.sql)

第三个迁移会将旧模型配置和 Vault 密钥安全地迁移为模型列表；原模型保留停用状态、价格设为 0，因此不会自动出现在前台或触发扣费。它还创建每模型密钥管理、已启用模型目录、任务领取、汪币扣款/退款及进度更新函数。

部署生成 Edge Function：

```bash
supabase functions deploy jiwang-generate --project-ref <project-ref>
```

该函数要求 JWT 登录验证，并使用 Supabase 托管环境变量 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`。不要把 service role key 复制到前端。若通过 Supabase Dashboard / 管理工具发布，也必须启用 JWT 验证。

完成迁移与函数部署后，在 `/admin` 的“模型与系统”新增或检查模型，填写 HTTPS Base URL、模型 ID、汪币价格，保存 API Key，再启用并保存模型设置。现有旧密钥已经绑定到原来的 `gpt-image-2.5` 配置，不会自动启用；可先用管理员提供的测试模型/测试账户进行验证。

## Vercel 前端部署

项目使用 Vite 构建，Build Command 为 `npm run build`，Output Directory 为 `dist`。在 Vercel 设置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，并在 Supabase Auth 的 Site URL / Redirect URLs 配置对应域名。Vercel 项目需保留现有管理员环境变量 `JIWANG_ADMIN_USERNAME`、`JIWANG_ADMIN_PASSWORD` 与 `JIWANG_ADMIN_SESSION_SECRET`。部署前端代码后，同一域名即可使用 `/` 和 `/admin`。
