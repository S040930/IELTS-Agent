# Vercel 云端部署

云端使用 Vite 静态前端、Node.js Function、Neon Postgres 和私有 Vercel Blob。用户自行注册，登录后可在不同设备访问本人的学习历史和 AI 用量。题库供所有登录账号使用。

## 需要准备

- Node.js 22.13 或更新版本。
- Vercel 项目及 CLI；本文使用固定版本 `npx --yes vercel@65.1.0`。
- 一个 Neon Postgres 数据库，并取得 `DATABASE_URL`。
- 一个私有 Vercel Blob Store，取得 `BLOB_READ_WRITE_TOKEN`。
- AI 服务兼容现有 OpenAI 风格 Chat Completions API。

## 创建云端服务

1. 在 Vercel 控制台导入此目录为项目；也可在项目根目录运行 `npx --yes vercel@65.1.0 link`。构建命令为 `npm run build`，输出目录为 `dist`。
2. 通过 Vercel Marketplace 将 Neon 与项目连接。连接后确认 `DATABASE_URL` 已添加到 Preview 和 Production 环境。
3. 在 Vercel Storage 创建 Blob Store，并把 `BLOB_READ_WRITE_TOKEN` 加到项目环境变量。题库音频以私有对象保存，仅由登录后的媒体代理读取。
4. 添加以下服务端环境变量，勿添加 `VITE_` 前缀：

   | 环境变量 | 用途 |
   |---|---|
   | `DATABASE_URL` | Neon Postgres 连接字符串 |
   | `BLOB_READ_WRITE_TOKEN` | 私有 Blob 读写令牌 |
   | `IELTS_AI_BASE_URL` | AI API 根地址，例如 `https://host/v1` |
   | `IELTS_AI_MODEL` | 规划与导师使用的模型名称 |
   | `IELTS_AI_API_KEY` | AI 服务密钥 |
   | `IELTS_AI_INPUT_USD_PER_MILLION` | 文本模型输入单价，可选 |
   | `IELTS_AI_OUTPUT_USD_PER_MILLION` | 文本模型输出单价，可选 |
   | `IELTS_AI_CACHED_INPUT_USD_PER_MILLION` | 文本模型缓存输入单价，可选 |
   | `DASHSCOPE_API_KEY` | 百炼实时口语密钥，可选 |
   | `IELTS_REALTIME_HOST` | 百炼北京或新加坡业务空间域名，可选 |

   三个文本费率变量的单位均为美元／百万 tokens。所有变量只由 Node Function 读取。

5. 本地完成 Vercel 项目关联后，按需把可读取的项目环境变量下载到未跟踪的文件，避免覆盖已有本机 AI 配置：

   ```sh
   npx --yes vercel@65.1.0 env pull .env.cloud.local --environment=production
   ```

   Vercel 的 sensitive 变量不可回读，拉取结果中的 `[SENSITIVE]` 不能用于连接数据库。数据库初始化与题库上传需通过进程环境，或未跟踪的 `.env.local`，提供有效的 `DATABASE_URL` 与 `BLOB_READ_WRITE_TOKEN`。已有云端题库且内容未变时无需重新上传音频。随后初始化并部署：

   ```sh
   npm ci
   npm run cloud:migrate
   npm run content:upload-cloud
   npx --yes vercel@65.1.0 deploy --prod
   ```

## 数据库与内容初始化

`npm run cloud:migrate` 优先使用进程环境，其次读取 `.env.local`、`.env`，以 `DATABASE_URL` 迁移题库、账号、会话、用量和学习数据结构。迁移在事务中执行，可重复运行。旧共享档案留在旧归属下，旧会话失效。请使用独立 Neon Preview 数据库验收，再协调应用版本和数据库迁移同步上线。旧版应用依赖原有主键结构，回滚时需切回升级前的数据库分支。

`npm run content:upload-cloud` 从 `.data/content/activities.json` 读取题目清单，校验活动结构、ID 唯一性和全部音频引用，然后逐个流式上传 `.data/media/` 中被引用的音频到私有 Blob，最后幂等写入 Neon 活动清单。它不读取 SQLite，不上传草稿、作答、计划或导师对话。若使用自定义位置，可设置 `IELTS_CONTENT_CATALOG` 与 `IELTS_MEDIA_DIR`。

云端上传脚本从完整本机清单中过滤非高频及未标频听力练习，云端运行时也隐藏插件自带的示例听力题；本机网页与内容包仍保留全部内容。云端当前将上传 98 个高频/次高频听力音频，共约 822 MB；最大单文件约 13 MB，在 Hobby Blob 的 1 GB 存储额度内留有约 178 MB 空间。命令逐文件流式上传并计算 SHA-256，预计额外内存低于 512 MB、CPU 不超过一个核心；100 Mbps 上行的纯传输下限约 66 秒，实际通常需 2–5 分钟，较慢网络会更久。数据库迁移通常在数秒内完成。中途失败后重新运行会覆盖相同 Blob 路径并再次 upsert 清单。

## 运行行为与限制

- 首次注册后，个人档案从默认目标开始。用户完成设置后，AI 按台北自然日生成当天的任务。
- 学习 API、题目、插件入口与音频媒体代理均要求有效的 HttpOnly、Secure、SameSite Cookie。会话有效期为七天，退出时服务器撤销该会话。登录与注册按来源地址限流。
- 媒体接口代理 Blob 响应并保留 Range 请求，音频不会暴露 Blob URL 或令牌。
- Node Function 对每次请求创建 Neon 客户端；AI 计划任务使用 Vercel `waitUntil`，前端轮询持久化的提案状态。
- Vercel 实例不支持运行时热插拔。插件在 `plugins/` 中随 Function 打包；增加插件后重新部署。
- `/api/*`、`/media/*`、`/plugin-assets/*` 的重写均直接指向 `/api/[...path]`；不要依赖重写后的 `/api/...` 再次匹配重写规则。`functions.excludeFiles` 使用字符串格式。
- 删除或重建 Neon/Blob 会影响云端档案或内容。把环境变量配置到 Preview 时会与 Production 使用相同资源，若需隔离请分别配置独立数据库和 Blob Store。

## 本机与云端分离

本机仍可运行 SQLite 版本。部署过程从不复制 `.data/learning.sqlite`，也不提交 `.data/`。Neon 保存各账号独立的档案和用量。音频和题目按内容导入命令上传。

## 部署验收

完整交卷测试使用临时 Neon 数据库，只复制题库，不复制学习档案。可用 `deploy --prod --skip-domain` 创建不绑定正式域名的暂存生产部署，单独覆盖 `DATABASE_URL`、测试登录配置并关闭测试用 AI 请求；Blob 保持生产环境原有配置，仅进行音频读取。不要把生产 Blob 读写令牌复制到预览环境。媒体代理显式使用已配置的 Blob 令牌，避免 SDK 自动选择其他凭据。

验证组卷、快照、草稿、判分、复习、真实音频 Range 与浏览器考试流程后，再以正常生产配置部署并绑定正式域名。在正式域名检查登录、题库、插件和媒体，并比较原草稿；用两个验收账号分别检查草稿、结果、口语复盘和模型用量。验收结束移除临时部署，再删除该临时数据库。

AI 验收需要一次真实导师请求；`aiConfigured: true` 仅表示三个配置项存在，不能证明模型仍可用。模型停用时先核对同一服务当前模型列表，在取得模型切换授权后更新 `IELTS_AI_MODEL` 并重新部署；不自动回退到其他模型或付费型号。
