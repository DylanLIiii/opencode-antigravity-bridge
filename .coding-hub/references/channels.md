# OpenCode 执行通道

本文件只保留项目使用的通道。所有模型映射见 [项目 Coding Hub](../SKILL.md)，
不能把模板的 Provider 前缀或另一台机器的实例 ID 直接套到当前环境。

## T3 Code

1. 先遵循当前宿主提供的委派工具选择规则。首次 `delegate_task` 前检查 `orchestrator_capabilities`，
   确认 `opencode` 实例、所需 `magpie/group/*` 路由、子任务能力和权限模式。
2. 不带额外设置且同 Provider / 已提供模型的任务可以用宿主原生子 Agent；
   后台、跨 Provider 模型、用户指定设置和独立 checkout 使用 `delegate_task`。
   先发现工具 schema，不把这里的字段说明当作可直接调用的固定签名。
3. `target.providerInstanceId` 选择已核对的 OpenCode 实例，`target.model` 选完整路由 ID。
   用户明确指定的模型选项放在 `target.options`，路由组默认不另设 effort。
4. 写任务选择 `isolation: "worktree"`，在父权限允许时显式传 `runtimeMode: "full-access"`。
   工具负责创建 checkout。核对返回的路径与分支，再让子任务执行；未提交改动不会自动带入。
5. 子任务只接收任务正文，因此给出必要背景、允许路径、完成标准与返回要求。
   严禁在子任务内递归委派。审查和重新审查各用新的 `delegate_task`；小审查问题由父会话直接修复。
6. 遵循返回的 `next`，等待完成通知，不轮询 `task_status`。停止委派运行使用 `task_cancel`，
   不把子线程 ID 交给 `t3_thread_interrupt`。
7. `t3_thread_launch` / `create_threads` 只用于用户明确要求的新顶层线程。
   “并行”“子代理”“委派”本身不构成创建顶层线程的要求。
8. 引用线程时使用工具返回的完整 `link`，不得自行拼接。讨论已有线程前先读取其内容。
   跨机器先发现已链接环境并传 `environmentId`，不臆造机器 ID 或路径映射。
9. 创建、接管或推送 PR 后，下一工具调用用 `link_pull_request(s)` 关联完整 URL。
   需要监视时按宿主规则调用 watch；交回前的 unwatch 同样按宿主规则执行。
   不通过轮询或 `gh --watch` 等待 PR。子任务不 watch。

当前宿主的 MCP 工具可用；本机没有 `t3` CLI。使用 MCP 即可，不为派工安装 CLI 或新服务。
如果工具调用失败，说明具体错误；不能用 shell 改起另一套任务来绕过限制。

## herdr-core

适用于 T3 之外的交互终端任务，或用户明确选择的执行通道。先把已安装 CLI 所在目录加入 PATH，
再读 `hc --skill` 和相关命令的 `--help`，核对当前语义。不要重启共享 core。

只读检查：

```bash
hc --skill
hc server status
hc templates
hc ls
opencode models
opencode mini --help
```

本机 OpenCode v2 的 `models` 不接受 Provider 位置参数，交互入口是 `mini`。
任务启动示例（仅在用户任务需要实际委派时执行）：

```bash
hc run --bg --name <task> --cwd <assigned-worktree> opencode mini --model magpie/group/craft
hc wait <terminal> --timeout 30
hc read <terminal> --lines 100
hc send <terminal> "<完整任务简报>"
```

- 使用交互模式及 `--bg`；不使用一次性 `opencode run` 派工。
- `<assigned-worktree>` 必须已经分配给唯一写手；T3 中的子任务 checkout 仍由 T3 工具创建。
- 若用模板附带首条任务，核对模板的 Agent / 模型及 `first_message.sent`。
  发送失败或返回 false 时先读屏，确认送达状态后再决定，不盲目重复发送。
- 等待用 `hc wait`，timeout 单位为秒。超时只是检查点，不重复启动任务。
- 当前会话在 core 内时可用真实 `$HC_TERMINAL_ID` 作为返回地址；否则保留终端地址并读取产物，不虚构地址。
- 远程使用 `hc machine ls` 已配置目标，在目标上读取说明、核对模型与 checkout；后续使用完整终端地址。
  没有已知目标时不要把本机路径当成远程路径。
- 验收真实 diff 和测试后，仅清理自己创建且已不需要的终端。审批阻塞不使用 `send --force` 绕过。

## 配置时的验证范围

- T3 `opencode` 实例启用，允许 child task，提供 full-access 模式。
- T3 capabilities 与 `opencode models` 均列出 `magpie/group/flow`、`craft`、`sage`、`apex`；未列出 Breeze。
- `hc --skill`、`hc server status` 和 `opencode mini --help` 成功；core 报告版本 0.1.19。
- 没有启动付费 Agent、委派任务、跨机器连接或集成推理；以上仅证明能力发现与只读检查成功。
- 后续环境变化以实时目录为准；不修改全局默认模型，也不自动切换其它 Agent。
