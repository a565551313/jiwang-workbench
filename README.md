# 极汪 · AI 表情创作工作台

基于 Vue 3、Vite、TypeScript、Element Plus、Pinia 和 Vue Router。前台与管理后台共用同一套应用；前台入口为 `/`，管理后台为 `/admin`。

## 产品与生成流程

- 管理员维护图像模型配置：供应商（协议、HTTPS Base URL、Vault 中的 API Key），以及供应商下的模型 ID、启停状态和一套 16 张贴图的汪币价格。
- 前台只展示已启用、价格大于 0、密钥已保存且 Base URL 未被改动的模型。创建生成任务需要登录。
- 图像推理只由 `supabase/functions/jiwang-generate` 在服务端执行。它从 Supabase Vault 读取 API Key，把参考图和 16 格脚本提交给供应商，结果写入账号私有的 Storage。
- **计费规则**：开始生成时预扣整套汪币。
  - 16 张全部交付：全额保留，等于单价。
  - 部分交付（例如 13 张）：按比例保留 `ceil(单价 × 交付张数 ÷ 16)`，其余自动退回，已生成的图片保留可下载。
  - 一张都没有交付：全额退回，任务标记为失败。
  - 结算由数据库函数原子完成，同一次尝试最多扣一次、退一次。
- **重新生成**：只有任务所有者可以对失败任务重新生成。点击后会显示当前价格并要求确认；每次重试都是新的“尝试”，有独立的扣费与退款记录。管理员后台不能代用户扣费重试。
- **超时回收**：处理超过 10 分钟仍未结束的任务会被服务端自动结算（按已交付张数）；从未启动的排队任务直接结束且不扣费。回收函数 `worker_reap_stale_generations` 会在每次生成请求时顺带执行，并可由 pg_cron 每 5 分钟执行。
- **维护模式**：管理员在后台开启后，服务端拒绝新建生成任务（已在进行中的任务不受影响）。
- `src/lib/archive.ts` 只负责下载图片并打包 ZIP；浏览器不会直接写入生成任务或扣款记录。
- 本地未连接 Supabase 时，前台可编辑主题草案和预览布局，但不能发起真实模型调用或扣汪币。

## 模型接口要求

每个供应商的 Base URL 必须是 **HTTPS 地址**，只能使用默认端口，不能包含账号、查询参数或指向本机/内网的地址（包括 IPv4 映射的 IPv6 写法）。服务端按供应商的 `protocol` 调用以下两种接口之一：

- `responses`（默认）：调用 `Base URL/responses`，携带参考图并请求 `image_generation` 工具（`action: edit`，透明背景，1024×1024）。
- `chat_completions`：调用 `Base URL/chat/completions`，以 `image_url` 携带参考图，并从返回的 `image`/`image_url` 字段或 data URL 中读取图片。

两种接口都需要返回可读取的图片：Base64（`b64_json` / `result`）或可公开访问的 HTTPS 图片地址（下载时限制 10 MB）。接口不兼容的供应商需要增加独立适配器，不能仅靠改模型 ID 接入。

**API Key 与地址绑定**：保存密钥时，服务端同时记录该供应商的 Base URL。之后只有同一地址的请求才会取出密钥；修改 Base URL 后必须重新输入 API Key，否则生成和“获取模型列表”都会被拒绝。这样旧密钥不会被发送到新地址。

一次完整任务会生成 16 张独立图片，分两批、每批 8 张并发。单张模型请求超时为 40 秒，下载返回图片最多等待 15 秒。Supabase Edge Functions 的 wall-clock 上限依项目套餐而定（Free 为 150 秒）。生成完成后，私有图片使用 30 分钟有效的签名 URL 提供预览和下载；页面在下载前会重新签名。

## 登录与权限

Supabase 云端运营数据通过 RLS 和数据库 RPC 校验。管理员数据权限依赖可信的 Supabase Auth `app_metadata.role=admin`，不能写入用户可自行编辑的 `user_metadata`。浏览器只使用公开 anon/publishable key；`service_role` 和第三方模型 API Key 绝不能放进 `VITE_*` 变量或浏览器代码。

- 用户只能登记自己 `references/` 目录下的参考图，不能直接写入生成结果、任务或账本。
- 匿名角色没有任何业务表的权限；余额只能通过服务端函数和管理员 RPC 变动。

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

如需从其它域名访问开发服务器，可设置 `JIWANG_DEV_ALLOWED_HOSTS=域名1,域名2`；`.e2b.app` 沙箱预览域名默认已放行。

常用校验：

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 包含三类测试，无需连接 Supabase：

- `src/lib`：前端校验、模型列表、ZIP 打包与错误提示。
- `supabase/tests/generate-shared.test.ts`：Edge Function 的纯函数（SSRF 判断、Base URL 校验、流式字节上限、计费与进度换算）。
- `supabase/tests/*.test.ts`：使用 PGlite（WASM 版 Postgres）按顺序加载仓库中的真实迁移文件，验证计费、部分交付、超时回收、RLS 与密钥绑定。

## Supabase 迁移与生成函数

按文件名顺序在目标 Supabase 项目的 SQL Editor 执行：

1. [`supabase/migrations/20261008070000_initial.sql`](supabase/migrations/20261008070000_initial.sql)
2. [`supabase/migrations/20261008073000_admin_console.sql`](supabase/migrations/20261008073000_admin_console.sql)
3. [`supabase/migrations/20261008090000_multi_model_billing.sql`](supabase/migrations/20261008090000_multi_model_billing.sql)
4. [`supabase/migrations/20261008103000_provider_model_settings.sql`](supabase/migrations/20261008103000_provider_model_settings.sql)
5. [`supabase/migrations/20261008120000_generation_recovery.sql`](supabase/migrations/20261008120000_generation_recovery.sql)

第 3 个迁移会将旧模型配置和 Vault 密钥迁移为模型列表；原模型保留停用状态、价格设为 0，因此不会自动出现在前台或触发扣费。第 4 个迁移把供应商级别的协议、Base URL 与密钥写入新结构。第 5 个迁移加入按尝试记账、部分交付结算、超时回收、密钥与 Base URL 绑定、素材表权限收紧，以及前台功能开关的只读接口。

**升级注意**：第 5 个迁移会为升级前已保存密钥的供应商记录“当前”的 Base URL。如果升级前曾改过某个供应商的地址，请在后台重新保存该供应商的 API Key。

**定时回收（可选）**：第 5 个迁移会尝试启用 pg_cron，每 5 分钟调用一次 `worker_reap_stale_generations()`。若项目不支持 pg_cron，迁移只会输出提示；超时任务仍会在下一次生成请求时被回收。

部署生成 Edge Function：

```bash
supabase functions deploy jiwang-generate --project-ref <project-ref>
```

该函数要求 JWT 登录验证，并使用 Supabase 托管环境变量 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`。不要把 service role key 复制到前端。若通过 Supabase Dashboard / 管理工具发布，也必须启用 JWT 验证。函数目录内的 `shared.ts` 会随函数一起部署。

完成迁移与函数部署后，在 `/admin` 的“模型与系统”新增或检查模型，填写 HTTPS Base URL、模型 ID、汪币价格，保存 API Key，再启用并保存模型设置。现有旧密钥已经绑定到原来的 `gpt-image-2.5` 配置，不会自动启用；可先用管理员提供的测试模型/测试账户进行验证。

## Vercel 前端部署

项目使用 Vite 构建，Build Command 为 `npm run build`，Output Directory 为 `dist`。在 Vercel 设置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，并在 Supabase Auth 的 Site URL / Redirect URLs 配置对应域名。Vercel 项目需保留现有管理员环境变量 `JIWANG_ADMIN_USERNAME`、`JIWANG_ADMIN_PASSWORD` 与 `JIWANG_ADMIN_SESSION_SECRET`。部署前端代码后，同一域名即可使用 `/` 和 `/admin`。

## 已知限制

- 管理员登录的失败限流保存在单个服务实例内存中；多实例或冷启动后会失效。需要强约束时，应改用共享存储（如 Redis 或数据库）。
- 管理员会话为无状态签名 Cookie，登出只清除 Cookie；泄露的会话在 12 小时内仍有效。
- Edge Function 的地址检查只基于主机名字符串，不做 DNS 解析；DNS 重绑定等网络层风险需要在出口网络侧控制。
- “邮箱注册”开关只隐藏前台入口；真正禁止注册还需在 Supabase Auth 中关闭。
- 用户上传的参考图会保留在私有存储中，目前没有自动清理策略。
- 生成请求没有用户级的频率或并发限制；成本上限只受汪币余额约束。
- 主题预设目前由创作工坊内置，后台暂不提供编辑。
