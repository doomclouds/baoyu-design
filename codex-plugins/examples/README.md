# codex design 展示项目

四个例子参考仓库 README 的展示形式，使用真实、可编辑的产物格式。编辑器和评论入口沿用仓库原有布局。

| 项目 | 内容 | 技能 |
|---|---|---|
| [Slides](slides/project/deck.json) | 暖纸、墨黑与陶橙的五页演示；第 4 页是大字 statement | `codex-slides` |
| [Bean Club](design/project/canvas.json) | 桌面落地页与 390×844 手机注册原型；含选项、校验和确认状态 | `codex-design` |
| [Nimbus](design-system/project/design-system.json) | 双主题天气品牌、完整 tokens、品牌手册和三个交互组件 | `codex-design-system` |
| [X 数据看板](dashboard/README.md) | 明确标注的合成日数据、五个 KPI、年度趋势、筛选和逐行来源 | `codex-dashboard` |

安装插件后，可以让 Codex 打开其中一个项目，例如：“用 codex design 打开 `codex-plugins/examples/design`，保留现有内容。”

主代理检查项目已有的原生设计子代理，决定复用、恢复或创建。编辑器里的 **Comments / Send to agent** 把请求留在项目本地队列，由那个子代理领取并回写回复。浏览器顶栏的原生批注由当前聊天处理。

项目中的服务器、评论及子代理运行状态已加入本目录的忽略规则，不随展示内容发布。查看前请运行相应技能的 `check`；结构检查不能替代真实浏览器中的视觉和交互检查。
