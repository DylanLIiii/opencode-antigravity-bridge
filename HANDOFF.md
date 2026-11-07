# Handoff: opencode-antigravity-bridge

## 2026-11-07：Prompt 过滤经验、异常幂等与 P1 会话治理

- 参考 Antigravity-Manager / CLIProxyAPI 的公开 A/B 经验，新增结构化
  `prompt-guard.mjs`：只移除独立 Claude billing 元数据 block，并精确规范化两个
  Agent SDK 身份句；不全局替换厂商名，不处理 user/tool 正文，可用
  `AGY_BRIDGE_PROMPT_GUARD=0` 关闭。
- 新增 `upstream-error.mjs`：区分明确 quota、model capacity、forbidden、通用 429；
  通用 RESOURCE_EXHAUSTED 不再宣称为确定配额耗尽，默认不可自动重试。streaming 与
  non-streaming 错误共享分类、reason code 和 retryable 信息。
- 新增有界内存 Prompt claim（128 条、沿用 6 小时 TTL）：同一 conversation/history/
  current prompt 在提交后失败、取消或进程死亡时，相同 retry 返回 409
  `prompt_outcome_unknown`，不再调用 `session/prompt`；未提交的启动/配置失败可重试。
  状态不跨 bridge 进程重启，淘汰后无法识别旧请求。
- ACP `clientInfo` 按维护者决定保持原来的 `zed / 0.0.0`，用于 agy 非 Gemini 模型
  allowlist；未引入 bridge 身份或额外 ACP 身份环境变量。
- `systemPrompt.append` 仅随 session/new；resume 使用 reserve/commit/restore，失败不丢
  持久化快照，仅 Conversation Not Found/方法不支持等明确缺失回退 new。
- 工具目录未确认时发送前失败（`tool_list_unconfirmed`），相同请求可在确认后重试；
  MCP watch 有界退避重连并强制重新 list，control call 新增 `mcpRequestId` 关联字段。
  长工具仍沿用 agy 180 秒限制下的同参重调等待；MCP request ID 已保留，ACP
  toolCallId 尚未接入关联，agy 重调是否能提供稳定上游 ID 也未实测，不宣称该协议限制已消失。
- Claude Haiku 不再默认落到 Gemini Flash；无真实 Haiku family 时返回
  `model_unavailable`。
- 验证：Node 默认测试 **64 focused tests + 329 smoke checks** 全部通过；包括真实
  MCP helper 子进程和 localhost watch 重连。未运行真实 agy/Google、Windows 或 Bun
  全量测试，未提交、推送或发布。

## 2026-11-05：修复 ACP 缓存用量被重复扣减

- agy 1.5.1 实测 ACP usage：`inputTokens` 是**未缓存**输入，
  `cachedReadTokens` 单独计数，`totalTokens` 包含缓存。例：`2133 + 4899 + 6
  = 7038`。旧代码把 `inputTokens` 当成包含缓存并相减，导致 Magpie Log 出现
  `in=0`、`cache_read` 被截断（同一例会被报成 `0 / 2133`），缓存命中率和成本
  都失真。
- 现在用 `totalTokens` 判别新旧两种格式：新格式直接使用独立的 cache 字段；
  旧格式才从 `inputTokens` 中扣除缓存。响应级 usage 拆分也使用同一份 prompt
  总量，避免最终响应重复少算。
- 验证：Node smoke **295 checks** 通过；真实 agy 1.5.1 ACP 探针确认
  `2133 input + 4899 cache read + 6 output = 7038 total`。

## 2026-11-05：整合 PR #4 与 agy 1.5.0，维护者追加修复

本段更新此前记录：输入 schema 现在做 Gemini/Vertex 兼容化处理（不是完整
schema 校验），用户图片通过协商后的 ACP image capability 发送；旧版一律 400
和 schema 不删字段的记录仅描述当时行为。

- 同步随后合入 main 的中文 README，英文技术说明更新到 README.en.md。
- 原作者 gitxm 的六个提交完整保留；合并当前 main，保留模型/thought_level
  的 `session/set_config_option`、旧协议回退、图片能力声明和既有 1.5.0 测试。
- 工具 companion 绑定到实际前序结果；无匹配 Skill/ToolSearch/图片的文本拒绝。
  Skill 无标记的任意文本不再当工具输出；带明确头部的 prompt 仍支持。
- 排队消息共用同一解析器；图片历史重放保留相邻文本、嵌套工具图片的原始数据。
  部分重写工具 ID 的批次以完整历史匹配，并保留未重写 ID 的会话约束。
- 状态文件锁拿不到时跳过保存，不偷取仍存活进程的锁；过期且 owner 已退出
  的锁可恢复。通用 reasoning effort 参数无需 Anthropic thinking envelope，
  既有 output_config.effort gating 保留。
- 新增 platform.mjs：Windows exe/cmd/bat 发现、cmd 参数转义、nc.cmd 路径处理。
  命令构造已测试，未进行 Windows 实机端到端验证。
- Node/Bun：各 266 smoke checks + 25 focused tests 通过。Linux 真机 agy
  1.5.0：图片识别、原生 MCP 工具调用、跨进程 resume、思考等级变更通过；
  Flash 未输出思考摘要，不宣称本轮验证了思考文本。

## 2026-11-04：agy 1.5.0 图片输入和 ACP 配置选项

- 图片：内联 base64 PNG/JPEG/GIF/WebP 转 ACP image，保持文本/图片顺序，覆盖
  首轮、续聊和历史重放。启动握手必须声明 `promptCapabilities.image`，否则
  返回真实 HTTP 400；URL、无效 base64 和用户 document 仍拒绝。Gemini/Claude
  模型声明 `capabilities.input.image`。历史比较忽略图片 cache metadata，落盘仍只存哈希。
- 模型/思考等级：优先读 ACP `model`、`thought_level` select 配置，经
  `session/set_config_option` 设置。支持分组、按 category 找自定义 ID、模型切换
  后刷新可选等级，以及 `config_option_update` 通知。只有缺选项/Method not found
  时兼容 `session/set_model`，真实错误不静默回退。初始模型目录仍由 `agy models`
  发现；显式 legacy ID 保持原有等级语义。
- `test-integration.mjs`：显式 `AGY_BRIDGE_INTEGRATION=1 npm run test:integration`
  才运行，使用真实额度，私有临时 bridge state；两个 Node 进程验证图片识别、
  一次 MCP 工具往返、文本/usage 和跨进程续接后的图片/工具记忆、等级变化。
  `AGY_BRIDGE_TEST_MODEL` 可指定模型，`AGY_BRIDGE_TEST_USAGE=1` 加测真实额度。
- 验证：Node **208 smoke checks + 14 quota tests**。真实 Linux agy **1.5.0**
  + Gemini 3.8 Flash、Gemini 4 Argon 均通过上述集成检查；独立控制面探针通过
  Gemini/Claude 配置切换及 high/low 等级切换。两个模型的首轮均未发思考摘要。
  当前环境没有 Bun。
- Argon 曾在 ACP 启动阶段超出 60 秒；续跑时独立探针创建会话约 15 秒，配置
  切换为毫秒级，随后完整集成检查通过。原超时未复现，原因未定，未放宽默认时限。
- 额度查询：此前真实 Google eligibility 请求 EOF，最终 quota hook 重试在 18 秒
  预算内超时，尚未取得 1.5.0 的成功 quota report；parser 和 18 秒上限未改。
  未重测 1.5.0 动态工具目录、取消和超长工具，也未测 GUI。
- 本机 agy 包装器原指向未运行的 127.0.0.1:7890；真机验证仅对子进程传
  `AGY_PROXY` 使用可用代理，未改全局配置。未发布或替换已安装插件。

详细评估和未验证项：`docs/plans/2026-11-04-agy-1.5.0-compatibility.md`。

## 2026-11-03：传输层重构为 ACP（`agy acp`），参考 T3 Code

起因：stream-json 只给最终回复和 `thinking_tokens`，不给思考文本；`agy acp`
（1.4.12 帮助里未列出）会发 `agent_thought_chunk`（思考总结）。参考
pingdotgg/t3code `apps/server/src/provider/acp/`（`b7ab02e0f6`）：它用独立下载的
`agy_acp_server.par` 1.4.5，本插件用 CLI 内置的 `agy acp`，协议相同。

真实 agy 1.4.12 探针结论（脚本在会话临时目录，未入库）：

- `clientInfo.name: "zed"` 才列出 Claude/GPT-OSS（照搬 T3）。不要调用 ACP
  `authenticate`：`oauth-personal` 会换认证路径，随后报 `User location is not
  supported`；不调用时沿用 CLI 登录正常。
- 自定义 agent `tools: []` 并**不**限制内置工具，且会继承全局
  `~/.gemini/config/mcp_config.json`（旧桥接把用户全局 MCP 暴露给了模型）。
  `inheritMcp: false` + `inheritCustomizations: false` + `excludeDefaultComponents:
  true`：首轮 input 8,357 → 509。`_meta.antigravity.disabledTools` 在 1.4.12 无效；
  `systemPrompt.append` 有效。
- `session/new.mcpServers` 和 frontmatter `mcpServers` 在 ACP 下会连接但**不进模型
  工具目录**（T3 源码注释也承认，T3 兜底是让 agent 跑 `t3 acp-mcp-call`）。可用的是
  `--ide-mcp-port`：agy 执行 `nc 127.0.0.1 <port>`，工具以 `mcp_ide-tools_<name>`
  直接函数出现、无权限请求、`toolSummary` 不进入参数；名称 104 字符也可。
  本机无 `nc`，所以桥接在 agy 的 PATH 前放私有 `nc` → 直接 exec `mcp-server.mjs`
  （沿用 token 控制通道）。
- MCP helper 若响应 `server/discover`，agy 走 2026-07-28 并发 `subscriptions/listen`，
  `list_changed` 无效；返回 Method not found 回退 `initialize` 后 `list_changed`
  立即重新 list。
- IDE MCP 调用固定 180 s 超时，progress 通知不能延长。桥接 150 s 回 "still
  running"；Gemini 不理会 await 工具、会用同参重调，所以同名同参重调被视为等待原调用
  （不再转给客户端），agy 结束 turn 后到达的结果用同一响应内的追加 prompt 交付。
- 上游错误是消息块 `⚠ Agent execution terminated due to error.` + `end_turn`
  无 usage；真实原因只在 `--log-file`（`errorreport.go ... agent executor error:`）。
- `session/cancel` 后会话可继续；`session/resume` 跨进程、换 cwd 可用，但模型回到
  账户默认，需重新 `set_model`。ACP usage 为每 prompt；agy 1.5.1 的
  `inputTokens` **不含** `cachedReadTokens`（`input+cacheRead+output+thought =
  total`）。早期记录曾误以为 input 含 cache，已在本页顶部修复说明。
- 用户消息中的 ACP image 块模型收不到（未声明 promptCapabilities.image），保留 400。

实现（`index.mjs` 重写传输层，历史匹配/续接/通知逻辑保留）：AcpConnection、
思考块转发（ACP 不暴露模型签名，Gemini/Claude 的 thought chunk 都只有 text；
桥接在块结束前发 `signature_delta`，`agyb1.` + 进程内随机密钥对会话与文本的
HMAC-SHA256，客户端才会保留并回传；Anthropic API 不认此签名）、按 turn 的 usage 换算、权限一律拒绝（不再用
`--dangerously-skip-permissions`）、会话内换模型（会话键不再含 model）、工具
`list_changed`、idle/LRU park + resume、中断改 cancel、错误标记识别与日志取因、
长工具等待。`mcp-server.mjs`：2025-11-25、watch 通道推 `list_changed`、
`AGY_BRIDGE_MCP_TRACE` 诊断。

验证：Node/Bun 各 **170 smoke checks + 14 usage tests** 通过（假 agy 讲 ACP、经
桥接 `nc` 垫片连真实 helper）。真实 agy 1.4.12（Linux）经 fetch hook：思考+正文、
工具往返、Gemini→Claude 会话内切换保留记忆、取消后续聊、对话中加工具、50 s 工具
在 20 s deadline 下两次重调等待且客户端只执行一次、idle 回收后新进程 resume。
三轮含一次工具往返的对话 input 合计 4,109 vs 保留默认组件 15,351。
会话落盘（之后补）：每轮结束及回收时把会话记入 `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json`
（0600，只存 sessionId、workDir、历史与指令的 SHA-256，`AGY_BRIDGE_STATE_FILE` 可改），重启后
哈希一致即 `session/resume`；真实 agy 下新 Node 进程续聊成功。多个 bridge 进程合并写入。
缓存：5.5k 稳定前缀经 bridge 4 轮。`gemini-4-argon-low` 第 2 轮起命中（input/cacheRead
2,155/3,513、2,152/3,619、2,151/3,722）；`gemini-3.8-flash-low` 在 append / 首条消息 / 默认
组件三种放法下都是 0。前缀稳定由桥接保证，命中与否取决于模型后端。argon 每轮命中 = 上一轮总量 − 2,049（第 2 轮
差 2,054），即请求最后约 2k token 永远不走缓存；26k prompt 第 3 轮 23,944/26,097 = 91.7%，
与预测完全一致。agy 请求是追加式的（`Local Time` 写在每条 user 消息内，之后不变），会话库
`~/.gemini/antigravity-cli/conversations/<id>.db` 的 `gen_metadata` 里 `1.4.2`/`1.4.5` 是每轮
未缓存/缓存 token，可用来核对。注意 `pgrep -f` 会匹配自身所在
bash，检查遗留进程时别被它误导。
未验证：Magpie GUI、OpenCode 端到端、macOS/Windows 上的 ACP 传输。未提交/推送。

## 2026-10-26：真实 agy 额度查询（本地新增）

用户已确认使用真实 CLI 查询，而非直接请求 Google 内部 API。

- 新增 `usage.mjs`：先验证 agy >= 1.1.11，再执行结构化 `/usage` 命令；
  snake/camel case、nested/oneof fraction、模型独立分组、五小时/周窗口、
  reset 时间均支持。缺失 fraction 不当作 0 或 1，disabled bucket 不展示。
- `index.mjs` 增加 Magpie `auth.usage`，返回 display-only windows
  (`aside: true`)；不改变请求路由、不读写 Google 凭据、不假定邮箱/套餐。
- 临时受限 agent、浏览器失败启动器、child-only 禁用自动更新；默认 15 秒
  总子进程预算（最高 18 秒）、version 最多 3 秒、输出最多 1 MiB；清理自有
  POSIX 进程组和临时目录。已脱离该进程组的后代不在清理保证内。
- 同时查询合并，完成后不缓存，重试或切换 agy 账号不会命中插件旧结果。
  Magpie 自己可能缓存；错误为固定诊断且 `signIn: kept`，不误撤销桥接登录。
- Windows 的额度查询明确报不支持；不影响现有推理桥接代码。

参考 CodexBar `0aa34100` 的 CLI report/parser、browser guard、version gate，
Magpie `5b4dec58` 的 host usage hook 及官方 Antigravity pools。设计和实现计划
位于 `docs/plans/2026-10-26-agy-usage*.md`。

验证：Node / Bun 各 **14 focused tests + 127 smoke checks** 通过。真实 agy
1.4.7 直接 hook 查询成功；官方 Magpie v0.1.1599 `host.js`（与本机版本对应）
在临时配置中识别 `usage: true` 并成功返回 5 个含 reset 时间的额度窗口，
包括 Gemini 4 Argon 独立周额度。该 host 验证使用临时 sentinel auth，未复制
Google 凭据、未改现有 Magpie/agy 配置。未做 GUI 截图或 Linux 真实验证。

查询：`magpie quota antigravity-bridge --json` 或
`magpie quota refresh antigravity-bridge --json`（需安装的是更新后的代码）。
截至本记录未推送、发布或替换用户当前安装。

## 2026-10-26：真实 OpenCode system-update 修复与本地验证

真实 OpenCode 请求录制确认：动态 Code Mode 工具目录变化时，客户端会在 tool
result 后追加独立的 `<system-update>` 用户消息。旧实现把它当普通用户插话，
返回 `text beside a live tool_result`。现支持完整 system-update 元素，连同
task-notification 放入独立 MCP system-reminder；普通插话、未闭合 update、
result 前 update 仍返回 400。

Node/Bun 各 123 项 smoke checks 通过。真实 agy 1.3.5 + Magpie 0.1.1564 +
OpenCode 2.1.2 的隔离本地链路已完成两次 shell 调用：第一次实际 exit 18，
system-update 后续接，第二次成功，最终 end_turn，OpenCode exit 0。usage 明确
为 antigravity-bridge 本地 provider，不是 remote-magpie。

主配置 `noAccountDiscovery: true` 会同时过滤插件账号，导致本地 provider 不在
catalog，完整模型 ID 随后被 remote-magpie 的嵌套 bare model 匹配。验证使用独立
XDG 配置和 `MAGPIE_ADDR=127.0.0.1:3426`，未改变主配置。

真实重复探针发现 agy 偶发在 init 前因 Google eligibility/userinfo EOF 失败；
这不同于工具续接。启动默认超时改为 60 秒（AGY_BRIDGE_START_TIMEOUT_MS 可覆盖），
pre-init result ERROR 现在保留上游真实错误文本。

真实 agy 探针确认：thinking_tokens 可大于零，但 stream-json/json 只暴露最终
response，没有 thinking 文本或 signature。bridge 现按 per-turn delta 在
message_delta.usage.output_tokens_details.thinking_tokens 回传真实计数，不伪造
thinking blocks。

## 2026-10-26：工具续接修复与官方对齐（工作区修改）

用户报告 `agy bridge: conversation history changed before these tool results`。
旧实现对包含插件生成的 assistant 回复在内的完整 JSON 做严格比较，仅忽略对象
key 顺序。已复现：客户端增加 cache_control、转换 string/text blocks、拆分回复、
裁去末尾换行时返回 409；改写 tool ID 或压缩历史也无法正确续接。没有用户原始
请求，因此不能断言这次 Mac Mini 报错具体是哪一个字段变化。

当前改动：

- 按内容比较历史，忽略传输元数据，合并连续同角色/文本块，保留工具参数、结果
  和文本内部空白；工具 ID 按调用位置比较。
- ID 不变时直接定位调用；客户端改写 ID 时只接受历史、名称、参数和顺序唯一
  匹配的 pending response。歧义不猜测；不同会话混合结果及冲突重复仍拒绝。
- 已知调用的真实历史或模型/工具/目录变化时关闭旧进程，重放当前历史和实际
  工具结果，不再因该变化返回原来的 409；接续成功后保存客户端实际历史。
- 支持结果旁及随后 user/system/developer 消息里的 task-notification，放入
  MCP 结果的独立 system-reminder。普通用户插话依旧 400，尚未验证 agy 队列语义。
- 识别 header 或调用方环境文字中的目录，存在的绝对目录使用 --add-dir；提示
  模型工具在调用方环境执行。继续使用隔离 agent 工作区，不写用户项目配置。

对照了 Magpie `e5dd86965b56a8a176790e2c1ade09f9ef554208`（最近可达 tag
`v0.1.1566`）的 match/remap/follows/serveSubscription，以及 10 月 24 日任务
通知、10 月 26 日调用方目录/环境相关提交。Claude 专用的多账户命名转换、
--json-schema 修复、内存预算与落盘 session resume 未照搬；MCP schema 不删字段。
详细来源和仍有差异的行为见 README 的 Official Claude Bridge alignment。

验证：旧代码加回归场景出现 5 个失败断言；修复后 Node 和 Bun 分别运行
`test-smoke.mjs`，**106 checks 全部通过**，三个 mjs 的语法检查通过。当前 orb
没有真实 agy/Magpie；以下旧记录中的真实 agy 1.3.3 / Magpie 0.1.1356 验证不涵盖
本次修改。本次未提交、推送、发布或更新用户 Mac Mini 的安装。

以下是 2026-10-24 的实现背景与历史验证记录；涉及严格历史比较、通知支持和
测试数量的旧描述以上文为准。

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
  Anthropic 内容转换、模型发现及思考等级聚合与路由。
- `mcp-server.mjs`：无外部依赖的 stdio JSON-RPC helper，支持 modern/legacy
  MCP、并发 pending 调用、取消和断线处理。
- `test-smoke.mjs`：fake agy + 真实 MCP helper 的端到端烟雾测试。
- `package.json`：发布文件包含 `index.mjs`、`mcp-server.mjs` 和 README。

## 已执行验证

基线的 `node --check index.mjs` 和原 15 项检查曾全部通过。

当前实现：

- `node --check index.mjs`、`node --check mcp-server.mjs`、
  `node --check test-smoke.mjs` 通过；
- `node test-smoke.mjs`：**65 项全部通过**，覆盖原生工具闭环、并行/连续
  调用、真实结果、原子化批量结果校验、相同开场会话隔离、同时启动、UTF-8
  分块、工具错误、崩溃、超时、取消、临时目录清理、动态模型、思考等级聚合
  与真实 agy ID 路由、旧完整模型 ID 兼容、`api.npm` 协议声明和真实 HTTP 400；
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
