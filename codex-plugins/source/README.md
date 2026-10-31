# codex design

Codex 桌面版的本地设计插件。包含 baoyu-design 的五个现役技能、四种本地编辑器，以及 Codex 运行入口。显示名为 **codex design**，插件标识为 `codex-design`。

| 技能 | 产物 |
|---|---|
| `codex-slides` | 可编辑幻灯片；导出 PDF、HTML、PowerPoint |
| `codex-design` | 多画板设计画布与交互原型；导出 HTML、PDF、PNG |
| `codex-design-system` | tokens、品牌手册、组件、字体及素材 |
| `codex-dashboard` | CSV/TSV/JSON 数据驱动的看板和 Sources 数据溯源 |
| `codex-dataviz` | 图表设计指南及配色校验器 |

五个技能统一使用 `codex-` 前缀，保持与已有产物文件格式兼容。插件不需要 DeepSeek Harness，也不需要 DeepSeek 或 Anthropic API key。所有编辑器都在本机 `127.0.0.1` 运行，产物保存在你选择的工作项目中。

## 环境

- 支持本地插件的 Codex 桌面版。
- PATH 中可用的 **Node.js 22 或更新版本**。编辑器已预构建，无需 `npm install`。
- 评论设计 worker 使用 Codex 平台的原生子代理工具，由当前聊天选择、复用或恢复。原生批注使用支持相应能力的 Codex 内置浏览器。

`requires_local_executor` 已启用；这是需要本地执行器的桌面插件。它不提供远程 MCP 服务，不包含空 MCP 配置。

## 安装

从 GitHub 安装前，目标分支必须已经包含生成的 `codex-plugins/codex-design/` 目录。添加本仓库的 Codex 插件分支，再安装插件：

```powershell
codex plugin marketplace add doomclouds/baoyu-design --ref codex/plugin
codex plugin add codex-design@codex-design-marketplace
```

然后重启桌面应用，在插件目录核对 **codex design** 已安装并启用，再新建聊天。命令安装成功与当前聊天实际加载是两个检查步骤。

marketplace 位于 `.agents/plugins/marketplace.json`；`source.path` 是相对于仓库根目录的 `./codex-plugins/codex-design`，不是相对于 `.agents/plugins/` 的路径。

## 使用

在工作项目里让 Codex 使用插件，例如：

- “用 codex design，把这些笔记做成可编辑的 10 页幻灯片。”
- “用 codex design，在一个画布上做落地页和手机版两个画板。”
- “用 codex design，为这个组件库整理一套设计系统。”
- “用 codex design，把这个 CSV 做成带来源溯源的仪表盘。”

Codex 会按技能创建本地文件并给出编辑器链接。用户在编辑器中的修改与 Codex 修改同一份文件。技能的实际 CLI 入口是 `skills/<skill>/scripts/codex-artifact.mjs`；上游 `artifact.mjs` 保留为运行时实现。

```powershell
node "<installed-plugin>/skills/codex-slides/scripts/codex-artifact.mjs" open "<project>/designs/q3-review"
node "<installed-plugin>/skills/codex-slides/scripts/codex-artifact.mjs" check "<project>/designs/q3-review"
node "<installed-plugin>/skills/codex-slides/scripts/codex-artifact.mjs" stop "<project>/designs/q3-review"
```

## 原生批注和设计 worker

两种入口分别处理：

- **浏览器原生批注**：使用 Codex 内置浏览器顶栏的 **批注** 入口，选择页面对象并在原生输入区提交。插件只补充对象、文件位置等定位数据，不增加自建浮窗、对象选择器或批注按钮。原生批注由用户提交给当前聊天，随后由当前聊天处理。
- **编辑器 Comments / Send to agent**：保留编辑器原有位置的评论入口，评论仍保存在项目的 `comments.json`。普通保存不会投递；明确选择 **Send to agent** 后，只在本地持久记录任务，等待注册的原生设计子代理领取。该动作不调用外部队列、不唤醒或创建原生子代理，也不启动后台模型进程或 HTTP 模型 daemon。

默认 delivery 为 `native`；`worker` 是同义别名。`--delivery main` 仅保留显式选择的旧版当前聊天队列兼容模式，绝不作为失败回退。平台真实创建的子代理会出现在原生子代理 UI 中，不通过伪造 `threadSource` 或自建浮窗模拟。

主聊天使用实际可用的原生子代理工具决定复用、恢复已有子代理，或在必要时创建一个；不是每条评论创建一个。CLI 不替代这些平台工具。原生工具暂时不可用或已卸载时，任务保留在本地，由主聊天安排恢复；不会悄悄改用后台临时模型会话或主聊天队列。

每个项目由注册的 worker 串行处理，不同项目可以并行。主聊天或其他独立 Agent 写同一项目之前先检查状态；有 active 任务时保持单一写入者。pending 且无人监听时，主聊天应检查原生子代理并决定恢复，而不是无限等待：

```powershell
node "<installed-plugin>/skills/codex-slides/scripts/codex-artifact.mjs" worker-status "<project>/designs/q3-review"
```

状态包含 `pending`、`active`、`completed`、`failed`、`superseded`，以及注册的 `nativeThreadId`。`listening` / `running` 只代表本地 `worker-next` 正在等待，不能证明平台子代理仍然可用；`needsResume` 提醒主聊天检查。已接收不等于修改完成，以任务状态、真实文件与原评论回复为准。

主聊天选定真实子代理后，以下命令由**那个子代理**执行，保留其自身实际 `CODEX_THREAD_ID` 环境，不复制父聊天 ID，也不手工编造 ID：

```powershell
node "<installed-plugin>/skills/codex-slides/scripts/codex-artifact.mjs" worker-register "<project>/designs/q3-review" --name "q3-design-worker"
node "<installed-plugin>/skills/codex-slides/scripts/codex-artifact.mjs" worker-next "<project>/designs/q3-review" --timeout 60
```

注册后持续监听，不以 “Ready” 结束回合。对正在等待的同一个命令继续取结果，不重复启动监听。返回 `timedOut: true` 就再次执行 `worker-next`；返回 `closed: true` 才结束监听回合。领取结果包含 `job.id`、`request`、`event`；子代理读取安装技能和最新产物，只修改该产物并运行内置 `check`，无需等待自己的 active 状态。

处理后运行 `worker-complete <root> <jobId> -`，通过标准输入传入简短回复，再回到 `worker-next`。成功用纯文本；失败用 `{"text":"未完成的原因","status":"failed","error":{"code":"...","message":"..."}}`。控制器会带用户评论版本前提自动回复原评论，避免旧版本结果覆盖新请求；worker 不再直接调用 `comment-reply` 或 `comment-resolve`。失败保留错误与诚实回复，不能报告成完成。

同一子代理 ID 再次注册会复用。更换 ID 必须由主聊天先用原生 interrupt 工具中断旧 worker，再执行 `worker-stop <root>`，最后由新子代理显式 `worker-register <root> --name <task> --replace`。CLI 只能暂停本地监听，不能中断仍在编辑的原生子代理；主聊天与其他 Agent 不得与它并发写同一项目。

需要手工读取评论时使用 `comments`；未领取 worker 任务时按需使用 `comment-reply`、`comment-resolve`。不要另起 `comments --wait`。显式 `--no-agent` 仅打开本地编辑器并保存评论，不会恢复或替换子代理。

`codex-dataviz` 提供图表规范和配色校验器，不运行编辑器、批注面板或设计 worker。

## 构建与更新

本目录是生成包。维护源在仓库根的 `skills/` 和 `codex-plugins/source/`；不要手工修改生成文件。

```powershell
node codex-plugins/build.mjs
node codex-plugins/build.mjs --check
npm run test:codex-plugin
```

构建顺序：复制五个根技能 → 复制插件 source → 复制根 NOTICE → 适配 Codex 技能 → 适配原生批注。根 `skills/` 是唯一技能上游，DeepSeek Harness 包不参与构建。构建与测试在本机执行；GitHub 用于源码和插件分发，生成包随仓库提交，以便直接安装。

`.generated-manifest.json` 记录生成文件的 SHA256。再次构建时，已有输出含未知文件或被手工修改会报错，避免覆盖用户内容。先把这些改动保存到 source 或移到其他目录，再重新构建。`--check` 只检查生成结果是否与源一致，不替换已生成包。

更新来源目录后重新构建，再通过桌面应用刷新或重新安装插件并开启新聊天。Codex 从安装缓存加载插件，修改仓库源文件不代表当前聊天已经加载了更新。

## 能力边界与许可

本插件提供本地文件和编辑器工作流；源项目自动同步、云连接器、实时远程查询、定时例程或远程发布需由相应外部服务提供。通过 `CODEX_DESIGN_SYSTEMS` 设置额外的本地设计系统搜索路径，多个路径使用系统路径分隔符。

四种编辑器运行内置 `check` 后，可使用现有浏览器或文档预览检查布局、交互和导出。`codex-dataviz` 运行配色校验器并检查实际图表渲染。结构检查不能代替视觉检查；交付时应说明真实执行过的验证。

来源说明见随包提供的 `NOTICE.md` 及编辑器第三方许可文件。插件包不另附顶层 `LICENSE`；上游条款链接保留在 NOTICE 中。独立社区项目，与 OpenAI、Anthropic 或 DeepSeek 无隶属或背书关系。
