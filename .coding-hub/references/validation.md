# Antigravity Bridge 验收

此项目是 JavaScript ESM 的 OpenCode / Magpie 插件，生产入口为 `index.mjs`。
发布文件由 `package.json` 的 `files` 列表决定；新增运行时模块要核对是否被打包。
目前没有独立的 lint、typecheck 或 build 脚本，不虚构这些检查。

## 检查顺序

1. 读 `package.json`、相关测试和 `.github/workflows/usage.yml`，以当前脚本为准。
2. 对行为变化先用最小复现或相关回归测试确认缺陷，再验证修复。
3. 代码改动交付前运行 `npm test`，它依次包含 Node 测试、array-items 单元测试和 smoke 测试。
   聚焦测试通过不能代替 smoke 阶段通过；若失败，保留具体失败项与日志。
4. 输入没有改变且没有新增风险时复用已通过的检查，不反复运行完整测试。
5. 只修改技能、文档或符号链接时，检查 frontmatter、引用、相对链接、diff 和格式；无需重跑业务测试。

常用聚焦命令（只选择与改动有关的组合）：

| 范围 | 检查 |
| --- | --- |
| ACP 握手、权限、恢复 | `node --test test-acp-compat.mjs test-auth-retry.mjs test-compat.mjs` |
| 通知过滤与上游错误 | `node --test test-agent-notice.mjs test-upstream-error.mjs test-turn-timeout.mjs` |
| 提示词与工具 schema | `node --test test-prompt-guard.mjs test-tool-schema.mjs test-schema-parity.mjs test-mcp-server.mjs` |
| 账号、平台、WSL | `node --test test-native-accounts.mjs test-accounts-import.mjs test-accounts-login.mjs test-platform.mjs test-wsl.mjs` |
| 用量、模型目录、上下文设置 | `node --test test-usage.mjs test-step-usage.mjs test-step-usage-extra.mjs test-model-discovery.mjs test-context-ui.mjs test-context-unlock.mjs` |
| 完整本地检查 | `npm test` |

CI 当前使用 Linux、macOS、Windows 的 Node 24，以及 Windows Node 22；同时在含空格的 checkout
路径运行 ACP / auth-retry / compat 测试。改跨平台行为时使用可移植路径、启动和清理方式。
本机通过不代表其它平台已验证；等待真实 CI 或报告未验证范围。

## 测试边界

- 优先 fake-ACP 和临时测试凭据；不读取、打印或修改真实账号 token 来让测试通过。
- `npm run test:integration` 使用真实 agy / 上游能力，运行前读脚本要求。
  需要已登录环境且可能消耗额度；只有任务范围与现有授权覆盖时才运行，不能把 fake-ACP 结果当成真实联调。
- 环境导致的失败先验证原因。对生产逻辑和 fixture 的修改分别说明；不声称未复现的失败是基线问题。
- 保护提示词当前指令、工具结果归属、账号隔离、会话恢复、错误分类和字节预算等已有约束。
  修复溢出问题不能仅放宽上游限额或静默截断关键内容。

## 交付证据

记录测试命令、退出结果、失败项及对应 diff / revision；区分已验证与推断。
开 PR 前执行 `git diff --check`，核对版本与 changelog，并按仓库约定完成一次版本更新。
Review 按风险选择；审查者需要真实 diff 和完成标准，不接受只有“已完成”的状态。
