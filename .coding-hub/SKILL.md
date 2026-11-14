---
name: coding-hub
description: 为 opencode-antigravity-bridge 调度编码、排障和审查任务。统一使用 OpenCode 与 Magpie 路由，按角色和难度选择宿主原生委派、T3 Code 或 herdr-core，明确工作区、并发、测试和交付要求。用于本项目派工与多任务协调；小任务直接完成。
---

# Antigravity Bridge Coding Hub

适用于当前 `opencode-antigravity-bridge` checkout 及其独立配置的 worktree。
本目录的 `SKILL.md` 是项目派工规则的唯一来源；`.claude/skills/coding-hub`
和 `.agents/skills/coding-hub` 链接整个目录。入口名称不改变执行 Agent：本项目统一使用 OpenCode。
再次配置时定向修改本文件及 references，先备份既有文件到项目外，保留用户定制。

规则基于 `config-coding-hub` 的 Pi 通用模板定制；用户已明确选择项目级配置与 OpenCode。
不读取旧全局 Coding Hub 作为运行规则，不安装 Agent，不修改全局 Provider、默认模型或服务权限。
用户本次要求及宿主实际工具、授权和权限限制优先于本文件。普通编码请求不重新执行配置流程。

## 1. 执行选择

区分三个概念：执行 Agent 是 **OpenCode**；通道是宿主原生委派、T3 Code 或 herdr-core；
模型 Provider 是 **Magpie**。不存在自动切换到其它 Agent 的后备路径。

- 边界清楚的小任务在当前会话完成，无需为了遵循角色表而另启会话或切换当前模型。
- 用户点名模型、通道、目标机器或并发数时遵循本次要求；启动前核对目标实例能力。
- T3 内的委派遵循宿主规则：同 Provider、已提供模型且无需额外设置时可用原生工具；
  其它模型、独立 checkout、后台任务或用户指定设置使用 `delegate_task`。
- T3 的首次委派前调用一次 `orchestrator_capabilities`，以后仅按宿主要求在错误或 Provider 变化后重查。
  保留实例是否启用、模型是否存在、子任务权限及 runtime modes 的检查结果。
- T3 之外需要交互终端接管时使用 herdr-core；在 T3 中不借 CLI 绕过委派限制。
- 当前实例 ID 为 `opencode`，使用下表列出的完整模型 ID。跨机器重新核对，不能推测目录前缀。
- 使用路由组时不指定组内具体模型或固定 effort / thinking；用户明确选择固定模型时核对目录及参数。
  不把父会话的固定模型设置无条件复制给路由组。

通道步骤见 [执行通道](references/channels.md)，角色简报见 [委派契约](references/delegation.md)。

## 2. 难度和角色

| 难度 | 本项目 OpenCode 模型 | 适用范围 |
| --- | --- | --- |
| Breeze | 当前无独立路由 | 机械查找、单条命令和 typo 直接完成；确需委派时明确升至 Flow |
| Flow | `magpie/group/flow` | 边界清楚的小修、文档、局部只读探索 |
| Craft | `magpie/group/craft` | 常规实现、多文件修复、回归测试；Worker 默认 |
| Sage | `magpie/group/sage` | ACP 生命周期、并发、恢复、认证或跨模块疑难问题 |
| Apex | `magpie/group/apex` | Sage 已有明确阻塞，或跨系统高风险决策；简报写明理由 |

| 角色 | 职责 | 默认档位 / 限制 |
| --- | --- | --- |
| Orchestrator | 拆任务、管理依赖、集成、验证和沟通 | Sage；必要时 Apex；小任务由当前会话直接处理 |
| Worker | 唯一实现角色；修改指定代码并验证 | Craft；按任务调整 |
| Explore | 只读定位文件、符号和调用链 | Flow；复杂调查可升级 |
| Librarian | 查官方文档、外部 API 和兼容性依据 | Craft；返回来源与局限 |
| Reviewer | 独立对照 diff、完成标准和测试证据 | Craft / Sage；只读，不修实现、不合并 |
| Oracle | 分析疑难问题和架构取舍 | Apex；只读，不代替 Worker 实现 |

未指定角色的实现任务使用 Worker。按风险选择独立 Reviewer，不要求每次小改都额外委派。
大型开放式研究没有单独的默认执行后端；需要时先明确研究范围与证据要求，仍使用 OpenCode。

## 3. 并发与工作区

- 默认最多 **2 个同时运行的子任务**，单个子任务只有 **1 个执行会话**。用户明确调整时以新要求为准。
- 子任务最多一层。子 Agent 自己完成分配的工作，不再 spawn、委派、开线程或启动另一个 Agent 进程。
- 并行写入各用独立 worktree 和分支；同一分支同一时间只有一个写手。
  只读任务可共享 checkout，但不得把运行测试产生的写入当作无副作用。
- T3 子任务用 `isolation: "worktree"`；不要先在 shell 创建子任务 checkout，也不在任务正文要求子 Agent 创建。
  主 checkout 中已有未提交改动时，先确定依赖关系；新 worktree 不自动包含这些改动。
- 独立新工作以最新默认分支 `origin/main` 为基线；依赖未发布提交时使用其本地基线。
  用户指定 base 时优先使用指定值。核对工具实际支持的 base 选项，不伪造参数。
- worktree 内的入口只能相对链接本 worktree 的 `.coding-hub`，不回指主 checkout。
  不自动修改其它 worktree，不覆盖当前 Issue 修复或用户的未提交修改。

## 4. 生命周期与失败处理

- 默认使用 **Task**。多阶段工作由父会话维护依赖并按顺序启动 Task；不把普通 OpenCode 会话称为已运行 Workflow / Goal 扩展。
- 简报写清范围、完成标准、必要检查和预算。没有必要时不生成独立报告文件。
- 用完成事件或宿主支持的等待方式收结果，不 sleep、轮询或重复启动同一个任务。
  T3 委派后遵循返回的 `next`；替换或不再需要的运行用 `task_cancel` 停止。
- 等待输入、审批或超时不意味着任务失败，不自动换 Agent、换模型或增加写手。
  已有授权足以解决的问题直接处理；真正缺失的信息说明具体缺口，同时继续独立工作。
- Provider / 模型不存在或被禁用时说明差异；不要安装、启用、降档或静默改为另一个目标。
  Breeze 到 Flow 的明确映射仅适用于本文件的默认轻任务，不覆盖用户点名的模型。
- 三种实质不同的修复方案仍失败时保留证据、停止盲目修改，向父会话说明阻塞并提出下一项可验证假设。
- `done` 只表示一轮结束。父会话核对实际 diff、产物和检查结果后才验收；检查输入未变化时复用已通过的证据。

## 5. Git、权限与发布

- 先读适用的 `AGENTS.md` / `CLAUDE.md`、当前分支状态与 diff。只修改任务范围，不整仓 reset，不覆盖他人工作。
- T3 委派在父权限允许时显式采用 `runtimeMode: "full-access"`，权限始终不得宽于父会话。
  本配置不授权提高父会话权限、绕过审批或改变宿主安全设置。
- 用户已有的明确授权持续有效。受保护分支推送、合并 PR、force-push、已发布历史改写、部署、
  发布、删除数据、账户和权限修改均以本次实际授权为准，不能从配置文件或子任务报告推导授权。
- 一个 PR 包含一次版本更新：与最新 `main` 比较，修复 / 维护用 patch，功能 / 破坏性改动按相应级别。
  `package.json` 是版本唯一来源，同时更新 `CHANGELOG.md`；不引入第二个硬编码版本。
- 栈式 PR 通过 merge commit 解决冲突，不 rebase 已发布的栈，不把整个栈合进最终 base。
- PR 标题和说明围绕最终问题、行为变化及验证结果编写。T3 中创建、接管或推送 PR 后，下一调用关联完整 PR URL。
  PR 监视、等待和交回遵循宿主当前规则；子 Agent 不监视 PR。
- 凭据不进入 Skill、代码、提示词和日志。真正需要用户提供密钥时使用宿主 secret 工具。

## 6. 验收与交付

先运行与改动直接相关的现有测试；涉及行为变化时增加能暴露缺陷的回归用例。
修改 Markdown 或链接时验证内容与链接即可，不为低风险配置编写镜像测试。
完整测试、CI 范围与真实上游集成限制见 [项目验收](references/validation.md)。

交付说明问题如何改变、改了哪些文件、实际运行的检查及剩余问题。报告失败时区分本次回归、
复现于同一基线的问题和未确认原因，不凭猜测把失败称为“已有问题”。
只有真正运行过连接或任务，才声明委派验证成功；能力发现、模型目录和文件链接检查不等于端到端验证。

长期项目管理只有用户要求时才启用 `project-manager`，按名称发现其目标机可读路径。
持久记录放在 `${XDG_DATA_HOME:-~/.local/share}/coding-hub/projects/opencode-antigravity-bridge/`；
恢复先读已有状态和任务归属，不重复启动。仓库中不添加临时 PM 台账。

本项目技能通过版本控制维护，不执行全局 `envdev apply skills` 来发布项目配置。
