# Handoff: opencode-antigravity-bridge

## 项目目标

为 [magpie](https://github.com/yetone/magpie) 开发一个 npm provider 插件，将 **Antigravity 订阅**(Google Code Assist）桥接到真实的 `agy` CLI 进程，避免 magpie 内置 Antigravity provider 通过伪造 User-Agent 调用 Google API 导致的**封号风险**。

设计灵感来自 magpie 内置的 **Claude 订阅桥**：不直接调 Anthropic API，而是启动真实 `claude` 二进制，让它代表用户与 Anthropic 通信。

## 仓库地址

https://github.com/DylanLIiii/opencode-antigravity-bridge

当前状态：**MVP 可运行，但工具调用方案需要重构**（见下文"关键架构决策")。

## 当前实现概览

### 已完成

- ✅ 进程池管理：每个对话一个 `agy --input-format stream-json --output-format stream-json` 进程
- ✅ 进程复用：同一对话的后续请求通过 stdio 复用同一进程
- ✅ 进程淘汰：闲置 10 分钟回收，最多 4 个并发进程，LRU 淘汰
- ✅ 错误处理：agy 中途死亡 → 显式 SSE error 帧，不静默截断
- ✅ Token 统计：agy 的 `result.usage` 是会话累计值，已正确转为单回合 delta
- ✅ 模型列表：从 `agy models` 动态读取，失败时 fallback 到硬编码列表
- ✅ 无 key 登录：`keyless: true` 机制，用户点 Sign in 即可，authorize 返回 `{type:"success", key:"agy"}`
- ✅ 图像拒绝：agy stream-json 不支持图像，带图请求返回 400

### 当前工具调用方案（**需要重构**)

当前用的是**文本约定**方案：
1. 把客户端工具列表渲染到 prompt 里，告诉 agy "你可以用 `TOOL_CALL <name> <json>` 格式调工具"
2. agy 输出匹配行时，解析成 Anthropic `tool_use` block 发给客户端
3. 客户端执行后，下一轮带 `tool_result` 回来，渲染成 `[tool result]...` 文本喂给 agy

**问题**：依赖模型遵循文本约定，不如原生 MCP 可靠。

### 关键架构决策：如何透传客户端工具

#### 方案对比

| 方案 | 可行性 | 体验 | 实现难度 |
|---|---|---|---|
| **A. 同步 MCP 透传**（对齐 Claude 桥） | ❌ 不可行 | 最佳 | — |
| **B. 异步 MCP 透传** | ✅ 可行 | 良好 | 高 |
| **C. 文本约定**（当前） | ✅ 已实现 | 一般 | 低 |
| **D. 不透传客户端工具**（只用 agy 内置工具） | ✅ 可行 | 受限 | 低 |

#### 方案 A 为什么不可行

Claude 桥的工作机制：
1. Magpie 启动 `claude` 进程 + `magpie claude-mcp-helper`(stdio MCP server)
2. `claude` 通过 MCP 调工具 → helper 收到
3. helper POST 到 `/_magpie/claude-mcp/<token>`(Go gateway 内部端点）
4. Go handler **阻塞等待**客户端的工具结果（通过 channel)
5. 客户端下一轮请求带来结果 → handler 返回 → helper 把结果喂回 claude

**关键**:Go handler 能"挂起"当前 HTTP 请求，等下一个请求的工具结果。这是 Go gateway 的内部能力。

npm 插件的 `fetch(input, init)` 必须在一个请求内返回 `Response`，**无法挂起等下一轮请求**。所以同步 MCP 透传在 npm 插件里做不到。

#### 方案 B：异步 MCP 透传（推荐）

架构：
```
1. 客户端 POST /v1/messages,带 tools: [read_file, write_file, ...]

2. 插件:
   a. 启动一个 stdio MCP server (Node.js),暴露客户端的工具
   b. 写一个临时 mcp_config.json,指向这个 server
   c. 启动 agy 进程,agy 读 mcp_config.json,连接我们的 server
   d. agy 把工具列表作为 function declarations 发给 Gemini

3. Gemini 决定调工具 → agy 通过 MCP 调我们的 server

4. 我们的 server 收到 tools/call:
   - 不阻塞等待
   - 立即返回: {content: [{type: "text", text: "Tool call registered. Result will be provided in the next turn."}], isError: false}
   - 同时把工具调用转成 Anthropic tool_use block,通过 SSE 发给客户端

5. 客户端执行工具 → 下一轮请求带 tool_result

6. 插件收到下一轮请求:
   - 从 tool_result 提取结果
   - 作为新的 user message 发给 agy: "[tool result id=...]\n...\n[end of tool result]"
   - agy 继续对话
```

**优点**:
- 用真实的 MCP 协议（agy 原生支持）
- 不依赖模型遵循文本约定
- 工具调用的 schema 验证由 MCP 层保证

**缺点**:
- agy 的 "thinking" 在工具调用处被打断（它以为工具立即返回了）
- 需要多一次 HTTP 往返（客户端执行工具后）

**实现要点**:
1. **MCP server 实现**：用 `@modelcontextprotocol/sdk` 或手写 stdio JSON-RPC
2. **临时 mcp_config.json**：每个 agy 进程一个，进程结束后删除
3. **工具列表同步**：客户端 tools → MCP server 的 tools/list
4. **调用关联**:MCP tools/call → 当前请求的 SSE stream（需要用 request-scoped state)
5. **结果回传**：下一轮请求的 tool_result → 渲染成文本发给 agy

#### 方案 D：只用 agy 内置工具（备选）

agy 自己有一些内置工具（`run_command`, `read_file`, `write_file` 等），这些 agy 自己就能执行，不需要 MCP 回调。

如果不透传客户端工具，只让 agy 用内置工具：
- 实现简单
- 但客户端的自定义工具（比如 Amp 的特定工具）不可用
- 适合"把 agy 当独立 agent 用"的场景

## 技术栈

- **运行环境**:Magpie 的 Bun host 进程（兼容 Node.js API)
- **插件协议**:OpenCode provider 插件（`auth` + `fetch` hooks)
- **进程管理**:`node:child_process` 的 `spawn`，显式 `stdio: ["pipe", "pipe", "pipe"]`
- **流式响应**:Web `ReadableStream`，输出 Anthropic SSE 格式
- **agy 协议**:`--input-format stream-json --output-format stream-json`(NDJSON over stdio)

## 关键文件

### `index.mjs`(868 行）

单文件插件，包含：
- `findAgy()`：查找 agy 二进制（PATH、常见安装位置）
- `Proc` 类：一个 agy 进程的生命周期管理
- 进程池：`Map<convKey, Proc>`，带 idle 回收和 LRU 淘汰
- `conversationKey(body, model)`：对话标识（system prompt + 第一条 user message 的 hash)
- `renderInitialPrompt(body)` / `renderContinuedTurn(body)`:Anthropic Messages → agy 文本格式
- `makeAnthropicStream(proc, body, msgId)`:agy stream-json → Anthropic SSE
- 插件导出：`auth`(keyless sign-in)+ `provider`(models + fetch)

### `test-smoke.mjs`(220 行）

烟雾测试，用 fake agy 脚本验证：
- 进程启动 + init 握手
- 单回合请求/响应
- 跨回合会话复用
- TOOL_CALL 文本约定 → tool_use block
- agy 中途死亡 → SSE error 帧
- 图像内容拒绝

运行：`node test-smoke.mjs`(15 项检查）

## 已知限制

1. **单 Google 账号**:agy 不支持 `AGY_HOME` 环境变量（见 [google-antigravity/antigravity-cli#155](https://github.com/google-antigravity/antigravity-cli/issues/155))，所有进程共享 `~/.gemini/antigravity-cli` 的登录态。

2. **不支持图像**:agy 的 stream-json 输入只接受文本 block（见 [agy headless 文档](https://antigravity.google/docs/cli/headless))。

3. **工具调用体验**:agy 的 "thinking" 在工具调用处被打断（方案 B 的固有限制）。

## 参考资料

### Magpie 内部机制

- **Claude 订阅桥**:[docs/subsystems/claude-subscription-bridge.md](https://github.com/yetone/magpie/blob/main/docs/subsystems/claude-subscription-bridge.md)
  - 如何启动真实 `claude` 进程
  - 如何通过 MCP 回调同步工具结果
  - 会话保持/恢复机制

- **Provider 插件协议**:[docs/subsystems/provider-plugins.md](https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md)
  - `auth` hook 的 `keyless: true` 机制
  - `fetch` hook 的输入输出格式
  - 模型列表的 `npm` 字段（`@ai-sdk/anthropic` 表示 Anthropic Messages 协议）

- **插件 host**:[internal/plugin/host.js](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)
  - 插件如何启动子进程（`Bun.spawn` 的 guard 机制）
  - `authorize` 的返回格式：`{type:"success", key}` 或 `{type:"failed", error}`

### agy CLI

- **Headless 模式**:[agy headless 文档](https://antigravity.google/docs/cli/headless)
  - `--input-format stream-json --output-format stream-json`
  - 输入：`{"event":"user","message":{"content":"..."}}`
  - 输出：`init` / `step_update` / `result` 事件
  - 工具调用：`step_type:"tool"`,`tool_info:{name, parameters, output}`

- **MCP 支持**:[agy MCP 文档](https://antigravity.google/docs/mcp)
  - agy 是 MCP 客户端
  - 配置文件：`~/.gemini/antigravity-cli/mcp_config.json`
  - 支持 stdio 和 HTTP MCP server

### 类似项目

- **[agy-mcp](https://pkg.go.dev/github.com/tphakala/agy-mcp/v2@v2.9.0)**:Go 实现的 agy MCP server 包装器，把 agy 作为 MCP server 暴露给其他 MCP 客户端。**参考其进程管理和 stream-json 解析**。

- **[magpie-community/plugins](https://github.com/magpie-community/plugins)**：社区插件仓库
  - `packages/grok`：启动 `grok` CLI 做登录/token 刷新（但推理用 HTTP)
  - `packages/zen-free`：唯一用 `keyless: true` 的例子

## 下一步工作

### 优先级 1：实现方案 B（异步 MCP 透传）

**任务清单**:
1. [ ] 实现 stdio MCP server(`mcp-server.mjs`)
   - 支持 `initialize` / `tools/list` / `tools/call`
   - 用 `@modelcontextprotocol/sdk` 或手写 JSON-RPC
2. [ ] 修改 `Proc.start()`:
   - 生成临时 `mcp_config.json`，指向我们的 MCP server
   - 启动 agy 时设置 `AGY_MCP_CONFIG` 环境变量（或 agy 支持的 flag)
3. [ ] 实现工具调用转发：
   - MCP server 收到 `tools/call` → 立即返回占位结果
   - 同时把调用信息写入 request-scoped state
4. [ ] 修改 `makeAnthropicStream`:
   - 从 state 读取工具调用 → 转成 `tool_use` block
   - 处理 `tool_result` → 渲染成文本发给 agy
5. [ ] 测试：
   - 端到端：客户端声明工具 → agy 调用 → 客户端执行 → 结果回传
   - 并发：多个对话同时调工具
   - 错误：工具执行失败、agy 进程崩溃

**关键挑战**:
- MCP server 和 `fetch` 之间的 state 共享（需要用 request ID 关联）
- agy 的 `mcp_config.json` 位置（可能需要 `--config` flag 或环境变量，需查证）
- 工具结果的超时处理（客户端可能不返回）

### 优先级 2：修复当前版本的基础问题

用户报告"完全无法使用"，除了 sign-in 问题（已修复）外，可能还有：
- [ ] 进程启动失败（agy 不在 PATH?)
- [ ] 协议解析错误（agy 版本差异？)
- [ ] 流式响应格式问题（magpie 的 Anthropic 解码器兼容性？)

需要用户在真实环境测试，收集错误日志。

### 优先级 3：发布准备

- [ ] 发布到 npm:`npm publish --access public`
- [ ] 贡献给 [magpie-community/plugins](https://github.com/magpie-community/plugins)（需要遵循其 PR 流程）
- [ ] 写用户文档（安装、配置、故障排查）

## 联系方式

- 当前开发者：在 magpie 的 Discord / GitHub Issues 找 `DylanLIiii`
- magpie 作者：yetone(GitHub)
- agy CLI 问题：[google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli)

## 开发环境

```sh
# 克隆仓库
git clone https://github.com/DylanLIiii/opencode-antigravity-bridge
cd opencode-antigravity-bridge

# 语法检查
node --check index.mjs

# 烟雾测试(用 fake agy)
node test-smoke.mjs

# 本地测试(需要真实 magpie + agy)
magpie plugin add ./opencode-antigravity-bridge
```

## 关键技术债务

1. **方案 B 的 state 管理**：需要设计 request-scoped state 机制，让 MCP server 能把工具调用关联到当前 HTTP 请求的 SSE stream。可能的方案：
   - 用 `AsyncLocalStorage`(Node.js 原生支持）
   - 或在 `Proc` 对象上挂 `currentRequest` 字段

2. **agy 的 MCP 配置方式**：需要确认 agy 是否支持：
   - 命令行 flag 指定 `mcp_config.json` 路径
   - 环境变量（如 `AGY_MCP_CONFIG`)
   - 还是必须写 `~/.gemini/antigravity-cli/mcp_config.json`（这会污染用户全局配置）

3. **工具结果的超时**:MCP server 返回"结果将在下一轮提供"后，如果客户端一直不返回结果，agy 会一直等。需要：
   - 在 agy 侧设置超时（如果 agy 支持）
   - 或在下一轮请求超时后，主动给 agy 发一个"工具失败"的消息

---

**文档版本**:2026-10-23
**当前 commit**: [`e786876`](https://github.com/DylanLIiii/opencode-antigravity-bridge/commit/e786876)
