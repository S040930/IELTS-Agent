# 题库内容包

## 包结构

`ielts-content-v1.tar` 是只读题库和音频包，解压到项目 `.data/` 后包含：

```text
.data/
├── content/
│   └── activities.json
└── media/
    ├── <uuid>.mp3
    └── ...
```

清单格式为 `{ "version": 1, "activities": [...] }`。每项包含练习材料、题目、答案、解释、能力标签及 `/media/<文件名>` 音频引用。压缩包只收入清单引用的音频，不包含目标分数、考试日期、草稿、作答记录、计划、错题复习数据或导师对话。

`part` 是可选分段字段，标注这份练习对应真实考试结构的哪一段：听力为 `1`-`4`（Part 1-4），阅读为 `1`-`3`（Passage 1-3）。缺省表示尚未标注。列表页按它分组筛选，练习页用它明示当前分段；它不参与判分、能力证据、复习间隔或计划时长计算。

## 组员安装

项目组成员从私有 GitHub Release 下载 `ielts-content-v1.tar`。在项目根目录解压：

```sh
mkdir -p .data
tar -xf ~/Downloads/ielts-content-v1.tar -C .data
```

Windows 可用 7-Zip 解压，确保最终路径是 `.data/content/activities.json` 和 `.data/media/`。解压不会覆盖 `.data/learning.sqlite`；不要分享或提交该数据库。启动应用后，服务端从清单加载题目，并从本机 media 目录流式提供音频。

## 回填阅读选项正文

reading 的 matching-features、classification、matching-sentence-endings 三类题，选项要显示列表正文（"A. Anthony Pellegrini"）。导入环节曾只写入重复字母（`"A. A"`），练习页于是只能渲染出 A、B、C、D。`reading.matching-information`（段落题）不在此列——它的选项本来就只是段落字母。

正文来源是官方题库网页 `PASSAGE-by-ZYZ-IELTS-Reading-*.html`。网页把题目打包在 `<script id="zyz-integrity-payload" type="application/octet-stream">` 里（base64），任务组选项形如 `{"optionId":"…","label":"A","text":"…"}`：

```sh
npm run content:fix-option-labels -- --source=~/Downloads/PASSAGE-by-ZYZ-IELTS-Reading-*.html                       # 预览
npm run content:fix-option-labels -- --source=... --apply --backup=.data/backups/learning-before-option-labels.sqlite
npm run content:export                                                                                             # 重新产出内容包
```

脚本默认只预览，报告回填题数与仍未找到正文的选项；`--apply` 才写库，备份与写库约定同上一节。`assertActivity` 现在会拒绝缺少列表正文的这三类选项，所以同类缺陷会在导出阶段直接报错，不会再静默变成"只有字母"。

## 标注分段
一份活动对应真实考试结构的一个分段：听力每份恰好 10 题（Part 1-4），阅读每份 13 或 14 题（Passage 1-3）。分段由脚本从题库自身推导后写回源数据库：

```sh
npm run content:tag-parts                                          # 预览，只报告不改数据
npm run content:tag-parts -- --apply --backup=.data/backups/learning-before-parts.sqlite
npm run content:export                                            # 重新产出内容包
```

默认预览会打印分段分布、需要写入的份数、来源冲突清单和无法判定的活动；核对无误后再加 `--apply`。`--backup=` 会先做一致性快照（用 SQLite `VACUUM INTO`，因为库开着 WAL，直接拷贝主文件会漏数据），备份路径不得放在 `.data/content/` 或 `.data/media/`——这两个目录会被 `content:export` 收进归档。写入只更新 `imported_activities.activity_json` 一个字段，`imported_at` 保持不变，因此导出顺序不会变化。

推导规则：听力优先取 `description` 里的 `Part N`，其次按题号区间（`floor((最小题号-1)/10)+1`），最后才看标题；阅读没有任何文本标记，只能按题号区间完整包含判定（1-13 / 14-26 / 27-40），不能只看最小题号，否则跨段活动会被误归 Passage 1。来源互相冲突时以 `description` 和题号区间为准并在报告中列出；无法判定的活动保持原样，不写入 `part`，也不删除。

写回后必须重跑 `content:export`——本机服务只读 `.data/content/activities.json`，不查询数据库。随后重启本机服务才能读到新字段。

回滚：从备份恢复 `.data/learning.sqlite`，同时删掉残留的 `-wal` 与 `-shm` 文件（WAL 残留会与主库不一致），再重跑 `content:export`。`.data/` 不在版本控制内，备份是唯一回滚手段。

## 更新内容包

拥有源题库数据库的维护者在项目根目录运行：

```sh
npm run content:export
```

命令只读 `.data/learning.sqlite` 的 `imported_activities` 表，校验题目结构及音频引用，并在 `.data/` 生成 `ielts-content-v1.tar`。归档文件只含 `content/activities.json` 和清单引用的 `media/` 文件；个人学习表不会被查询或归档。上传新归档时替换私有 GitHub Release 中的同名附件。本机内容包保留完整题库，当前约需 1.1 GB 磁盘空间；本机 SSD 预计约一分钟内完成，时间随磁盘吞吐变化。清单常驻内存，音频由 tar 逐文件读取，峰值内存预期低于 512 MB。

本机网页和内容包保留全部听力练习。云端上传脚本单独筛选，只导入标注为“高频”或“次高频”的听力活动；非高频及未标频听力活动不会上传，内置示例听力题也不会出现在云端，阅读活动全部上传。当前云端筛选后保留 98 个听力音频、约 822 MB；共排除 33 个非高频练习。源 SQLite、完整内容清单和原始音频均不删除。

## 内容缺失

若题库包尚未解压，学习者仍可使用内置示例活动；完整题库活动暂不会显示。若内容清单或活动格式损坏，服务端在开发日志中记录具体原因，并继续提供内置活动。引用音频缺失时，导出命令会停止并指出文件名。
