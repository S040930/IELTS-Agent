# IELTS 自学 Demo

## 架构与入口

- React、Vite、TypeScript 前端；Node.js 业务服务提供练习、判分、AI 规划与导师。
- 本机运行使用 SQLite；Vercel Function 使用 Neon Postgres、私有 Blob、密码会话认证。
- `api/[...path].ts` 是 Vercel Function 入口，`server/index.ts` 共享业务路由，`server/postgres-store.ts` 是云端学习仓储。
- `plugins/` 保存插件；云端构建将插件打包，新增插件需重新部署。
- 本机启动和云端部署分别见 README 的对应章节。

## 长期决策

- 云端只有一个共享学习档案；第一次部署为空档案，不迁移本机 `.data/learning.sqlite`。
- 题目清单导入 Neon，音频流式上传到私有 Blob；个人作答和目标留在 SQLite 或 Neon 数据库，不进内容包。
- 登录、AI 密钥和 Blob 令牌只由服务器读取；题目 API 移除答案与解析，媒体请求通过登录鉴权代理。
- 所有 npm 依赖精确锁定；运行和开发依赖分开。
- 个性化计划按台北自然日生成单日小题组；任务存储题目 ID，练习范围和关联题组由服务端校验。近 30 天证据优先；当天确认后固定到次日。升级时将无题目范围的旧计划任务标为过期。
- 题库按真实雅思结构标注分段：听力 Part 1–4 各 10 题，阅读 Passage 1–3 合计 40 题。专项练习保留完整题组，组合模拟卷按分段切换对应材料与题目。
- 本机网页和内容包保留完整题库；云端上传只导入高频、次高频听力练习，并隐藏内置示例听力题，确保云端听力列表只展示这两个频率层级。
- 听力练习页按 `groupId` 将题目呈现为完整题组，音频控制保持在作答区上方，题号导航固定在底部；听力原文与逐题解析不随公开题目数据下发，专项练习与错题复习通过 attempt 接口按需加载，完整模考期间不可查看。
- 阅读与听力提交后保留原答题工作区与题号导航，在题目原位标示正确、错误和未作答状态，并折叠展示证据与解析；答案与判分继续来自现有 attempt 提交结果。
- 阅读与听力的原位反馈页仍可打开笔记、调整字号和使用 AI 导师；听力提交后保留原文与逐题解析入口。听力逐题证据可一键在原文中定位答案句，原文按题号高亮并可切换显示、用上一处/下一处浏览；已提交答案保持锁定，计时重置仅在作答期间可用。
- 分段字段由 `content:tag-parts` 从练习描述与题号区间推导，写入 `imported_activities.activity_json`（题库以 JSON blob 存储，无需数据库迁移），再经 `content:export` 产出内容包。完整模考从分段材料随机组合，并明确标注组合模拟卷；规则与接口见 `docs/computer-exam.md`。
- 机考答案与逐题用时继续通过现有草稿 API 写入服务端，并由现有提交接口判分；文章/题干高亮与笔记按 attempt 保存在当前浏览器本地，字号作为浏览器级偏好保存，不发送到服务端或数据库。放弃 attempt 时清除该 attempt 的本地标注。
- 每次完成考前准备并正式开始练习才创建新 attempt；只有本地活动指针可恢复原 attempt。明确退出会将服务端草稿标为 abandoned，避免旧答案和用时复用；意外中断仍可恢复原 attempt。
- 练习与模考共用全屏机考工作区；正式开始前显示说明和听力试音。模考准备不创建 attempt，SQLite 与 Neon 的 `mock_papers` 保存完整试卷快照；开考时固定时长，恢复使用同一卷和截止时间。听力模考按绝对时间顺序单次播放，录音结束后统一检查 2 分钟；练习保留回放与 AI 导师。
- 模考倒计时与音频时间线共用服务端校准时间，避免本机时钟偏差增加考试时间。线上完整交卷验收使用独立临时 Neon 数据库与预览部署。

## 文档索引

- [docs/computer-exam.md](docs/computer-exam.md)：机考界面、准备与交卷流程、组卷快照、计时和音频恢复规则。
- [README.md](README.md)：本机安装、启动与项目入口。
- [docs/deploy-vercel.md](docs/deploy-vercel.md)：Vercel、Neon、Blob、密钥与云端题库初始化。
- [docs/deployment-acceptance-2026-10-23.md](docs/deployment-acceptance-2026-10-23.md)：本轮线上部署、隔离验收、AI 模型恢复和数据清理记录。
- [docs/plugins.md](docs/plugins.md)：插件 SDK 和生命周期。
- [docs/content-package.md](docs/content-package.md)：本机内容包结构和组员安装。
- [docs/learning-system.md](docs/learning-system.md)：画像、计划、复习和本机学习数据。

- [docs/computer-exam.md](docs/computer-exam.md)：机考界面、准备与交卷流程、组卷快照、计时和音频恢复规则。
- [README.md](README.md)：本机安装、启动与项目入口。
- [docs/deploy-vercel.md](docs/deploy-vercel.md)：Vercel、Neon、Blob、密钥与云端题库初始化。
- [docs/deployment-acceptance-2026-10-23.md](docs/deployment-acceptance-2026-10-23.md)：本轮线上部署、隔离验收、AI 模型恢复和数据清理记录。
- [docs/plugins.md](docs/plugins.md)：插件 SDK 和生命周期。
- [docs/content-package.md](docs/content-package.md)：本机内容包结构和组员安装。
- [docs/learning-system.md](docs/learning-system.md)：画像、计划、复习和本机学习数据。
