# API-01 实施与验证记录

基准：S040930/IELTS-Agent，main，1b9ff4712e50b6809fbd194b0d94d171cc416140。
状态：已提交到独立分支，依赖版本与数据库表结构未改变，尚未合并或部署。

PR：https://github.com/S040930/IELTS-Agent/pull/1
实现提交：https://github.com/YMYWX/IELTS-Agent/commit/93897b92fce35f69a6e0340979c20abeaea0cf4f

## 本次实现

- 设置表单使用独立 dirty/saved 状态；后台 bootstrap 不覆盖未保存字段，失败保留输入。
- 状态轮询改为上次完成后再等待 2.5 秒，不重叠请求；退出、操作开始或状态改变时取消旧轮询。
- bootstrap 使用请求代次，丢弃被后续操作取代的响应；错误提示提供手动“核对状态”。
- 请求增加 30 秒截止时间，以及 bootstrap、proposal 的基础响应结构校验；写请求超时不自动重发。
- 生成超过 120 秒时返回 recoverable，界面提供“恢复规划”；retry 仅能恢复陈旧 generating 或重试 failed，仍使用数据库原子门禁。
- 云端 bootstrap 的重复 ensurePlan 入口移除。规划入口先判断当天状态，已确认等终态不再构造候选和扫描规划历史。
- 重试通过一次 makeBootstrap(true, true) 准备规划输入。
- 候选时长估算一次建立全题库索引和题型／能力计时统计，候选间复用。
- 规划服务使用白名单 DTO，不发送自由错因文本、历史任务标题／描述／理由或题库标题；保留统计画像、目标、ID、题组、时长等元数据。
- 服务端候选排除与锁定／完成任务重叠的题目；规划输出和最终确认再次检查重复题目。
- SQLite 与 Neon 在应用事务内检查日期、预算、保留任务、重复题目和空方案。失败只更新方案状态，不替换有效计划。
- Neon 确认锁住 proposal、profile 和当天已有 task 行后再校验和替换；条件更新失败必须回滚。
- 同日相同方案的重复确认／暂不应用允许核对已有成功结果，避免响应丢失后反复报“已失效”。
- 目标、确认／暂不应用、任务更新已落库但 bootstrap 失败时，返回 applied=true 和明确的“已保存但刷新失败”提示。

## 保留的业务规则

确认后当天固定；目标修改与新学习证据不重排 confirmed 方案。
规划请求失败、无效输出、预算失败、空／损坏方案均保留原有效计划。
新题范围、关联题组、到期复习、服务端时长、生成资格与旧结果隔离继续保留。
旧日未完成任务过期、同日保留锁定／完成任务的既有规则未改变。

未改变确认前 ready 方案在修改目标后是否重生成的产品规则。
未重定义任务状态 API 的 done → pending 能力；本次保护针对规划生成与应用。
未合并 evidence / attemptedQuestionIds / questionTimingSamples 的底层历史查询，留给 PERF-01 协调优化。

## 请求与计算对比

以下入口次数来自控制流；有标记的行为由本地 mock HTTP / 临时 SQLite 用例断言，不是生产观测。

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 保存目标 | 1 PUT，无额外前端 bootstrap | 保持 1 PUT；客户端接共享路由用例已断言 |
| 失败后重试的 planningInput | 一次显式生成 + 一次 bootstrap，共 2 次 | 1 次；本地计数用例已断言 |
| 云端 idle bootstrap 的规划入口 | handler ensurePlan + makeBootstrap，共 2 次 | 仅 makeBootstrap |
| 同日 confirmed bootstrap 的 planningInput | 先构造 1 次，再由仓储拒绝生成 | 0 次；本地聚合调用计数已断言 |
| 单次候选构造中的全题库索引 | 每个候选重建 | 1 次并复用 |
| 状态轮询 | 固定 setInterval，慢请求可重叠 | 完成后调度下一次，在途至多 1 次；计时器测试已断言 |
| 同次有效生成资格的规划请求 | 至多 1 次 | 保持至多 1 次；并发 bootstrap 测试已断言 |

没有测量 p50 / p95、生产 SQL 数量或真实模型耗时，不声称任何延迟降低百分比。

## 自动化验证

在 Node v24.21.0 中使用原生 TypeScript 转换和仅解析本地 .js → .ts 的 registerHooks 运行：

```sh
node --experimental-transform-types --import ./tools/test-native-register.mjs --test test/*.test.ts
```

69 项测试通过：原有 46 项，API-01 新增 23 项。新增测试覆盖：

- 客户端 API 对接真实共享路由 DTO、保存目标请求次数；
- 当日固定、并发生成去重、重复确认；
- 规划失败保留旧计划、一次重试输入；
- 陈旧生成恢复与旧结果隔离；
- 提交成功但读取失败；
- 最新预算、锁定／完成范围、跨日确认、插入失败回滚、损坏／空方案保护；
- 规划输入敏感哨兵、固定任务去重、估时结果；
- Neon 记录型 Client 的锁顺序、拒绝路径和回滚协议；
- dirty 表单状态、轮询互斥／取消／错误恢复、响应结构与超时不重发。

Neon 用例为记录型 Client，并非真实 Postgres 集成或并发验收。
前端状态帮助函数已测，不等于 React 页面浏览器验收。

## 远端验证与后续验收

- 远端 npm ci、npm run typecheck、npm test 和 npm run build 均已通过。
- 检查记录：https://github.com/YMYWX/IELTS-Agent/actions/runs/39954114457
- 标准 npm test 与本地原生 runner 均已通过 69 项测试。
- React 页面、双击交互、窄屏提示布局和真实响应乱序的浏览器验证：待验证。
- 隔离 Neon 上的真实事务、死锁／并发以及 Vercel 生命周期：待验证。
- 大题库与大量历史数据的性能基线：待验证。

远端仅安装锁定依赖并执行检查，没有连接生产数据库或项目生产接口。

## 与 PERF-01 的协调

高重叠文件：server/index.ts、src/App.tsx、src/services/api.ts、
server/services/planning-units.ts、两套 store 与 test/core.test.ts。
本次已包含门禁前置与候选索引复用。后续历史聚合／缓存应在这些改动上继续，
不能缓存掉每日确认门禁或移除最终事务校验。

## 补丁使用

API-01.patch 包含本次修改与新增源码、测试及本记录。
在基准提交的真实仓库根目录先执行：

```sh
git apply --check /absolute/path/to/API-01.patch
git apply /absolute/path/to/API-01.patch
```

不应直接覆盖组员的新改动；若 main 已推进，先核对差异再应用。
本地目录是连接器读取的文本源码副本，没有 Git 历史，也没有下载二进制音频。
补丁不包含删除或修改音频、依赖锁文件或数据库的操作。
