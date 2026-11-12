# opencode-antigravity-bridge

把你的 **Antigravity 订阅**变成 OpenCode、Amp、Claude Code 等客户端的模型后端——
Gemini、Claude、GPT-OSS 全系可用。

**[English version → README.en.md](README.en.md)**


精简 agent 默认开启；设置 `AGY_BRIDGE_MINIMAL_AGENT=0` 可关闭，这与 agy-cli 的默认关闭有意不同。缺少逐调用记录时，工具轮次的缓存用量是有界估算，不能证明 Google 实际缓存命中；ACP 输出量包含一次思考量。

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
  agy 内部的会话标题摘要也在同一思考流里，其提示词回显不再转发到客户端
  （诊断时可设 `AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS=1` 恢复）。
  过滤依据已知提示词签名：未验证原生来源标记；任意分片可能漏过，合法思考若回显相同签名
  也可能被过滤。
- **Claude Code 兼容**：支持尾随 system/developer 上下文、hooks、Skill /
  ToolSearch 工具附加内容和用户排队消息，兼容非流式 Messages 响应。
- **工具调用零损耗**：客户端工具以 MCP 原生工具的形式出现在模型面前，
  支持长任务、并行调用；工具跑得再久也不会丢结果。
- **会话不丢**：每轮结束自动记录会话状态（只存哈希，不落明文），
  重启 magpie 或插件后上下文原样续上。
- **额度可见**：在 Magpie 的 Usage 页面直接查看 Antigravity 订阅额度。
- **上下文与用量可追踪**：向客户端声明上下文窗口，并在工具等待前读取生成级账单，
  日志分别记录实际输入、缓存与 AGY 本地上下文估算。
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
- 已安装 [Antigravity CLI](https://antigravity.google)（`agy`）；可在 Magpie 中添加
  独立 Google 登录，也可复用已有 CLI 登录。UI 登录要求 `agy acp --login`
  （已核对 1.5.4 的授权链接与输入流程）

```sh
# 1. 安装插件（本地 checkout，尚未发布 npm）
magpie plugin add ./opencode-antigravity-bridge

# 2. 在 Magpie 中：Providers → Antigravity Bridge → 登录
#    已接入时点击「添加另一个 Antigravity Bridge 账号」，再选择「新增 Google 账号」
# 3. 填写名称（例如 work），在浏览器完成 Google 登录，
#    把最终回调页面的完整 URL 或授权码粘贴回 Magpie
# 4. 选择 work/<模型>（可选思考等级），开始对话
```

### 账号管理入口

原生模式下，在 **Providers → Antigravity Bridge** 中，首次接入点「登录」，已有连接点
「添加另一个 Antigravity Bridge 账号」。这两个入口都会先显示操作选项，打开它们不会立即开始 Google
登录，也不会替换已有账号。选项名称随 Magpie 的界面语言显示：

| 操作 | 用途 |
| --- | --- |
| 使用已有 CLI 登录 | 验证当前 agy CLI 的登录，不启动新的 Google 登录 |
| 导入账号 | 将已有配置目录或 token 文件导入为一个新名称的账号 |
| 批量导入账号 | 从 JSON 清单一次导入多个账号 |
| 新增 Google 账号 | 在浏览器登录 Google，保存为一个新名称的账号 |

新增和导入都会保留已有账号；名称已被使用时会拒绝操作，请换一个名称。
插件中的 Google 账号按名称独立保存，使用 `<账号>/<模型>` 选择对应账号。
Magpie 中保留一条 Bridge 连接记录；新增和导入完成后，宿主会按同一个 `agy`
标记合并连接记录，不会因为新增 Google 账号而增加重复连接。
WSL 模式仅支持使用发行版内已有的 CLI 登录，不提供命名账号的新增或导入选项。

客户端侧零配置：不需要改全局 MCP 配置，插件为每个 agy 进程创建隔离的临时
agent。ACP `clientInfo` 使用本包名称与版本；模型列表按账号探测实际可用型号。

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

**在 Magpie 中登录新账号**：通过上面的账号管理入口选择「新增 Google 账号」，
输入一个未占用的名称并提交后，Magpie 打开 Google 授权链接；
完成后把浏览器最终停留的 `https://antigravity.google/oauth-callback?...` 完整地址
粘贴回 Magpie（推荐，也可只粘贴页面显示的授权码）。当前官方 CLI 使用这个网页回调，
需要手动粘贴，没有本机自动回调。远程 Magpie 也使用相同流程。

插件在隐藏临时目录里运行官方 `agy acp --login`，完整回调 URL 会先校验来源、路径
及本次登录的 state，授权码再通过 stdin 交给原 agy 进程。PKCE、换取 token 和之后
的刷新均由 agy 处理。只有 agy 成功退出、保存了含 refresh token 的文件、且独立
`agy models` 检查通过，才通过导入后端发布账号并清除模型缓存。选择 `<名称>/<模型>`
即可使用该账号独立的 ACP 进程池。

凭据仅保存在 Bridge 的账号目录，Magpie 账户存储里仍是 `agy` 标记；不会切换全局
登录态或覆写已有同名账号。登录进程强制使用文件存储，POSIX 上目录为 `0700`、
发布的 token 为 `0600`；Windows 的文件权限要求见下方。一次登录最多等待 10 分钟；
新的登录会清理上次未完成的流程。取消开始或完成步骤会立即清理；关闭等待粘贴的
界面后，插件会在到期或下次登录时清理隐藏目录和进程。失败后请重新开始，使用新回调。

**多账号**：新 UI 登录会自动创建
`~/.config/magpie-agy-bridge/accounts/<名称>/`（可用 `AGY_BRIDGE_ACCOUNTS_DIR`
覆盖根目录）。也可手动准备一个完整的 Gemini 配置目录，并在该目录里登录一次：

```sh
agy --gemini_dir=~/.config/magpie-agy-bridge/accounts/work
```

登录产生的 `antigravity-cli/antigravity-oauth-token` 会落在该目录里。之后每个
账号的模型都会以 `<名称>/<模型id>`（显示名带 `[名称]` 前缀）出现在 magpie 模型
选择器里，选哪个就走哪个账号；会话、进程、快照和额度都按账号隔离。默认账号
（agy 自己的全局登录态，模型不带前缀）始终保留。要求 agy 支持 `--gemini_dir`
 且账号使用文件 token 登录态——钥匙串/ADC 登录态是整机全局的，无法按目录隔离。

**导入账号**：除了在配置目录里登录，也可以导入已有的 agy 登录——在账号管理操作中选
「导入账号」或「批量导入账号」，也可用随包 CLI。路径是运行
Magpie 那台机器上的路径，两者调用同一个后端：

```sh
agy-bridge accounts import work ~/.config/agy-work             # 配置目录
agy-bridge accounts import work ~/token/antigravity-oauth-token   # token 文件
agy-bridge accounts import --manifest accounts.json             # [{"name","source"}]
agy-bridge accounts list
```

导入只复制 `antigravity-cli/antigravity-oauth-token`（`0600`，目录 `0700`）到
`<账号根目录>/<名称>/`，之后仍由 agy 自己刷新。已存在的账号绝不覆盖（换个名称即可）；
清单会先整体校验再写入，批量导入要么全成功要么全不变；token 不会被打印。导入后刷新
模型目录。Magpie 自带的 `magpie accounts import antigravity` 是另一套内置账号存储，
不会流入本插件。
刷新模型目录会重新扫描账号目录。

**Windows 文件登录态**：原生 Windows 上 agy 把默认登录放在 Windows 凭据管理器
（整机只有一个 `gemini:antigravity` 条目）。只跑
`agy --gemini_dir=<目录>` 会复用这个默认账号，不会写 token 文件，桥接因此发现
不了第二个账号。请只对这次账号登录强制使用文件登录态，原有凭据管理器条目不会
被改动。PowerShell 示例：

```powershell
$env:WSL_INTEROP = "1"   # agy 的文件存储开关，不是真正的 WSL interop 路径
agy --gemini_dir="$env:USERPROFILE\.config\magpie-agy-bridge\accounts\work"
Remove-Item Env:\WSL_INTEROP
```

登录会写入
`%USERPROFILE%\.config\magpie-agy-bridge\accounts\work\antigravity-cli\antigravity-oauth-token`。
桥接会为命名账号进程设置同一个开关，让它们读取该文件而不是凭据管理器；默认账号
仍然使用全局登录。在真正的 WSL 会话里 `WSL_INTEROP` 已经存在，agy 本来就会用
文件登录态，不要覆盖它的 interop 路径；如果无法使用 `WSL_INTEROP`，可以改用
`SSH_TTY=1`。

token 文件是明文 JSON，包含 refresh token。建议登录前把账号目录限制为当前
Windows 用户：

```powershell
icacls "$env:USERPROFILE\.config\magpie-agy-bridge\accounts\work" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
```

Windows 没有受支持的按账号加密存储：凭据管理器只有整机全局条目。如果无法接受
明文 refresh token，请只保留一个账号，或把每个账号隔离到独立的 Windows 用户
配置或虚拟机中。

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

相同开场的后台请求在工具等待期间会使用独立的池内会话，保留原分支的工具调用。
各分支和账号共用默认 16 个进程的上限，可通过 `AGY_BRIDGE_MAX_PROCS` 设置正安全整数；
Magpie 另有插件并发上限 16。池满时优先淘汰空闲进程，然后回收最久没有客户端进展、
已脱离 HTTP 响应的工具等待回合，默认宽限期为 30 秒（`AGY_BRIDGE_DETACHED_EVICT_MS`，
正毫秒数），或已过期的脱离回合。正在响应、接受工具结果、取消或接收 steer 的会话不会因此被淘汰。
没有可回收进程时新请求仍返回 503；被回收的会话可携带完整工具结果历史在新进程上重放。
长耗时工具可调大宽限期；容量充足时仍按 `AGY_BRIDGE_TOOL_TIMEOUT_MS` 等待结果。
后续消息按历史选择分支，完成的分支分别保存快照，支持淘汰或重启后 resume，
不猜测有歧义的历史匹配。
用户排队文本与 `tool_result` 合并到同一消息时（结果前后均可），若历史、instructions
和工作目录兼容，且工具结果完整，AGY 1.5.0 起优先通过同一 session 的第二个
`session/prompt` 原生 steer。实时结果只通过 MCP 交付，尚未送达的延迟结果随新指令
补交；两个 ACP 请求都结束后才结束客户端响应，工具仍只执行一次。
旧版本、切换模型或服务端明确拒绝并发 prompt 时，退到同会话的 cancel → 等待结束
→ 新 prompt；已经结束或正在取消的旧 turn 也优先在原 session 续接。
结果不完整时保留原工具回合并拒绝请求。只有历史实际改写、会话指令或工作目录不兼容，
以及原会话无法恢复等情况才需要重放。历史比较会归一化消息分块、工具 ID 等表示差异，
不会单凭文本相似度百分比忽略改动过的工具结果。完整的系统通知和已识别的工具附加内容仍可直接续接。
分支已被回收后，完整的迟到结果与新的用户指令也可独立重放，不会被仍在等待工具的
主分支阻塞。因池满被回收、且仍有路由记录的分支，完整迟到结果无需附加用户指令也可重放；
路由哈希仅保存在内存中，最多 128 条，保留至 `AGY_BRIDGE_RESUME_TTL_MS`。
其他没有用户指令的未匹配结果仍保守返回 409。

工具 schema 会先展开本地 `$ref`，再将可空类型、组合类型和元组转换为 agy
可接受的保守格式；无法直接表达的约束保留在描述中，执行参数仍由客户端校验。
客户端声明的 `ToolSearch` 若缺少 schema，会补齐 `query` / `max_results`；搜索后
新增的工具会先刷新目录，再继续同一回合。插件无法发现客户端未发送定义的工具。

## 上下文窗口与压缩

插件默认向宿主返回 `limit.context = 256000`，供客户端安排压缩和显示上下文占用。
这是保守的客户端策略值。AGY 自身的 checkpoint 阈值、单步输入上限和模型物理窗口
也会影响实际可用上下文。本机 AGY 1.5.3 的 ACP 配置只提供模型、思考等级和模式，
尚未暴露上下文档位。

如果已独立确认当前 CLI、模型和账号能使用更大的窗口，可在 Bridge 进程环境中设置
`AGY_BRIDGE_CONTEXT_WINDOW=512000`，重启插件并刷新客户端模型目录。
该变量接受 1 至 1,048,576 的整数，非法值回到默认策略。
GPT-OSS 的声明始终取配置值与 131,072 中的较小值。
窗口声明只改变客户端收到的元数据，扩容效果仍取决于 AGY 本身。
每次提交的 1 MiB 文本预算另由 `AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES` 控制。

#### 可选上下文解锁（默认关闭）

agy 没有原生参数可以放大上下文窗口或解除单条消息 64K 截断，唯一已知办法是与版本、
架构绑定的机器码补丁，因此它是显式、可恢复的可选项，绝不会自动运行：

```sh
agy-bridge context status
agy-bridge context unlock     # 需要 Python 3.8+；复制 agy，只补丁副本
agy-bridge context disable [--purge]
```

`unlock` 把官方 `agy` 复制到 `~/.config/magpie-agy-bridge/context-unlock/`
（`AGY_BRIDGE_CONTEXT_DIR`），用固定且校验 SHA-256 的
[`agy-patch.py`](https://github.com/lili-luo/dsh-plugin-bundle/tree/0a90ec37c69430608084e33ebc2f891e328c9e89/agy-context-unlock)
（MIT，Copyright (c) 2026 lili-luo，见 `vendor/agy-context-unlock`）**只补丁副本**，
复查全部六个 gate，并把来源/补丁脚本/补丁后三者的 SHA-256、版本和架构写入 manifest。
官方安装从不被修改。若构建未知、gate 不匹配，或官方 agy 之后变化（如 `agy update`），
桥继续使用官方 agy 和默认 256K；更新后请重新 `unlock`。`unlock`/`disable` 后重启
Magpie：agy 二进制在启动时选定，运行中的会话不会切换上下文模式。只有选中已校验的副本
时，桥才向客户端声明 512K（仍可用 `AGY_BRIDGE_CONTEXT_WINDOW` 覆盖，GPT-OSS 仍为
131,072），并只应用 `AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES`，不再套用官方 agy 的
180,000 字节上限。该声明只是客户端压缩策略，不是已验证的上限。**限制：**上游仅验证
agy 1.4.12–1.5.3；对 1.5.4（macOS arm64）副本的 dry-run 命中全部六个 gate，但
1.5.4 及其他平台均未做端到端长上下文运行。

选择副本时会校验官方源文件和副本的 SHA-256。已发布副本按哈希复用，发布失败保留旧的
manifest；旧副本留到显式 `context disable --purge` 才删除。普通 `disable` 仅关闭选择。
使用 `--purge` 前请停止仍使用副本的 Magpie 进程。

生成级用量日志 `agy_bridge_model_usage` 包含账单来源 `gen_metadata` 或 `steps`、
实际输入、缓存读写、输出、思考量及 `context_tokens`。生成记录提供的
`local_context_estimate` 是发送前的本地估算，可与实际输入对照排查上下文变化。
两者可能存在正常差异，需要结合会话重放和用户操作判断原因。
日志只记录数值和会话标识，每分钟最多 30 条，`AGY_BRIDGE_EVENTS=0` 可关闭。

本次改进参考了社区的上下文调研和 ACP 插件，以及其生成记录解码方式。
512K、900K 的额度倍率来自社区经验，适用情况需要以当前账号实测为准。
[上下文调研](https://linux.do/t/topic/3117832) ·
[ACP 接入方案](https://linux.do/t/topic/3133812) ·
[参考实现](https://github.com/lili-luo/dsh-plugin-bundle/blob/457b9395e9bd8a1aefae2b83cda7e5e9e08af783/dsh-llm-antigravity-acp/src/usage-db.ts)

## Windows 宿主 + 仅安装在 WSL2 的 agy

在 Windows 上启动 Magpie 前设置 `AGY_BRIDGE_WSL_DISTRO=<发行版>`。此时 `AGY_PATH` 是该发行版内的单个 Linux 可执行文件（绝对路径如 `/home/me/.local/bin/agy`，或裸 `agy`）；可选 `AGY_BRIDGE_WSL_EXE` 覆盖 `wsl.exe`。桥不会扫描发行版，也不会回退到原生 agy；配置在重启 Magpie 前固定。要求：WSL interop、标准 `/mnt/<盘符>` 自动挂载、同一发行版的默认账号已登录 agy。原生 Windows/macOS/Linux 不受影响。WSL 模式明确不支持：命名 profile、profile 导入、浏览器 OAuth 账号登录、额度查询、上下文解锁与逐步会话数据库用量（改用估算）；UNC 路径会被拒绝，自定义挂载根不受支持。仅用模拟启动/ACP/MCP 夹具测试，未在真实 Windows/WSL 主机验证。

## FAQ / 注意事项

- **图片**：只支持内联 base64（PNG/JPEG/GIF/WebP），不支持远程 URL 和二进制/PDF 文档；纯文本 document 和 search_result 可用。
  需要服务端声明 ACP 图片能力（agy 1.5.0 起）。
- **平台**：Linux / macOS 已验证。Windows 已补充 `.exe` / `.cmd` / `.bat`
  发现、启动和 WSL 路径处理；额度查询支持浏览器拦截、临时凭证副本、进程树清理和文件删除重试。
  这些路径已有自动化测试；维护者尚未完成 Windows 实机验证。
- **账号**：默认一个 Google 账号（agy 自己的登录态）；插件不会调用 ACP
  `authenticate` 去切换登录。需要多账号时使用上方"多账号"小节的
  `--gemini_dir` 隔离方案（模型名 `<账号>/<模型id>` 前缀路由）。Windows 上
  命名账号还需要该小节的"文件登录态"开关，否则 agy 会读取整机全局的凭据管理器。
- **Prompt Guard**：默认开启，仅处理 system 中的独立计费元数据和已知 Agent SDK
  身份句；设置 `AGY_BRIDGE_PROMPT_GUARD=0` 可关闭。不会全局替换厂商名称或清洗 user 正文。
- **错误与重试**：通用 `RESOURCE_EXHAUSTED` 不再被当作确定配额耗尽；已提交 Prompt
  的相同请求重试会返回 `prompt_outcome_unknown`，不会再次调用 `session/prompt`。
- **会话状态文件**：`$XDG_STATE_HOME/magpie-agy-bridge/sessions.json`
  （0600，仅哈希），可用 `AGY_BRIDGE_STATE_FILE` 覆盖。system instructions 只在
  `session/new` 安装，resume 不重复 append；恢复失败保留旧快照。
- **超时**：启动 60s、agy 无实质输出 120s、等客户端工具结果 30min，可用
  `AGY_BRIDGE_START_TIMEOUT_MS` / `AGY_BRIDGE_TURN_TIMEOUT_MS` /
  `AGY_BRIDGE_TOOL_TIMEOUT_MS` 调整（正毫秒数）。只有非空正文/思考和真实工具调用/结果
  会更新模型进展；标题、状态、空 chunk、日志重试和 SSE 心跳不会续期。
  工具结果等待使用独立期限。超时停止自有进程/工具资源并删除临时目录。
- **Argon 慢响应**：裸 `gemini-4-argon` 默认选 medium（目录存在该等级时），显式
  high/low 仍有效；其他 family 仍优先 high。此默认值不能修复 agy/Google 上游阻塞。
  流式响应附着回合后立即发送已有的 Anthropic `message_start`，等待输出时每 15s 发
  `ping`（`AGY_BRIDGE_PING_INTERVAL_MS` 可调），不是 Responses API 的 `response.created`。
  模型目录、启动/resume、初始模型配置和工具目录确认发生在流建立前，仍受各自超时约束；
  acquisition 期间取消会在取得进程后检查并清理，禁止随后提交 Prompt。非流式请求仍需等待结果。
  无实质进展超时返回 `upstream_idle_timeout`（流内 error；非流式 HTTP 504），包含模型、
  实际选择的 effort 和超时配置建议。已提交的请求标记 `retryable: false`，相同重试返回
  409 `prompt_outcome_unknown`；进程内有界去重保留默认至多 6 小时，不跨重启。
  心跳不能绕过客户端总时限。详细行为及清理边界见英文说明。
- **用量**：ACP 一轮只给一次累计值、agy 不推 `usage_update`；插件从 agy 本地会话库
  （`~/.gemini/antigravity-cli/conversations/<sessionId>.db`）优先读 `gen_metadata`，
  生成结束即能读取，工具等待期间也可得到真实用量。旧版或未使用该表的会话使用完成的
  `steps` 记录，同一回合固定一个来源。每个响应报自己覆盖的调用（含缓存读），同一模型生成拆出的后续并行工具子步报 `0` 增量用量并保留游标，最终与
  ACP 累计输入核对。运行时无 `node:sqlite` / `bun:sqlite` 或读不到完整记录时回落估算；
  `AGY_BRIDGE_STEP_USAGE=0` 可完全关闭会话库读取。
- **长输出续写**：撞 `max_tokens` 时在同一会话、同一响应里自动续写，最多 3 次
  （`AGY_BRIDGE_MAX_CONTINUATIONS`，`0` 关闭）；agy 自己插入的"输出被截断"提示不会出现在正文里。

历史重放中的工具调用和结果使用 `<tool_record>` 标签，并在每条记录附近提示模型
只参考内容、不要把记录复制到回答中。文本和属性经过 XML 转义；在下述输入预算内，
默认保留完整参数、结果正文、工具引用和原位置的图片。若模型仍复述历史结果，可在桥接进程
环境中设置 `AGY_BRIDGE_STRIP_TOOL_RECORDS=1`：重放时省略历史结果正文（包括其中的
图片和工具引用），保留调用参数、ID、错误状态及周围对话。这会降低历史信息召回能力。
当前轮结果和实时 MCP 传递仍保持完整；该选项不会删除活跃或恢复会话中已有的记录。
标签是给模型的提示，不能保证模型绝不引用历史内容。

每次提交的文本与会话系统指令合计默认限制为 **1 MiB UTF-8 字节**，图片的 base64
数据单独传递。可通过正数环境变量
`AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES` 调整。另对每次 ACP 用户输入设置 **180,000 UTF-8
文本字节**的独立上限，每张图片额外预留 1,024 字节用于 AGY 的标签和 URI。实测 AGY
1.5.4 会在 192,000 字节处截断渲染后的用户输入，连历史重放末尾的当前指令也会丢失；
这里为包装标签、时间戳留出余量。调高总预算不能提高此上游限制。通过 ACP metadata
安装的系统指令计入总预算，不计入用户输入上限。

限制作用于新增输入，正常续接或 resume 可以继续使用更长的已有会话。工具结果齐全时，
普通插话和显式打断都能保留原会话，包括超过 MCP 等待时限的 deferred 工具结果；
AGY 正在重复等待或已经停止等待的两种情况均可继续。历史或会话指令变化仍需重放。
超出任一输入限制的历史重放会先使用紧凑工具记录：保留完整转义参数、ID 和错误状态，
以自闭合标签标记省略的结果正文，并用历史级提示替代每条记录的重复说明。仍然超限时，
会从最旧的完整交互开始省略，保留开头上下文、压缩摘要、最新交互和完整当前轮；
工具调用与对应结果不会被拆开。重放中会明确说明历史不完整，以减少旧信息召回换取恢复，
客户端的摘要请求也适用。客户端原始消息不变，后续轮次可复用恢复后的会话。
如果这些必须保留的内容本身仍超限，会在提交或替换原会话前返回 HTTP 400
`context_length_exceeded`。只有最后八条消息中包含 Claude Code 压缩摘要时，错误才改用
`prompt_budget_exceeded`，且不含“prompt is too long”字样，避免刚压缩后立即循环；
此时需缩短摘要或当前输入。更早的摘要不会阻止后续再次压缩。
客户端是否自动执行压缩取决于其错误处理。客户端负责保留完整历史并决定如何摘要。
`AGY_BRIDGE_EVENTS=0` 可关闭包含会话 ID、恢复原因和文本大小的限频诊断日志。

完整环境变量表、限制条件和开发/测试说明见
[README.en.md](README.en.md#environment-variables)。

## License

MIT
