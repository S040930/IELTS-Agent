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

## 实时口语练习

在「口语练习」选择分段和话题，点「播放口语演示」可观看完整示例。九个话题均附本地双人配音、动态字幕和示例复盘，可暂停、重播或静音。演示无需百炼密钥或麦克风，结果仅在本次页面展示。

本机在项目根目录的 `.env` 设置以下两项。Vercel 使用同名的服务端环境变量，修改后重新部署。口语和文字 AI 导师分别配置。

```dotenv
DASHSCOPE_API_KEY=你的百炼密钥
IELTS_REALTIME_HOST=你的业务空间ID.cn-beijing.maas.aliyuncs.com
```

从百炼控制台复制与密钥同地域的业务空间域名（北京或新加坡），并开通 `qwen3.8-omni-flash-realtime`。通过 HTTPS 或本机 localhost / 127.0.0.1 打开网页并允许麦克风。后端为浏览器转发 SDP 握手，浏览器与模型直接交换音频。历史复盘在当前共享学习档案中对登录者可见，应用只保存文字。

接入协议和地域域名见[百炼 WebRTC 接入文档](https://help.aliyun.com/zh/model-studio/omni-realtime-webrtc-access)。
