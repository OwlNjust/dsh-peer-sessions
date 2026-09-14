# dsh-peer-sessions 设计说明（v1 · 冻结）

> 状态：**需求已冻结，M1 已实现**（见 §13），待真机验收。
> 本文件是唯一权威需求来源。代码与它不一致时，以本文件为准——或者先改本文件。
> §12 记录了实现期实测到的运行时事实，其中两条修正了设计初稿（列表服务名、授权载体）。

---

## 1. 一句话

让**同一层级的两个会话**（都由同一个人直接指挥、互不隶属）在**用户明确授权**的前提下互相通信、查看进度。

**不存在父会话，不存在子代理。**

## 2. 与 subagent 的分界

- **subagent**：派出去的临时分身，为当前这条线服务，没有自己的目标。
- **peer**：用户自己开的两个长期会话，各自有目标和工作目录，同时被指挥。

判据：**一方结束/失败是否意味着另一方也该停。** 是 → subagent；否 → peer。

现有的 `send_message` / `list_agents` 建立在 `isOwnedBy(parent, child)` 的所有权校验上，而 peer 的前提恰恰是**没有所有权**——因此不能复用，必须另做。

## 3. 使用场景（定稿）

**跨目录代码协作。** 两个不同工作目录的长期会话（例：`/mnt/d/CodeWorks` ↔ `/mnt/d/CodeWorks/GarmentCodaData`），契约变更时互相通知、回复闭环。

## 4. 用法示例（定稿）

1. 在 B「CodeWorks」里说：「和后端数据那个会话建立个通道，契约有变它通知我，我改完回它一声」
2. 目标解析命中唯一 → 模型调 `peer_send` → 弹出授权卡片 → 用户选「本对话内允许」
3. 双方日志各留一条痕迹
4. A 改完契约，模型调 `peer_send(kind:'notice')` → 进 B 的 inbox；B 正忙则**排队不打断**，空闲后自动醒来
5. B 看到带来源标注的消息 → 自己读文件核细节（读不受限）→ `peer_send(kind:'reply')`
6. `/peers` 可见通道；`/peer revoke` 断开

---

## 5. 硬不变量

### H1 · 侧栏一致（最高优先级）

**agent 眼里的对话列表 ⊆ 人在侧栏能看到的列表。一个 agent 绝不能对着一个人类看不见的对话说话。**

权威定义（`dsh-client-ui-workspace/lib/client.js` 的 `sessionVisible`）：

```
visible(session) = origin !== 'subagent'
                && !archived.has(session.id)
                && (!blank || session.id === current)
```

落地算法（宿主侧，**唯一的**列表来源）：

```js
const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
const summaries = (await ctx.sessionController.list({}, signal)).items   // 与侧栏同源
const addressable = summaries.filter(s =>
      s.origin !== 'subagent'
   && !archived.has(s.sessionId)
   && !s.blank)
```

这是侧栏规则的**真子集**（额外排除了 `blank` 占位行——它是"新建会话"行，且 `current` 是客户端状态，宿主侧拿不到）。**排除得更多 ⟹ 规则成立。**

推论：

- **H1.1 双向校验** —— 发送方与接收方**都**必须在集合内。一个已被归档的会话，人也看不见它，它同样不该能对外说话。
- **H1.2 每次投递都重新读取**，不在配对时缓存一次就完事 → 归档即时生效，无需任何监听器（天然 fail-safe）。
- **H1.3** 不得使用 `sessionQuery.listSessions()` 这类**全量语料**作为来源。
- **H1.4** 目标不在集合内 → 直接拒绝，并说明具体原因（已归档 / 空白占位 / 子代理 / 无工作目录）。
- 无 cwd 的会话本就不在侧栏（`list()` 里被跳过），自动不可寻址。

### H2 · 来源不可伪造

peer 消息进入接收方时**必须**带：`kind: 'peer-message'`、`form: 'relay'`、`senderSessionId`，并明示"这不是用户指令"。

**绝不使用 `ctx.sessionController.prompt()`** —— 它把消息构造成 `source = { kind: 'user', rpcId }`，会让对端模型的话以"用户指令"身份进入本会话，构成可劫持该会话的注入通道。

投递只走 `agent.followup()` / `agent.inject()`。

### H3 · 授权不经过模型

授权决策由**插件直接**调用 `ctx.userQuestions.ask()` 取得，用户答案直接回到插件手里。模型无法转述、无法篡改档位。

前提约束（契约原文）：`ask(agent)` 只在 `agent` 是**确切的活着的运行时根**时有效——被拥有的子代理没有人类回答者，会永久阻塞。因此：**发起方不是运行时根时一律 fail-closed，不弹任何问题。**

### H4 · 无隐式升级

peer 消息**不能**：批准任何东西、修改任何权限、发起新的 peer 配对（防扩散）、替对方做任何有副作用的操作。

---

## 6. 授权模型

| 档位 | 语义 | 载体 |
|---|---|---|
| `once` | 仅本次投递有效，用完即焚 | 插件进程内的 Map |
| `session` | 仅本对话内长期有效，进程重启即失效 | 插件进程内的 Map，按 sessionId 索引 |

**为什么用进程内的 Map 而不是会话事件**（实现时的修正）：插件是**进程级**的，而"一个对话"由 sessionId 标识——所以按 sessionId 索引的内存 Map 正好具有所需的生命周期：对话转冷再被唤醒时授权仍在，进程重启时授权消失。这正是文档要求的语义，不多不少。

原先设想的"写一条自定义 log-only 会话事件"被否决，理由是 `dsh-session` 导出了 `KNOWN_SESSION_EVENT_TYPES`：为一个内存 Map 已经提供的能力去触碰会话事件词汇表，是拿契约风险换零收益。

其余规则不变：

- **不跨对话、不跨重启。** fork / 子会话**不继承**（子代理根本不是运行时根，工具直接 fail-closed）。
- **单点批准覆盖双向收发**；批准即建立双向通道。
- 撤销即时生效；`once` 档在通道花完后自动作废。

## 7. 冷会话

- **可寻址**：侧栏里 `running: false` 的会话同样出现在列表中、可作为目标。
- **投递时当场确认一次唤醒**：弹「「X」当前未运行，要唤醒它并投递这条消息吗？[唤醒并投递] [取消]」。
- 批准后 `ctx.sessionController.resolveAgent(id)` → `{ agent } | { error }`；拿到 agent 再 `followup()`。
- 唤醒是有副作用的动作（启动 agent、消耗 token），**绝不在未确认的情况下发生**。

---

## 8. 功能需求

### A 配对

- **A1** 目标解析：按标题模糊匹配。命中 1 → 直接用；命中 0 或多 → 列出候选（标题 + cwd + 最近活跃 + running），**绝不猜测**。
- **A2** 授权卡片明示：双方会话、方向（双向）、档位、"不含读取对话记录"。
- **A3** 两档授权（见 §6）。
- **A4** 双写留痕 + 失败回滚。
- **A5** 撤销即时生效 + 双方留痕。
- **A6** 可列出全部通道：对端、档位、剩余额度、对端可见性状态。

### B 通信

- **B1** 类型：`notice` / `request`(带 `replyWithin`) / `reply`(带 `replyTo`) / `message`。
- **B2** 投递只走 `followup()`，**绝不用 `steer()`** → 天然实现"空闲才投递"。
  （`AgentStatus = 'idle' | 'running'`；对端 running 时 `followup` 排队，其当前回合结束自动执行。）
- **B3** `silent: true` → `inject()`，只留上下文不唤醒。
- **B4** 来源标注（见 H2）。
- **B5** `request` 带超时；超时通知发起方，**不无限重试**。
- **B6** 收件箱：未读 / 待回复 / 已超时。
- **B7** 消息体只允许**文本 + 路径引用**；不携带文件内容或附件（读不受限，接收方自己读）。

### C 进度

- **C1** 只返回：标题、状态、轮次/步骤、目标、待办、最近 N 条摘要、最近活动时间。
- **C2** **绝不返回**：对话原文、工具参数、附件、文件内容。
- **C3** 对端不可见时明确失败，不静默降级。

### D 环路与审计

- **D1** 跳数上限、每对消息上限、速率上限。
- **D2** 每次投递在双方日志各留一条可回放记录。

---

## 9. 接口面

### 用户命令（`ctx.commands` 全局注册）

| 命令 | 作用 |
|---|---|
| `/peers` | 列出通道：对端、档位、剩余额度、对端可见性 |
| `/peer connect <标题> [once\|session]` | 建通道；省略档位则弹原生选项卡片 |
| `/peer revoke <标题>` | 撤销 |
| `/peer progress <标题>` | 查看对端进度 |

命令的三个性质由契约保证，白拿：`CommandSourceMap` 只有 `user`（*"every executor caller is a human-facing UI surface dispatching a human-typed line"*）；handler **不经过模型**执行；每次调用自动写 `command/run` / `command/done` → **免费审计**。

### 模型工具（`ctx.tools` 全局注册）

| 工具 | 作用 |
|---|---|
| `peer_send` | 发消息；无授权时弹授权卡片 |
| `peer_inbox` | 读收件箱 |
| `peer_progress` | 读对端投影 + 摘要 |
| `peer_list` | 查通道与权限 |

无授权时返回"未授权"而非报错，且**零副作用**。

### 零客户端代码

- 命令结果 → 现有 UI 直接渲染 `CommandResult.text`
- 授权卡片 → `dsh-client-ui-user-questions` 渲染原生选项
- 消息来源标注 → 现有消息渲染处理 `form: 'relay'`

因此 **没有 `lib/client.js`，`package.json` 不声明 `dsh.client`。**

---

## 10. 明确不做

跨会话读文件 · 跨重启持久配对 · 三方以上群组 · schedule / 看门狗 · 共享约定注入 · 自研浏览器面板 · 群发

## 11. 实现映射（每条需求落在哪个现有原语上）

| 需求 | 用什么 |
|---|---|
| 侧栏一致的列表 | `ctx.workspaceRegistry.archivedSessionIds` + `ctx.sessionController.list({}, signal)` |
| 会话标题 | `ctx.sessionTitle.get(session)`（活会话）/ `summary.projections.values.title`（列表缓存）/ 退回 cwd basename |
| 目标唤醒 | `ctx.sessionController.resolveAgent()` → `{ agent } \| { error }` |
| 投递 | `agent.followup()` / `agent.inject()` —— **从不用 `steer()`** |
| 进度 | `sessionController.list()` 带的 projection 值，只读叶子字段 |
| 授权 | `ctx.userQuestions.ask()`（插件直接问人，模型不经手） |
| 用户命令 | `ctx.commands.register()` |
| 模型工具 | `ctx.tools.register()` + `defineTool()` |
| 会话内授权 | 插件进程内的 Map，按 sessionId 索引 |
| 消息来源 | `createUserMessage({ source: { kind: 'peer-message', form: 'relay', senderSessionId } })` |
| 审计（发送方） | `exec.deferContext()` 追加一条 plugin-sourced `notice` |
| 审计（接收方） | 收到的 relay 消息本身就是记录 |
| 运行时根判定 | `ctx.agents.get(agent.id) === agent && ctx.agents.roots()` |

**本项目不发明新机制**：所有能力都落在已有服务与原语上。

## 12. 实现期已验证的运行时事实

以下都是实测结论，不是推断；它们取代了设计初稿里的"待验证"清单。

1. **自定义消息来源可用，但运行时不做校验。**
   `createUserMessage` 接受 `source = { kind: 'peer-message', form: 'relay', senderSessionId }`——`MessageSourceMap` 是可合并扩展的，没有运行时白名单。
   ⚠️ 但它**同样接受缺少 `senderSessionId` 的来源**。也就是说 H2 无法靠运行时保证，只能靠代码强制：`lib/messages.js` 在缺少发送方时直接抛错，绝不降级。

2. **命令注册与工具注册的形状。**
   `ctx.commands.register()` 每个调用自动写 `command/run` / `command/done`（审计白拿），handler 不经过模型。
   `ctx.tools.register()` **不做标记校验**，只检查 `output.{schema,render}` 与保留名 `run_code`。

3. **`link:` 安装不会安装依赖，裸导入会解析失败。**
   Node 按导入文件的 **realpath** 解析裸说明符；`link:` 安装把本包留在 profile 树之外，因此 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` 解析不到。
   解法（`install.sh` 第 1 步）：把本包的 `node_modules` 软链到 `${DSH_HOME}/profiles/node_modules`。这既恢复了分辨率，又让它指向**与宿主同一份 realpath**——实测两侧 realpath 完全一致，因此是同一模块实例，不存在第二份副本或身份分裂。

4. **`AgentStatus` 只有 `'idle' | 'running'`，"空闲才投递"不是新机制。**
   `followup()` 排一个独立回合并唤醒驱动；对端 running 时它排队、当前回合结束自动执行。所以 B2 的实现就是**永远用 `followup`、永远不用 `steer`**，零新机制。

5. **`sessionController.list({}, signal)` 返回 `{ items }`**，是两参数签名；`resolveAgent()` 以 `{ agent } | { error }` 返回，不抛异常。

### 仍未在生产中验证的部分

- 在一个**真实的双会话场景**里跑完整链路（M1 验收）——单元测试用假上下文覆盖了全部不变量，但真实进程里的 `followup` 唤醒时序、以及重名消歧的实际体验，只有跑一次才算数。
- 补丁行加载后，全局注册的 4 个工具与 2 条命令在**其他会话**中的实际可见范围。

## 13. 里程碑与进度

### M1 · 已完成（待真机验收）

侧栏一致列表（H1）· 2 条命令 + 4 个工具 · 插件直接取授权 · `followup` 投递（空闲才投递）· 冷会话唤醒（当场确认）· 双向审计 · 25 项单元测试。

因为会话内授权改成了进程内 Map（§6），原本排在 M2 的"仅本对话授权"与"冷会话唤醒"也随之落进 M1。

### M2 · 待做

- `peer_progress` 深化：轮次/步骤、更完整的待办渲染
- 环路防护完整版：每对速率上限、跳数上限、请求超时后的主动通知
- `peer_inbox` 的已读 / 超时状态推进

### M3 · 待做

- 双语文档完善、GitHub 发布

### M1 验收（真机）

两个真实会话 → `/peer connect <标题> session`（重名时列候选）→ `/peers` 可见通道 → A 调 `peer_send`（B 忙 → 排队不打断）→ B 空闲后自动醒来看到带来源标注的消息 → B 用 `peer_send(kind:'reply')` 回信 → A 醒来 → `/peer revoke` → 再发被拒 → **归档对端后立刻被拒**。
