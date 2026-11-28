# IELTS 自学 Demo

学术类 IELTS 听力与阅读学习工作台，支持 AI 每日小题组计划、逐题计时、错题复习、能力画像和 AI 导师。项目可本机运行，也可部署到 Vercel。注册后，每个账号拥有自己的学习档案。

## 本机运行

- Node.js 22.13 或更新版本；macOS、Windows 或 Linux。
- `npm ci` 后运行 `npm run dev`。
- 浏览器打开 http://127.0.0.1:5173。新用户使用邮箱和密码注册，已有账号可以用原用户名登录。账号和模型用量保存在 `.data/accounts.sqlite`，学习记录保存在 `.data/users/`。
- 如需启用文本 AI，请创建 `.env` 并设置 `IELTS_AI_BASE_URL`、`IELTS_AI_MODEL` 和 `IELTS_AI_API_KEY`。

本机数据不会自动上传到云端。题库内容包和安装说明见 [docs/content-package.md](docs/content-package.md)。

## AI 用量与费用

登录后打开「设置 → AI 用量与费用」，按模型查看当前账号的累计输入 tokens、输出 tokens 和美元估算费用。

- 文本模型统计每日计划和 AI 导师的请求。按当前文本供应商的实际单价设置 `IELTS_AI_INPUT_USD_PER_MILLION` 和 `IELTS_AI_OUTPUT_USD_PER_MILLION`，单位为美元／百万 tokens。可选填 `IELTS_AI_CACHED_INPUT_USD_PER_MILLION`，否则缓存输入使用普通输入费率。明确免费的模型可填写 `0`。缺少费率时仍保留 tokens。
- 实时口语按 WebRTC `response.done` 事件和百炼北京／新加坡的公开费率估算。浏览器转报所接收的模型事件，断线时可能缺少部分事件。供应商折扣、套餐和单独计费项目以服务商账单为准。[百炼实时模型定价](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime)
- 已记录费用使用调用时的费率。早于此版本的调用没有可分配给个人账号的用量记录。

## Vercel 云端部署

需要 Vercel、Neon Postgres、Vercel Blob 和兼容的 AI 服务账号。新注册账号从默认设置和空白历史开始。

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

从百炼控制台复制与密钥同地域的业务空间域名（北京或新加坡），并开通 `qwen3.8-omni-flash-realtime`。通过 HTTPS 或本机 localhost / 127.0.0.1 打开网页并允许麦克风。后端为浏览器转发 SDP 握手，浏览器与模型直接交换音频。历史复盘仅由当前账号访问，应用只保存文字。

接入协议和地域域名见[百炼 WebRTC 接入文档](https://help.aliyun.com/zh/model-studio/omni-realtime-webrtc-access)。
