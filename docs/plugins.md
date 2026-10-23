# 插件 SDK 与生命周期

## 目录与发现

应用启动时读取项目根目录 plugins/ 下的一层子目录。子目录名必须与 manifest.json 的 id 相同。读取声明后，宿主检查 SDK 版本、入口文件、插件 ID 重复、服务入口和注册活动；任一插件失败会写入开发日志，其它插件继续加载。学习者界面只显示练习是否可用，不展示插件名称、版本或诊断详情。新增或更新插件后重启本机服务。关闭服务时，宿主按加载顺序反向调用插件可选的 deactivate()。

## manifest.json

必需字段：

    {
      "id": "reading",
      "name": "学术阅读",
      "version": "1.0.0",
      "sdkVersion": 1,
      "section": "reading",
      "serverEntry": "./index.mjs",
      "browserEntry": "./browser.mjs",
      "capabilities": ["activity", "grader"]
    }

version 使用完整的 major.minor.patch 版本号。入口必须是插件目录内的 .mjs 文件。SDK 支持 listening、reading 和 vocabulary 区块；当前 demo 只加载 listening 与 reading。插件可以额外声明 dependencies；依赖必须指向同一目录中已加载插件的精确版本。宿主按依赖顺序加载；缺失、版本不匹配或循环依赖会给出插件级错误。

## 服务端入口

serverEntry 导出 activate(host)。宿主为每个插件建立临时注册区；激活或校验失败时丢弃这组注册项。
服务模块可以导出可选 start() 与 deactivate()；start() 在注册校验后运行，deactivate() 在服务关闭时释放资源。

- registerActivity(activity)：注册该插件的练习材料。
- registerGrader(grader)：注册程序判分器；每个插件一个。
- registerHintStrategy(strategy)：为练习页的用户请求提示提供内容。
- registerSkillTags(labels)：注册可展示的能力标签。
- registerCoachTool(name, description, handler)：提供面向导师的安全、只读工具。

判分器返回每题的正确性、是否独立完成、标准答案、证据、解释、能力标签和材料 ID。答案与证据只存在服务端，不能写进浏览器入口。

## 浏览器入口

browserEntry 是预编译 ESM，由插件 API 按需加载。它导出 mountPractice(root, state)，并返回清理函数。state 包含已去掉答案字段的 activity、draft、提交后的 result，以及 onAnswer、onSubmit、onHint、onCurrentQuestion 回调。`activity.examParts` 关联分段、原材料和题目；模考 `draft.examTiming` 与 `deadlineAt` 指定固定播放时间线和截止时间。共享 `exam-ui.mjs` 管理分段导航、标注与交卷确认，`mock-audio.mjs` 管理单次播放。卸载时移除事件、停止并释放音频；同一插件可以按练习页面多次挂载。

宿主每次请求浏览器入口都实时读盘并带 `no-cache` 响应头，因此改完 browserEntry 刷新浏览器即生效。serverEntry 与 manifest.json 只在服务启动时加载一次，修改它们必须重启本机服务。

宿主 SDK 只提供练习上下文和学习结果操作。插件数据以 pluginId 和活动 ID 命名空间存储。不要把云模型密钥放入 manifest 或浏览器代码。

## 当前接入的插件

首版只加载阅读与听力插件。插件 SDK 保留新增 section 和活动能力的扩展接口；词汇学习及复习暂不属于当前 demo 范围。
