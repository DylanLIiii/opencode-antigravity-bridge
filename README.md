# opencode-antigravity-bridge

把你的 **Antigravity 订阅**变成 OpenCode、Amp、Claude Code 等客户端的模型后端——
Gemini、Claude、GPT-OSS 全系可用。

**[English version → README.en.md](README.en.md)**

## 它解决什么问题

- 已经订阅了 Antigravity（Google AI Pro/Ultra 附带），却还要为 Gemini / Claude API
  另开一份付费？这个插件让订阅直接服务你的编码客户端。
- 不用逆向私有接口、不用伪装 IDE：它驱动**真实的 `agy` CLI**，走官方
  Agent Client Protocol（ACP），Google 看到的是正版 CLI 发出的请求。
- 客户端的工具（读写文件、跑命令等）原生透传给模型，不是文本约定 hack。

## 核心特性

- **全订阅模型可用**：Gemini、Claude、GPT-OSS 一应俱全，会话中可随时切换模型
  和思考等级；ACP 保持 Zed 兼容身份以支持 agy 的非 Gemini 模型 allowlist。
- **Prompt 风险收敛**：精确移除独立计费伪 header、规范化已知 Agent SDK 身份句，
  不全局改写用户正文；通用 429 不再被直接当作确定配额耗尽。
- **异常防重发**：同一逻辑 Prompt 在提交后失败、取消或进程退出时，不会因客户端
  自动重试再次交给 agy。
- **流式输出 + 思考摘要 + 图片输入**：文本、思考过程、图片按顺序完整呈现。
- **Claude Code 兼容**：支持尾随 system/developer 上下文、hooks、Skill /
  ToolSearch 工具附加内容和用户排队消息，兼容非流式 Messages 响应。
- **工具调用零损耗**：客户端工具以 MCP 原生工具的形式出现在模型面前，
  支持长任务、并行调用；工具跑得再久也不会丢结果。
- **会话不丢**：每轮结束自动记录会话状态（只存哈希，不落明文），
  重启 magpie 或插件后上下文原样续上。
- **额度可见**：在 Magpie 的 Usage 页面直接查看 Antigravity 订阅额度。
- **安全隔离**：不读取你的全局 MCP 配置和凭据；agy 的权限请求一律拒绝，
  真正的操作都发生在客户端侧。
- **省 token 实测**：见下。

## 省 token 实测

agy 默认 agent 自带约 8,000 tokens 的编码 prompt。本插件通过最小化 agent
配置把这部分干掉——客户端自己的 system prompt 和工具目录本来就是权威来源：

| 场景 | input tokens |
|---|---|
| agy 默认 agent（"Reply OK"） | 8,357 |
| 本插件（同一指令） | **509（-94%）** |
| 三轮编码会话含一次工具调用 | **4,109 vs 15,351（-73%）** |

Prompt caching 由 Google 后端决定，本插件让请求前缀尽量稳定：实测 26k token
的稳定 prompt 下缓存命中率 **91.7%**，OpenCode 这类带工具定义的长 prompt
通常在 90% 以上。每轮只发新增消息，不重放历史。

完整数据、缓存分析和测量方法见 [README.en.md](README.en.md#token-cost)。

## 30 秒上手

前置要求：

- 已安装 [magpie](https://github.com/yetone/magpie)，支持 OpenCode 风格插件
- 已安装 [Antigravity CLI](https://antigravity.google)（`agy`）并至少交互式
  登录过一次 Google 账号（实测版本 1.4.12 / 1.5.0）

```sh
# 1. 安装插件（本地 checkout，尚未发布 npm）
magpie plugin add ./opencode-antigravity-bridge

# 2. 交互式运行一次 agy 完成 Google 登录
agy

# 3. 在 Magpie 中：Providers → Antigravity Bridge → Sign in
# 4. 选一个模型（可选思考等级），开始对话
```

客户端侧零配置：不需要改全局 MCP 配置，插件为每个 agy 进程创建隔离的临时
agent。ACP `clientInfo` 固定使用 `zed / 0.0.0`，兼容 agy 的非 Gemini 模型 allowlist。

## 它是怎么工作的

```
客户端 (OpenCode / Amp / Claude Code ...)
  │  Anthropic Messages (POST /v1/messages, SSE)
  ▼
magpie 网关 ── antigravity-bridge provider（本插件）
  │  ACP JSON-RPC over stdio
  ▼
agy acp          ← 真实的 Antigravity CLI 进程
  │  客户端工具经私有 MCP 通道透传
  ▼
Google Code Assist 后端
```

会话、工具、取消、错误处理的完整协议细节见
[README.en.md](README.en.md)。

## 使用说明

**切换模型 / 思考等级**：在 magpie 的模型选择器中切换即可，会话不中断，
历史保留。

**查看订阅额度**：

```sh
magpie quota antigravity-bridge --json
magpie quota refresh antigravity-bridge --json
```

需要当前版本的 magpie（插件 usage 钩子，实测宿主 0.1.1599）。额度窗口仅作
展示，不会自动在额度耗尽时停请求。

额度探测使用独立的临时 Gemini 配置目录，不会扫描全局技能、规则、插件、MCP
或设置；登录态仍复用 agy 自己的钥匙串/ADC，或链接本机已有的文件 token。
旧版 agy 不支持该隔离参数时会回退到默认目录；设置 `AGY_BRIDGE_USAGE=0`
可完全关闭自动额度探测。

**客户端工具行为**：工具调用对客户端透明——模型发起 `tool_use`，客户端执行后
回传 `tool_result`，同一个 agy 回合继续。运行超过 150 秒的工具会先收到
"still running" 响应，结果最终送达，客户端每个调用只执行一次。

工具 schema 会先展开本地 `$ref`，再将可空类型、组合类型和元组转换为 agy
可接受的保守格式；无法直接表达的约束保留在描述中，执行参数仍由客户端校验。
客户端声明的 `ToolSearch` 若缺少 schema，会补齐 `query` / `max_results`；搜索后
新增的工具会先刷新目录，再继续同一回合。插件无法发现客户端未发送定义的工具。

## FAQ / 注意事项

- **图片**：只支持内联 base64（PNG/JPEG/GIF/WebP），不支持远程 URL 和二进制/PDF 文档；纯文本 document 和 search_result 可用。
  需要服务端声明 ACP 图片能力（agy 1.5.0 起）。
- **平台**：Linux / macOS 已验证。Windows 已补充 `.exe` / `.cmd` / `.bat`
  发现、启动和 WSL 路径处理，并有命令构造测试；维护者尚未完成 Windows 实机验证。
- **账号**：一个 Google 账号（agy 自己的登录态）；插件不会调用 ACP
  `authenticate` 去切换登录。
- **Prompt Guard**：默认开启，仅处理 system 中的独立计费元数据和已知 Agent SDK
  身份句；设置 `AGY_BRIDGE_PROMPT_GUARD=0` 可关闭。不会全局替换厂商名称或清洗 user 正文。
- **错误与重试**：通用 `RESOURCE_EXHAUSTED` 不再被当作确定配额耗尽；已提交 Prompt
  的相同请求重试会返回 `prompt_outcome_unknown`，不会再次调用 `session/prompt`。
- **会话状态文件**：`$XDG_STATE_HOME/magpie-agy-bridge/sessions.json`
  （0600，仅哈希），可用 `AGY_BRIDGE_STATE_FILE` 覆盖。system instructions 只在
  `session/new` 安装，resume 不重复 append；恢复失败保留旧快照。
- **超时**：启动 60s、agy 空闲 5min、等客户端工具结果 30min，可用
  `AGY_BRIDGE_START_TIMEOUT_MS` / `AGY_BRIDGE_TURN_TIMEOUT_MS` /
  `AGY_BRIDGE_TOOL_TIMEOUT_MS` 调整。
- **用量**：ACP 一轮只给一次累计值、agy 不推 `usage_update`；插件从 agy 本地会话库
  （`~/.gemini/antigravity-cli/conversations/<sessionId>.db`）读每次模型调用的真实用量，
  每个响应报自己覆盖的调用（含缓存读）。运行时没有 SQLite（Node < 22.5，Node 22/23 需
  `--experimental-sqlite`）或读不到库时回落估算；`AGY_BRIDGE_STEP_USAGE=0` 可完全关闭会话库读取。
- **长输出续写**：撞 `max_tokens` 时在同一会话、同一响应里自动续写，最多 3 次
  （`AGY_BRIDGE_MAX_CONTINUATIONS`，`0` 关闭）；agy 自己插入的"输出被截断"提示不会出现在正文里。

完整环境变量表、限制条件和开发/测试说明见
[README.en.md](README.en.md#environment-variables)。

## License

MIT
