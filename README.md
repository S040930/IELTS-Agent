# IELTS 自学 Demo

学术类 IELTS 听力与阅读学习工作台，支持 AI 每日小题组计划、逐题计时、错题复习、能力画像和 AI 导师。项目可本机运行，也可作为单人共享档案应用部署到 Vercel。

## 本机运行

- Node.js 22.13 或更新版本；macOS、Windows 或 Linux。
- `npm ci` 后复制 `.env.example` 为 `.env`，再运行 `npm run dev`。
- 浏览器打开 http://127.0.0.1:5173。学习数据保存在 `.data/learning.sqlite`。
- AI 使用 `.env` 中的 `IELTS_AI_BASE_URL`、`IELTS_AI_MODEL` 和 `IELTS_AI_API_KEY`。

本机数据不会自动上传到云端。题库内容包和安装说明见 [docs/content-package.md](docs/content-package.md)。

## Vercel 云端部署

需要 Vercel、Neon Postgres、Vercel Blob 和兼容的 AI 服务账号。云端首次启动时建立空白学习档案；本机 `.data/learning.sqlite` 不会迁移。

部署、环境变量、数据库初始化和私有音频上传步骤见 [docs/deploy-vercel.md](docs/deploy-vercel.md)。Vercel 函数中添加新插件后需重新部署。

## 项目文档

- [PROJECT.md](PROJECT.md)：架构、入口、设置和文档索引。
- [docs/deploy-vercel.md](docs/deploy-vercel.md)：云端部署、鉴权、内容上传及限制。
- [docs/plugins.md](docs/plugins.md)：插件 SDK 和生命周期。
- [docs/content-package.md](docs/content-package.md)：题库包结构和本机安装。
- [docs/learning-system.md](docs/learning-system.md)：画像、计划、复习和本机数据。
