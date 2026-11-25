# 前端页面设计分析（2026-11-26）

范围：`src/App.tsx`（1001 行，全部视图）、`src/styles.css`（1431 行，全站样式）、`src/components/`（口语、考前准备、登录、图标）、`src/components/speaking.css`。分析方法为源码走读；本轮环境无法启动浏览器截图（预览沙箱拒绝 Node 进程 `process.cwd()`，Tabbit 无注册实例，本机无 Playwright），视觉结论均来自对样式与 DOM 结构的直接核对。本机 dev 服务当前正在 5173 端口运行，可直接打开对照。

## 1. 总体判断

React 19 + Vite 单页应用，无路由库、无 UI 组件库、无 CSS 框架，全部手写。前端刻意分成**三种视觉人格**，边界清晰：

| 人格 | 用途 | 视觉语言 |
| --- | --- | --- |
| 学习平台面 | 今日学习、题库、口语、画像、设置 | Apple 风格：大圆角、淡染、系统字体、留白 |
| 机考仿真面 | 考前准备 + 全屏机考工作区 | 1:1 复刻 CD IELTS：小圆角、衬线标题、灰蓝工作色、题号条 |
| AI 导师抽屉 | 练习中的侧边对话 | 376px 固定抽屉、聊天气泡、上下文透明面板 |

这个三人格结构是全站设计最重要的一次决策：备考工具需要“低压力、鼓励式”的日常界面，而模考需要“和真机一致”的紧张感，两套语言并存且用局部 CSS 变量作用域（`--exam-*`）干净切换，没有互相污染。

## 2. 设计令牌体系（styles.css ①）

| 类别 | 取值 | 评价 |
| --- | --- | --- |
| 色彩 | page `#f5f5f7`、ink `#1d1d1f`、accent `#0068cc` | Apple 官网同款底色与墨色，链接蓝接近 Apple 品牌蓝 |
| 强调色淡染 | `--accent-weak/-soft/-wash/-tint` + `--selected-surface` 五级 | 全站 hover/选中/面板底色都从这五级取，是最值得抄的做法 |
| 语义色 | success `#217347`、danger `#ad342a`，各配 tint | 正确/错误永远“淡底 + 深字”，不刺眼 |
| 间距 | 4/8/12/16/24/32/48/64 八级 | 没有跳档使用 |
| 圆角 | 10/16/22/pill | 学习面大圆角；机考面另用 4–8px，见 §4 |
| 阴影 | 三档 + 抽屉专用侧影 | 全部低透明度冷灰，无彩色阴影 |
| 字阶 | 12–34px 六档；行高 1.5/1.7/1.85 | 正文 14px 基准，长文 1.78–2.05（机考文章） |
| 焦点环 | 3px `rgba(0,104,204,.40)` offset 3 | 全局 focus-visible 统一 |
| 字体栈 | `-apple-system, PingFang SC, Microsoft YaHei, Segoe UI` | 不引外部字体，零加载成本 |

细节亮点：`::selection` 用 accent-wash（styles.css:96）；数据一律 `tabular-nums`（时钟、题号、分数、统计）。一个隐患：字重用了 530/550/570/590/610/630/650/750 这类非标准值，在 Apple 系统字体上是刻意的微调，但 Windows 上 Segoe UI 会取整到整百，视觉层级会变平。

## 3. 布局骨架

- 固定左栏 232px，`backdrop-filter: blur(18px)`，可整体收起（位移用 `calc(var(--rail) * -1)`，有注释解释为何不用百分比，styles.css:136）；收起状态存 localStorage。
- 主内容 `max-width: 1500px`、上 45px 下 80px padding，页面切换 230ms `page-in` 进场动画（opacity + 4px 位移，克制）。
- 没有全局顶栏：每页自己渲染 `PageHeader`，标题 `clamp(28px, 2.6vw, 40px)`、字距 -1.2px，右侧放 `mode-pill`（日期、计数等元信息胶囊）。
- 导师抽屉打开时不是覆盖而是**推挤**：`.app-frame.coach-open .page-main { margin-right: 376px }`（styles.css:135）。学习页面下这是优点（不遮内容），但在机考工作区里会压缩 100vh 固定高度的考试面，见 §7。
- 加载态是**同构骨架屏**：skeleton-rail + skeleton-main 完全按最终布局的形状画（styles.css:199–210），首屏感知性能好于转圈。

## 4. 机考仿真面（全站设计重心）

`workspace-content.exam-mode` 定义了一套局部令牌（styles.css:394–413）：`--exam-bg: #f2f4f6`、圆角 8/10px、`--exam-accent-weak` 等独立于学习面。关键还原手段：

- **衬线标题**：`.exam-bar-title` 和成绩单标题用 Georgia/Times（styles.css:425、619），正文仍是无衬线——和真实 CD IELTS 的层级感一致。
- **双栏可拖拽**：passage | splitter（14px，col-resize）| questions，底部题号条 `exam-palette`，当前题带方框描边、旗标题右上角用 border 三角形做角标（styles.css:602），组间导航用右下角悬浮箭头。
- **题型级控件还原**：TFNG 竖排圆形单选（styles.css:531–534）、匹配题字母 chip、“字母 + 正文”双列 chip（styles.css:566–572）、填空题下划线输入框带字数计数与超限变橙。
- **状态即时间线**：保存 pill（saving/saved/error）、倒计时 urgent（≤5 分钟变橙）与 expired（变红）三态、`role="timer"` + 条件 `aria-live`。
- **交卷后恢复滚动**：考试中 `height: 100vh; overflow: hidden`，交卷后用 `.exam-mode:has(.exam-report)` 一次性放开（styles.css:414–416），报告自然排布。
- **官方成绩单风格报告**：42px 大分数、五格统计、技能条、逐题表格、错行淡红底——视觉上像一张成绩单而不是一个网页组件。
- **视图快照恢复**：交卷前捕获滚动位置、passage 展开态、音频进度、当前题（App.tsx:522–584），交卷后原位恢复，复盘体验连续。
- **考前准备页**：全屏独立人格，音频预检（每段 20s 超时探测）+ 试音必须播放过才能开考（mock 听力），开考按钮 disabled 门槛清晰。

## 5. 交互与状态设计（亮点）

- **自动保存**：500ms 采样逐题用时、脏数据 ≥5s 才写、revision 单调递增防乱序、`pagehide` keepalive 兜底；UI 只用一个三态 pill 表达。
- **中断恢复**：localStorage 存活动 attempt 指针，刷新后并行恢复；恢复提示条 3.5s 自动淡出；明确退出才标 abandoned，避免旧答案复活。
- **AI 透明度设计**：计划建议面板展示任务明细 + 相对当前计划的增/改/删摘要，确认/暂不双按钮；导师抽屉有“查看带入的学习上下文”折叠面板，把送给模型的内容摊开给用户看——这是很少见的产品诚实度设计。
- **空状态即教育**：错题页空状态直接解释间隔重复节奏（1/3/7/14 天）；画像页坚持“短练习保留原始答对数，不用少量题目猜测 Band 分数”，置信度用 观察中/有一些证据/多次观察 表达——设计在替数据方法论说话。
- **口语页**：题干 `clamp(21px, 3vw, 32px)` 的展示级排版、cues 列表左边线、波形条由真实麦克风电平驱动（160ms 采样）、Part 2 备考/陈述双段计时；`prefers-reduced-motion` 下波形冻结为静态高度。
- **无障碍**：全局 focus-visible 环、选项/chip 用 `:has(input:checked)` 表达选中且保留 `input:focus-visible` 环、忙碌时对宿主容器设 `inert`、reduced-motion 全局kill switch、导航 `aria-current`、筛选 chip `aria-pressed`。

## 6. 响应式

五档断点（1600/1250/900/600/400），策略明确：

- 左栏 232 → 210 → **70（icon-only）** → 59px；900px 以下品牌居中、文案隐藏、折叠钮改流内（有注释说明避让，styles.css:717）。
- 机考面 900px 以下转单列：passage 限高 38vh、题号条横滚、`exam-cell` 放大到 44×42 触控目标。
- 600px 档逐个组件重排（task-row 去掉时间列、library-row 按钮换行、成绩统计 2 列），不是简单缩放。

## 7. 问题清单（按影响排序）

1. **机考面对话框中英混排**：超时对话框标题英文（"Time expired"）+ 正文中文；提交中对话框 "Submitting…" + 中文正文（App.tsx:912–924）；`resetClock` 用英文 `window.confirm`（App.tsx:836）。考试面整体走英文复刻是对的，但**单个对话框内部**混排显得未完成。建议：考试面文案统一全英文（贴近真机），或统一中英双语分行的固定格式。
2. **没有深色模式**：全站 light-only，无 `prefers-color-scheme`。晚间长时间刷题是核心场景，学习面尤其需要；令牌体系已经就绪，补一套深色值成本可控。
3. **CSS 组织漂移**：①–⑨ 编号分节只覆盖到第 846 行，847–1431 约 580 行（fullscreen test workspace、listening practice、shared chrome）游离在编号体系外——它们是给插件挂载 DOM 用的宿主样式，只能放全局表，但至少应并入编号体系（比如 ⑥C）。单文件已 113KB。
4. **抽屉推挤考试面**：练习模式打开 AI 导师时，376px 的 margin-right 会让 100vh 固定的机考双栏突然变窄。建议考试面改为覆盖式（或临时暂停布局压缩）。
5. **无路由**：页面状态只在 useState，刷新回首页、浏览器后退不可用、无法深链某页。Demo 可接受，若走向真实使用需要补 URL 状态。
6. **窄屏 icon-only 栏**：文字仅靠 title 提示，触屏无 hover 即无文字（aria-label 尚在，可访问但视觉上失去可读性）。
7. **填空题焦点环**：`.exam-blank input:focus { outline: none }`（styles.css:578）用下划线变色 + 底色替代焦点环，键盘可见性弱于全站标准；有背景色变化兜底，非硬伤。
8. 小味道：`.plan-no-change` 用 `!important` 覆盖（styles.css:255）。

## 8. 一句话总结

这是一套**没有依赖任何 UI 库却完成了设计系统化**的前端：令牌完整、三人格边界干净、状态与无障碍细节的密度高于大多数同规模项目；主要欠账是深色模式、机考面文案一致性，以及样式文件在插件样式接入后的组织重组。
