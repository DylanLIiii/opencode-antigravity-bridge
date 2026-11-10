# 2026-11-10 多账号（multi-account）支持

## 背景与调研结论

用户问"能不能多账号切换"。调研 agy 1.5.3（本机二进制 + 实测）结论：

- ACP `authenticate` 不是账号切换：`initialize` 的 `authMethods`（oauth-personal /
  oauth-business / gemini-api-key）是登录方式选择，会重走 OAuth 并改全局登录态；
  1.4.12 实测 `oauth-personal` 还会报 `User location is not supported`。桥接不调用它是正确的。
- `AGY_ACCOUNT=<name>` 环境变量存在（二进制内有 signed-in accounts 注册表 +
  `list_plugin_accounts` 工具），但实测 `AGY_ACCOUNT=bogus` 下 ACP `session/prompt`
  照常完成——它只影响 plugin 启动的 sandboxed CLI 子命令，不影响主 ACP 会话。
- 真正可用的是 **`--gemini_dir=<dir>`**：实测带 token 的目录正常工作，空目录报
  "Please sign in" 且不回退全局登录态。每个账号一个完整 Gemini 目录
  （`antigravity-cli/antigravity-oauth-token` 文件 token），桥接按进程传
  `--gemini_dir` 即可隔离账号。限制：keyring/ADC 登录态是机器全局的，无法按目录
  隔离，因此命名账号要求目录内存在文件 token（本机与无 keyring 的 Linux 天然满足）。

## 方案

- 账号目录约定：`~/.config/magpie-agy-bridge/accounts/<name>/`（每个子目录是一个完整
  Gemini 目录，含 `antigravity-cli/antigravity-oauth-token`）；可用
  `AGY_BRIDGE_ACCOUNTS_DIR` 覆盖。默认账号（全局登录态，不传 `--gemini_dir`）始终保留，
  行为向后兼容。
- 模型路由：每个命名账号在模型目录里重复列出全部模型，ID 为 `<name>/<model-id>`，
  名称加 `[name]` 前缀——用户在 Magpie 模型选择器里切换即切换账号。
- 请求解析：`provider/account/model`、`account/model`、`provider/model`、`model`
  都能解析出账号；conversation key 加 `account:<name>::` 前缀，会话池/快照/去重天然按账号隔离。
- 进程：`Proc` 携带 `geminiDir`，启动参数加 `--gemini_dir=<dir>`；老版本 agy 不支持
  该 flag 时，扫描阶段探测（`--gemini_dir=X --version`）并跳过该账号。
- 用量：`sessionDbPath` 按账号目录读取 conversations；`auth.usage` 聚合所有账号的
  quota 窗口，名称加 `[name]` 前缀。
- 额度探测 `fetchUsage` 支持传入已有 gemini_dir（账号目录直用，不建临时目录、不删除）。

## 改动文件

- `accounts.mjs`（新）：账号扫描、模型 ID 拆分。
- `usage.mjs`：`fetchUsage` 支持 `geminiDir` 选项；`createUsageReader` 支持多账号聚合。
- `index.mjs`：catalog 按账号缓存、`provider.models` 多账号输出、请求解析账号前缀、
  `Proc` 传 `--gemini_dir`、per-account 会话库、usage hook 聚合。
- `test-smoke.mjs`：多账号场景（模型前缀、进程参数、会话隔离、usage 聚合）。
- `package.json` 0.3.0、`CHANGELOG.md`、`README.md` / `README.en.md`。
