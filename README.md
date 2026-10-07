# 极汪 · AI 表情创作工作台

基于 **Vue 3、Vite、TypeScript、Element Plus、Pinia、Vue Router** 的响应式单页应用。当前版本落实上传角色图、16 格主题草案、逐格编辑、画面选项、浏览器端演示生成、4×4 单图切分、素材 ZIP 下载、资产库和生成历史。

## 当前能力边界

- 目前尚未接入真实图像模型。`src/lib/mockGenerator.ts` 是清晰隔离的 Mock Provider：在浏览器画布中合成演示贴图，不会把图片或提示词提交给第三方推理服务，也不会扣汪币。
- 未配置云端时，用户可以本机预览和下载；生成记录与 PNG 暂存在当前浏览器。登录按钮只有在 Supabase 配置完成后才启用邮箱注册/登录。
- 配置 Supabase 后，参考图和生成贴图会进入私有 Storage；资料、任务及资产元信息保存在 Postgres。迁移开启 Row Level Security，按 `auth.uid()` 隔离用户记录和存储目录。
- 不包含真实扣费、订单、会员、广场发布/审核或邀请奖励。

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
3. 在 Supabase SQL Editor 中执行 [`supabase/migrations/20261008070000_initial.sql`](supabase/migrations/20261008070000_initial.sql)。迁移会创建 `profiles`、`generation_jobs`、`assets` 表，开启用户级 RLS，并创建私有 `jiwang-private` Storage bucket。
4. 在 Supabase Auth 配置中启用 Email provider，并按需要设置邮箱确认和站点回跳 URL。生产环境的 Site URL 与重定向白名单需包含 Vercel 域名。
5. **不要**将 Supabase `service_role` key 放进 `VITE_*` 变量或浏览器代码；它绕过 RLS。前端仅用公开 anon/publishable key，数据授权由 RLS 和 Storage policy 限制。

## Vercel 部署

1. 将 `jiwang-workbench` GitHub 仓库导入 Vercel。
2. Framework Preset 选择 **Vite**；Build Command `npm run build`；Output Directory `dist`。
3. 在 Vercel Project → Settings → Environment Variables 添加 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`，然后重新部署。
4. 将 Vercel 域名添加到 Supabase Auth 的站点 URL / Redirect URLs。

仓库含有 `vercel.json` 深层路由重写。每次变更前端环境变量后都需重新构建部署。

## 真实模型接入点

当前 `generate()` 流程先建立 16 格草案，再将角色图、逐格 caption 与 visual、选项传给 `src/lib/mockGenerator.ts`。后续将其替换为 `GenerationProvider` 接口，并通过 Vercel Function 或 Supabase Edge Function 调用服务端模型；**模型 API 密钥必须只保存在服务端环境变量中**。异步任务状态继续映射到 `generation_jobs`，模型输出按 4×4 边界/网格切成 16 张后存入私有 bucket。

## 校验

```bash
npm run typecheck
npm test
npm run build
```
