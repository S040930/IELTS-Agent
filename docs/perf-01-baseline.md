# PERF-01 核心交互响应速度：基线、修复与复测（2026-10-26）

## 结论

首屏和每次 `/api/bootstrap` 的主要成本来自“把整个题库随学习数据一起下发”：307 份材料、3,636 道题、3.55MB。页面只用到材料标题、难度、题数和音频地址，正文与题目在开始/恢复练习时本来就会单独返回。改为只下发练习目录摘要后，首屏可交互时间从 **3.69s 降到 0.87s**（4G 模拟），bootstrap 从 **3.55MB / 3.06s 降到约 0.2MB / 0.25s**。

服务端每次 bootstrap 还会先重算 823 个规划单元（123ms CPU，每次都在算，和当天是否已有方案无关）。改为先做一次轻量的“当天方案是否已存在”判断，并把逐单元重复构建的题目索引提到循环外后，常规 bootstrap 降到 **约 3ms**，当日首次约 **16ms**。

## 测试方法

- 本机生产构建（`npm run build` + `node --import tsx server/start.ts --production`）。
- 数据目录为 `.data` 的临时副本，音频与题库使用符号链接；`IELTS_AI_BASE_URL` 指向一个不可用端口，避免触发真实模型调用。
- API：`node tools/perf-bench.mjs <baseUrl> 3`，同一路径重复 3 次取最好值。
- 浏览器：Chrome 154 headless，通过 CDP 驱动，`PERF_THROTTLE=4g` 表示 10Mbps 下行 / 80ms RTT；`PERF_RESUME=1` 额外验证刷新后草稿恢复。脚本为 `tools/perf-browser.mjs`。
- 题库：307 份材料、3,636 道题；测试数据目录在学习过程中累计了多轮作答记录。

## 基线

### API（本地回环）

| 步骤 | 耗时 | 响应体 |
|---|---:|---:|
| auth session | 0.5ms | 0KB |
| bootstrap | 138ms | **3.41MB** |
| bootstrap（重复） | 140ms | 3.41MB |
| plan status | 0.4ms | 0KB |
| 开始练习 | 1.6ms | 3KB |
| 保存草稿 | 0.6ms | 0KB |
| 恢复练习 | 0.2ms | 3KB |
| 提交 | 0.9ms | 2KB |
| bootstrap（提交后） | 134ms | 3.41MB |
| 模考准备 | 2.8ms | 24KB |
| 打开 Tutor 对话历史 | 0.2ms | 0KB |

### 浏览器（4G 模拟）

| 路径 | 基线 |
|---|---:|
| 首屏可交互（`.app-frame`） | **3,686ms** |
| `/api/bootstrap` | 3,056ms / 3.55MB |
| 打开考前准备 → 材料校验完成 | 1,384ms |
| 点击开始练习 → 答题界面出现 | 454ms |
| 切题（题号导航） | 纯前端 |
| 保存答案（含 400ms 防抖） | 90ms |
| 提交 → 结果页出现 | 120ms |
| 打开 AI Tutor（含历史） | 14ms + 87ms |

## 主要瓶颈与修复

1. **bootstrap 携带完整题库正文与题目**
   - `makeBootstrap` 对全部材料执行 `toPublicActivity`：文章 0.90MB、题目 2.38MB。
   - 前端只用到 `id / pluginId / title / description / minutes / difficulty / part / sample / questionCount / 音频地址`；开始练习、恢复练习、模考准备/开考接口本来就会返回完整 `PublicActivity`。
   - 新增 `ActivitySummary` 与 `activitySummary()`（[src/shared/domain.ts](../src/shared/domain.ts:57)），bootstrap 改为下发摘要（[server/index.ts](../server/index.ts:272)），开始模考时在客户端把完整材料转成摘要。

2. **每次 bootstrap 都重算规划输入**
   - `requestAiPlan` 原先无条件读取 8 组学习数据并构建 823 个规划单元，最后才由 `beginPlanProposalIfIdle` 判断“当天已有方案、无需生成”。
   - 现在先读一次 `planProposals` 单行，按 `planDate / status / 120s 过期 / retryFailed` 做与事务内相同的短路判断（[server/index.ts](../server/index.ts:210)），常规请求不再进入重计算。

3. **规划单元逐项重建题目索引**
   - `estimatedMinutes` 对每个候选单元都从全部材料重建 3,626 条题目 Map（823 次）。
   - 改为在 `buildPlanningUnits` 内构建一次并传入（[server/services/planning-units.ts](../server/services/planning-units.ts:100)）。单次构建 **123.3ms → 13.8ms**。

4. **考前准备页预载 1.5MB 试音文件**
   - 试音 `<audio>` 原先 `preload="metadata"`，且属性顺序可能让浏览器先看到 `src` 再看到 `preload`，进入准备页即开始拉取 1.5MB WAV。
   - 改为 `preload="none"` 且放在 `src` 之前，只有点击 Play 才加载（[src/components/ExamPreparation.tsx](../src/components/ExamPreparation.tsx:74)）。

5. **进入答题页时插件模块串行下载**
   - 工作区需要依次加载 `browser.mjs → exam-ui.mjs → mock-audio.mjs`。
   - 打开考前准备时预取插件入口模块（[src/App.tsx](../src/App.tsx:162)），准备页停留期间完成下载；进入工作区时直接复用模块缓存。

6. **启动恢复流程串行**
   - 原流程：`authSession → bootstrap → resumeAttempt`。
   - 现在认证完成后并行发起 bootstrap 与草稿恢复（[src/App.tsx](../src/App.tsx)），少一个往返；刷新后草稿恢复仍走同一接口。

7. **提交后等待完整 bootstrap 才结束忙碌态**
   - 提交成功后结果已落库并立即渲染；原实现继续 `await refresh()` 才清除 `busy`。
   - 现在提交落库后立即返回，后台刷新学习数据（[src/App.tsx](../src/App.tsx:214)），刷新失败只提示、不回滚提交结果，避免把已成功的提交误报为失败而触发重试。

8. **点击反馈与重复触发**
   - 手动提交显示“Submitting…”遮罩并保持界面不可交互，自动交卷仍沿用原超时流程。
   - Tutor 发送增加 ref 级防重，发送/加载中显示“正在组织回复…/正在加载对话…”。
   - “查看复盘”显示“打开中…”，模考按钮显示“准备中…”，计划确认显示“处理中…”，错因确认显示“保存中…”并防重复点击。

## 复测

### API（本地回环）

| 步骤 | 优化后 | 响应体 |
|---|---:|---:|
| bootstrap | **3.2ms** | **145KB** |
| bootstrap（重复） | **2.7ms** | 145KB |
| bootstrap（提交后） | **2.4ms** | 147KB |
| bootstrap（当日首次，含规划） | **15.6ms** | 127KB |
| 开始练习 | 2.2ms | 3KB |
| 保存草稿 | 0.7ms | 0KB |
| 提交 | 1.2ms | 2KB |
| 模考准备 / 开考 | 2.2ms / 1.0ms | 28KB / 29KB |

> 145KB 为测试库仅有 4 条作答记录时的体积；作答记录累计到 40 条时约 205–212KB（见下）。题库目录本身约 127KB。

### 浏览器（4G 模拟）

| 路径 | 基线 | 优化后 | 变化 |
|---|---:|---:|---:|
| 首屏可交互 | 3,686ms | **866ms** | −76% |
| `/api/bootstrap` | 3,056ms / 3.55MB | **251–420ms / 0.2MB** | −93% 传输量 |
| 材料校验完成 | 1,384ms | **364ms** | −74% |
| 开始练习 → 答题界面 | 454ms | **108ms** | −76% |
| 保存答案（含防抖） | 90ms | 83ms | 基本不变 |
| 提交 → 结果页 | 120ms | 123ms | 基本不变 |
| AI Tutor 打开 | 14ms | 11ms | 基本不变 |
| 刷新 → 草稿恢复 | 3.7s（等价首屏） | **1.2s** | 恢复 1 道已答题目，进度显示 `Answered 1 / 5` |

首屏 JS/CSS 未改：`index.js` 295KB（gzip 92KB）、`index.css` 92KB（gzip 18KB）。

## 验收

- `npm test`：47 项全部通过；新增“bootstrap 不包含文章正文与题目正文、开始练习时才返回”的回归测试。
- `npx tsc --noEmit` 通过。
- 浏览器走查：答题 → 400ms 防抖后草稿保存请求成功 → 刷新页面 → 工作区恢复、选项与进度保留 → 提交 → 结果页出现；控制台无报错。
- 判分、草稿恢复、逐题用时与考试计时逻辑未改动；提交接口保持幂等（重复提交返回既有结果）。

## 后续可选优化

- **听力音频缓存**：本地媒体响应为 `no-store`，重复打开同一材料会重新下载约 8MB 音频。可评估使用 `private, max-age=0, must-revalidate` + ETag 的私有缓存（当前未改，避免改变媒体权限语义）。
- **bootstrap 中的作答历史**：`attempts(40)` 携带每份作答的全部 responses，累计后约 200KB；若继续增长可改为摘要 + 服务端计算 Tutor 所需的历史错题数。
- **插件静态资源**：`/plugin-assets/*` 使用 `no-cache` 但没有 ETag，重复页面会话需要完整下载 89KB；可补 ETag/304。
- **首屏代码分割**：当前单包 295KB；如需进一步压缩首屏，可按页面拆分，但收益小于本轮的 bootstrap 修复。

## 复现命令

```bash
# 隔离数据目录
mkdir -p /tmp/ielts-perf/data
cp .data/learning.sqlite /tmp/ielts-perf/data/
ln -s "$PWD/.data/content" /tmp/ielts-perf/data/content
ln -s "$PWD/.data/media" /tmp/ielts-perf/data/media

# 生产构建 + 性能服务（AI 指向不可用端口，避免真实调用）
npm run build
IELTS_DATA_DIR=/tmp/ielts-perf/data IELTS_SERVER_PORT=4180 \
  IELTS_AI_BASE_URL=http://127.0.0.1:9 IELTS_AI_API_KEY=perf-noop \
  node --import tsx server/start.ts --production
```

```bash
node tools/perf-bench.mjs http://127.0.0.1:4180 3
PERF_THROTTLE=4g PERF_RESUME=1 node tools/perf-browser.mjs http://127.0.0.1:4181
```

> `perf-bench.mjs` 会创建并提交练习记录，请只对一次性数据目录运行。
