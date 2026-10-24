# Handoff: opencode-antigravity-bridge

## 项目目标

为 [magpie](https://github.com/yetone/magpie) 提供 npm provider 插件，把
Anthropic Messages 桥接到真实的 `agy` CLI，而不是复用订阅凭据并伪造
Antigravity IDE 的 HTTP 身份。真实 CLI 可以避免客户端身份伪造，但不能承诺
账号永远不会受到平台限制。

仓库：https://github.com/DylanLIiii/opencode-antigravity-bridge

当前状态：**原生 MCP 工具透传已实现**。基线 commit 为 `292fb05`；本文描述
其后的工作区修改，不表示这些修改已经提交或发布。

## 对原 Handoff 的复核结论

### 1. “同步 MCP 不可行”是错误判断

原文混淆了两个请求：

- 客户端的 `/v1/messages` 请求先收到完整 `tool_use` 响应并结束；
- MCP helper 的独立回调保持 pending，等客户端下一请求带来 `tool_result`。

magpie 内置 Claude 桥就是这样实现的，并没有挂起首个客户端响应。npm 插件
host 也允许模块级跨请求状态、并发 fetch、子进程及流式 Response。因此不需要
Go gateway 的私有端点，插件自己就能关联两个 HTTP 请求和 MCP 调用。

证据：`yetone/magpie@8434179` 的
[`claude_subscription.go`](https://github.com/yetone/magpie/blob/843417957c363886644174cd880cab0c7af09ae6/internal/gateway/claude_subscription.go)
文件头、`match`、`continueWith`、`mcpCall`，以及
[`host.js`](https://github.com/yetone/magpie/blob/843417957c363886644174cd880cab0c7af09ae6/internal/plugin/host.js)
的 loader 缓存和 fetch 实现。

### 2. 原方案 B 的“立即返回占位成功”已否决

回复 MCP `tools/call` 后，agy 就可以把占位内容当真实结果继续生成并结束回合。
下一轮再发送 `[tool result]` 普通文本，不能恢复原生的调用/结果关系，还会让
模型看见两种互相矛盾的结果。

当前实现不回复占位内容：MCP 调用一直等待真正的客户端结果。对 agy 是同步
工具调用，对客户端则是多个正常 Anthropic Messages HTTP 响应。

### 3. 每进程配置不依赖 `AGY_MCP_CONFIG`

本机 `agy 1.3.3` 的 `--help` 和二进制中都没有该环境变量或独立 config flag。
原 Handoff 的全局 `mcp_config.json` 路径也不是当前 CLI 的唯一真实布局；直接
改写全局配置会污染用户环境。

真实探针确认可用的是自定义 agent：

- 在临时工作区写 `.agents/agents/magpie-bridge/agent.md`；
- frontmatter 使用 `tools: []` 和内联 `mcpServers` **数组**；
- 每个 server 可有自己的 command、args、env 和 timeout；
- 通过 `--agent magpie-bridge` 启动，并通过 `--add-dir` 加入真实项目目录。

因此每个 agy 进程都有独立令牌和 MCP 配置，不修改用户全局 MCP/settings。

参考：[Custom subagents](https://antigravity.google/docs/subagents/)、
[Plugins](https://antigravity.google/docs/plugins/)。

### 4. MCP 握手不能假设只有 `initialize`

真实 agy 1.3.3 首先发送 `server/discover`，协议版本是 `2026-07-28`，随后才
发送 `tools/list` / `tools/call`。`mcp-server.mjs` 同时支持 modern discover
和 legacy initialize。

参考：[MCP discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)、
[版本兼容](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)。

### 5. “schema 验证由 MCP 层保证”表述过度

MCP 能传递 `inputSchema`，但传输 schema 不等于自动完成所有 JSON Schema
校验。当前桥检查声明过的工具名和参数形状，并把 schema 原样交给 agy；真正
执行工具的客户端仍必须校验参数和授权操作。桥本身尚未实现完整 JSON Schema
2020-12 校验器，不能把它写成已有保证。

### 6. 原“已完成”列表也有两处失实

- 原图像测试接受的是 Response 已返回后的流错误，并不是文档声称的 HTTP
  400。现在内容校验提前，测试明确检查状态码 400。
- `agy models` 的真实输出可用单个 Tab 分隔，原正则要求至少两个空白字符，
  因而会错误退回硬编码列表。解析器已修复，并有动态模型测试。

### 7. 内置工具权限是安全边界，不是备选体验

原实现使用 `--dangerously-skip-permissions`，却没有排除 agy 的 shell、写文件
等内置工具。当前自定义 agent 使用 `tools: []`，仅配置客户端 MCP server；
任何意外出现的非 bridge 工具步骤都会使回合失败并淘汰进程。不能仅凭提示词
约定就声称 agy 不会执行本地工具。

### 8. 模型协议必须写在 `api.npm`

原 Handoff 说模型的顶层 `npm: "@ai-sdk/anthropic"` 会启用 Anthropic Messages。
真实 Magpie 0.1.1356 的 `internal/plugin/host.js` 却从 `m.api?.npm` 读取协议，
顶层字段不会进入 `plugin.Model.NPM`，模型因此被错误地按 Chat 路由，工具也变成
Chat 风格。现在 provider 和模型都补全 OpenCode 的 `api: {id, url, npm}`，并用真实
网关确认路由恢复为 Anthropic。参考该发布版的
[`host.js`](https://github.com/yetone/magpie/blob/v0.1.1356/internal/plugin/host.js)
和 [`plugins.go`](https://github.com/yetone/magpie/blob/v0.1.1356/internal/provider/plugins.go)。

## 当前架构

### 原生工具闭环

1. `Proc.start()` 创建临时工作区和受限 agent，以每进程随机令牌配置
   `mcp-server.mjs`。
2. helper 通过 stdio 与 agy 说 MCP；通过仅监听 `127.0.0.1` 的 TCP 控制通道
   向插件请求工具列表或提交工具调用。令牌只放在该进程的 MCP env 中。
3. agy 的 ACTIVE tool step 与 MCP 调用按 `progressToken` 的 step index
   关联；无该字段时按工具名和参数做无歧义匹配。
4. 插件把调用转成 Anthropic `tool_use`，结束当前 SSE 响应，但保留 agy
   turn、MCP pending 调用和事件队列。
5. 下一请求按 `tool_use_id` 找到同一 turn。真实 `tool_result` 通过控制通道
   返回给 helper，再作为 MCP result 返回 agy。
6. 新 SSE 响应继续消费同一 agy turn；后续工具调用可再次暂停，最终结果
   以 `end_turn` 结束。

`Turn` 持有事件队列和调用表，HTTP Response 只是它的临时订阅者。普通结束
`tool_use` 响应不会取消 agy turn；客户端真正取消、进程崩溃或超时才清理。
等待模型输出和等待客户端工具结果使用不同超时。

### 进程及配置生命周期

- 同一对话、模型、工具定义及工作目录不变时复用进程。
- 复用前比较规范化完整历史：对象 key 无序、数组顺序保留。相同开场但实际回复
  不同的会话必须重建并重放，不能直接复用另一个会话的 agy 上下文。
- acquire 按对话串行化，启动中的进程也计入 `MAX_PROCS`，避免池覆盖和超容量。
- 工具定义变化时重建进程并重放渲染历史，避免 MCP 工具注册不一致。
- 等待工具结果或尚有未消费事件的 turn 不参与 LRU/idle 淘汰。
- 进程停止时回复未完成的控制请求、结束子进程并删除临时工作区。
- 不支持的输入在返回 Response 前校验，避免把 400 错写成 200 + 流错误。

## 关键文件

- `index.mjs`：插件入口、进程池、turn 状态、控制通道、Anthropic SSE、
  Anthropic 内容转换及模型发现。
- `mcp-server.mjs`：无外部依赖的 stdio JSON-RPC helper，支持 modern/legacy
  MCP、并发 pending 调用、取消和断线处理。
- `test-smoke.mjs`：fake agy + 真实 MCP helper 的端到端烟雾测试。
- `package.json`：发布文件包含 `index.mjs`、`mcp-server.mjs` 和 README。

## 已执行验证

基线的 `node --check index.mjs` 和原 15 项检查曾全部通过。

当前实现：

- `node --check index.mjs`、`node --check mcp-server.mjs`、
  `node --check test-smoke.mjs` 通过；
- `node test-smoke.mjs`：**52 项全部通过**，覆盖原生工具闭环、并行/连续
  调用、真实结果、原子化批量结果校验、相同开场会话隔离、同时启动、UTF-8
  分块、工具错误、崩溃、超时、取消、临时目录清理、动态模型、`api.npm`
  协议声明和真实 HTTP 400；
- 真实 `agy 1.3.3` 协议探针确认了工作区自定义 agent、modern MCP 握手及
  pending `tools/call` 会阻塞原回合；
- 通过插件 `loader.fetch` 对真实 agy 验证了无工具纯文本（`BRIDGE_PLAIN_OK`）
  和合成 echo 闭环：第一响应 `tool_use`，第二响应 `end_turn`，真实客户端结果
  `REAL_E2E_OK` 出现在最终文本中；
- 安装官方 **Magpie CLI 0.1.1356**（校验发布 SHA-256），用隔离 XDG 配置和
  HOME 加载本地插件。`magpie plugin add` 与 keyless `plugin login` 均通过，
  真实 Bun host 列出 13 个模型；直接请求网关 `/v1/messages`，纯文本返回
  `MAGPIE_HOST_PLAIN_OK`，原生 echo 完成 `tool_use → tool_result → end_turn`
  并返回 `MAGPIE_HOST_TOOL_OK`。这次宿主验证还暴露了顶层 `npm` 被忽略的问题，
  修正为 `api.npm` 后才通过。

未发布 npm、未修改全局 agy MCP 配置。当前只验证了 CLI 登录和直接 HTTP
请求，没有宣称 GUI、所有客户端或 host 重启场景已经覆盖。

## 后续工作

1. 在 Amp / Claude Code 等真实客户端中验证连续工具调用、请求取消、host 重启
   和客户端改写 tool_use id 的兼容性。
2. 如需严格满足 MCP 服务端输入校验要求，引入经过评估的 JSON Schema
   2020-12 校验方案；不要声称手写 shape check 等同于完整校验。
3. 支持 live `tool_result` 旁的用户文本，且不能把它误当作工具输出。
4. 根据真实 CLI 版本兼容性决定是否声明最低 agy 版本。
5. 完成客户端兼容性验证后再考虑 npm 发布和社区插件 PR。

## 开发命令

```sh
git clone https://github.com/DylanLIiii/opencode-antigravity-bridge
cd opencode-antigravity-bridge
node --check index.mjs
node --check mcp-server.mjs
node test-smoke.mjs
npm pack --dry-run

# 真实宿主验证（需要 magpie + 已登录 agy）
magpie plugin add ./opencode-antigravity-bridge
```

---

**复核及文档版本**：2026-10-24
