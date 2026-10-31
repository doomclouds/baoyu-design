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
- 编辑器评论发送到聊天的桥接需要支持 `codex queue --thread ... --message ...` 的 Codex CLI。原生批注还需要支持相应文档能力的宿主。

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

## 原生批注和编辑器评论

两种批注流程分别使用各自的提交方式。

- **宿主原生批注**：在支持文档批注的宿主内打开编辑器，点选要修改的项目对象，再选择 **向 Codex 批注**，在宿主中标注并提交。按钮请求进入批注模式；提交动作由用户在宿主完成。Codex 按收到的批注位置和文本修改产物。宿主是否接受该能力需要在实际客户端验证；普通浏览器不显示这组原生批注控件。
- **编辑器自带评论**：保存在产物的 `comments.json` 中。Codex 入口可绑定当前聊天；桥接成功时，**Send to agent** 将评论通过 `codex queue` 送到绑定聊天。出现 `NO_CODEX_THREAD` 或找不到 Codex CLI 时，可明确给 `open` 加上 `--no-agent`，打开不投递到聊天的编辑器，仍可保存评论，并让 Codex 主动读取和回复。不能仅凭按钮显示认定原生批注或聊天唤醒已通过验证。

手工处理编辑器评论可运行 `comments`、`comment-reply`、`comment-resolve`。已有桥接时不要再启动重复的 `comments --wait` 进程。编辑器评论卡片不是 Codex 原生文档批注。

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

运行内置 `check` 后，可使用现有浏览器或文档预览检查布局、交互和导出。结构检查不能代替视觉检查；交付时应说明真实执行过的验证。

来源说明见随包提供的 `NOTICE.md` 及编辑器第三方许可文件。插件包不另附顶层 `LICENSE`；上游条款链接保留在 NOTICE 中。独立社区项目，与 OpenAI、Anthropic 或 DeepSeek 无隶属或背书关系。
