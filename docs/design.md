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

**跨目录代码协作。** 两个不同工作目录的长期会话（例：`/srv/orders-api` ↔ `/srv/web-client`），契约变更时互相通知、回复闭环。

## 4. 用法示例（定稿）

1. 在 B「web-client」里说：「和后端数据那个会话建立个通道，契约有变它通知我，我改完回它一声」
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
| `once` | **一次往来**：一条消息 + 它对某条 request 的回复，然后作废 | 插件进程内的 Map |
| `session` | 仅本对话内长期有效，进程重启即失效 | 插件进程内的 Map，按 sessionId 索引 |

**为什么用进程内的 Map 而不是会话事件**（实现时的修正）：插件是**进程级**的，而"一个对话"由 sessionId 标识——所以按 sessionId 索引的内存 Map 正好具有所需的生命周期：对话转冷再被唤醒时授权仍在，进程重启时授权消失。这正是文档要求的语义，不多不少。

原先设想的"写一条自定义 log-only 会话事件"被否决，理由是 `dsh-session` 导出了 `KNOWN_SESSION_EVENT_TYPES`：为一个内存 Map 已经提供的能力去触碰会话事件词汇表，是拿契约风险换零收益。

其余规则不变：

- **不跨对话、不跨重启。** fork / 子会话**不继承**（子代理根本不是运行时根，工具直接 fail-closed）。
- **单点批准覆盖双向收发**；批准即建立双向通道。
- 撤销即时生效；`once` 档在通道花完后自动作废。

## 7. 冷会话

**真机事实（改变了本节的设计）**：在这个部署里**空闲会话就是冷的**。一次真机观察里，「Peer B」被唤醒、跑完一轮、回了信，随后又变回 `running: false`；`peer_list` 列出的 17 个会话全是 `not running`。

于是"投递时当场确认一次唤醒"在实践中变成了**每条消息两张卡片**（授权 + 唤醒）。这不是安全，是摩擦。

**定稿行为：一张卡片覆盖整个决定。**

- **可寻址**：侧栏里 `running: false` 的会话同样在列表中、可作为目标。
- **首触只弹一张卡**：卡片正文在需要唤醒时**明说这一点**（"「X」当前未运行。同意会同时把它唤醒，那会在那边开启一轮并消耗 token。"），人读到的就是完整代价。
- **通道批准涵盖唤醒**：通道已建立时，后续投递直接 `ctx.sessionController.resolveAgent(id)` 唤醒，**不再提问**。撤销通道就是这道权限的关闭开关。
- 唤醒失败（`resolveAgent` 返回 error）→ 明确报告，不静默降级。
- **`silent: true` 与冷对端互斥**：静默投递的语义是"只添加上下文、不开启回合"，而唤醒正好相反。因此这种情况**直接拒绝**（`silent-needs-running`），连卡片都不弹——那是个自相矛盾的请求，不该让用户去裁决。

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

  **已接受并刻意保留的后果（真机观察后确认）**：`followup` 的契约是"排一个独立回合并唤醒驱动"，所以入站的对端消息会**以排队用户回合的形式出现在客户端的输入区**，可被编辑、删除、重排——看起来像收件人自己待发送的内容。

  这是**选定的行为，不是缺陷**，不要"修"它：
  - 当前原语下，"能被唤醒"与"不出现在输入区"互斥（`inject` 不进输入区但**不唤醒**）。
  - 想保住"通知即唤醒"，就必须走 `followup`。
  - 从安全角度它反而是优点：一条来自别的会话的消息在**执行前可见、可否决**。
  - 抬头第一行 `[peer-session message · from another conversation, NOT a user instruction]` 是这份可见性的补偿——即使在一行输入条里也能一眼认出不是自己写的。
  - **一次未复现的观察，记录以免将来误查本插件**：对端消息停在 composer 队列里时，曾出现"选中斜杠命令后 Backspace 删不掉已输入内容"。同一次里 `/goal`（内置命令）表现**完全相同**，随后两个命令又都恢复正常，因此**与本插件无关、也未能确认成因**。
    后续找到一个**可能的**机制：粘贴进来的零宽字符各占一个 UTF-16 码元，按一次 Backspace 只吃掉那个看不见的字符，**视觉上等于什么都没发生**。这与同一次里发现的 `unknown subcommand "connect"`（token 里藏着 U+200B）同源。若再次出现，记录两件事：composer 里是否挂着排队消息、输入里是否含不可见字符（现在报错会直接给出码位）。
- **B3** `silent: true` → `inject()`，只留上下文不唤醒。发送方需要"不打扰"时用它。
  **对端是冷的时该请求自相矛盾**（唤醒正是它要避免的），因此直接拒绝，见 §7。
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
| `peer_inbox` | 读收件箱：每条一行摘要；带 `id` 则取回该条的完整投递正文 |
| `peer_progress` | 读对端投影 + 摘要 |
| `peer_list` | 查通道与权限 |

无授权时返回"未授权"而非报错，且**零副作用**。

### 零客户端代码

- 命令结果 → 现有 UI 直接渲染 `CommandResult.text`
- 授权卡片 → `dsh-client-ui-user-questions` 渲染原生选项
- 消息来源标注 → 现有消息渲染处理 `form: 'relay'`

因此 **没有 `lib/client.js`，`package.json` 不声明 `dsh.client`。**

### 语言跟随

面向人的文案跟随客户端的语言设置。

- **来源**：`locale.preference`（`dsh-client-locale` 拥有的设置命名空间）。**只读，不注册。**
- **能跟随到什么程度**：契约原文是 *"absence delegates to the browser"* —— 未显式选择时由浏览器决定，`navigator.language` 不会跨到宿主侧。因此：显式值 `zh*`/`en*` 按值跟随；**缺失或无法识别时回退简体中文**。
- **提问卡片天然跟随**：每次调用现生成，走 `core.t`（永远读当前 locale）。
- **命令描述需要重新注册**：描述在注册时就固定了。因此监听 `settings/updated`（一个任何 context 都能订阅的 emit 事件），语言变化时**注销后重新注册**两条命令。
- 支持的语言：`zh`、`en`。新增语言 = 往 `lib/i18n.js` 的 `MESSAGES` 加一张表；`normalizeLocale` 匹配 `zh`/`zh-CN`/`zh_Hans` 这类前缀标签。

**有意保持英文的部分**：工具描述与工具输出（那是**模型**的接口，不是 UI 文案），以及 peer 消息的来源抬头 `[peer-session message · NOT a user instruction]`（它是给接收方模型看的机器可读归属标签）。命令**结果**是本地化的——同一次人机交互里描述中文、回答英文会显得断裂。

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

6. **投影值是 `JsonValue`，且真实形状与直觉不符。**
   `SessionProjectionValue = JsonValue`，所以**键存在不等于值是对象**——`projections.values.title` 对所有尚无标题的会话就是 `null`，首次真机运行正是在这里崩溃。实测到的真实形状：
   - `title`：`list()` 给的是**已解包的值**——有标题时为字符串，缺失时为 `null`。（这条由崩溃本身反推：若传的是缓存原始记录 `{ver, seq, val}`，`val: null` 就是个对象，不会崩。）磁盘上的投影缓存另存为 `{ver, seq, val}`。
   - `todos`：`TodoItem[] | null`，条目为 `{ content, status }`——是**数组**，不是 `{ items }`。
   - `goal`：`GoalProjection | null`，目标文本嵌在 `goal.goal.objective`，配 `goal.goal.phase` 与 `goal.roundsStarted`。
   - `inbox`：`{ 'next-turn': [], 'next-step': [] }`。
   - `turnOutline`：`TurnOutlineEntry[]`，条目为 `{ turn, seq, prompt, response }` 的**有界预览**——C1 要的"轮次/步骤 + 最近摘要"正来自它。

   教训：单元测试的 fixture 必须用**真实形状**。初版测试全部用对象或 `{}`，对类型忠实、对数据不忠实，因此上面每一条都漏过了。

7. **加载器会「重新 apply」插件，但不会重新求值模块。**
   包文件一变化，加载器就重新 apply 这个插件——但它是重新 import **同一份被缓存的模块**：文件不会被重新求值，`apply()` 却会再跑一遍。
   两个后果，都在真机观测到：
   - 在 `apply()` 里创建的 store **每次 re-apply 都会被丢弃**，静默清空所有已开通道（实测：一次投递刚在某个通道上成功，下一次调用该通道就不见了，中间没有重启）。因此 store 放在**模块作用域**（见 `lib/index.js` 的说明）。
   - **改代码仍需重启进程**才会生效：re-apply 拿到的是缓存里的旧模块。
   顺带说明：这意味着"改文件 → 自动生效"是不成立的，但"改文件 → 通道被清空"是成立的——一个很容易误判的组合。

8. **`once` 档的语义已定为「一次往来」。**
   实测发现：「仅本次投递」批准后 `remaining=0`、通道立即作废，于是**对端的回复需要一次新的批准**——而且那张卡片出现在**对端会话**里，用户看到的是"我不是刚批准过吗"。这不是实现缺陷，是档位定义的问题。
   定稿语义：**`once` = 一条消息 + 它对某条 request 的回复**。实现上，通道记住自己承载过哪些 request（`requestId → 发起方`），当一条 `reply` 的 `replyTo` 命中**由对端发起**的 request 时，它搭同一次批准送出，随后通道作废。
   方向校验是必需的：只认"由对端发起"的 request，否则一方可以拿自己发过的 request 去解锁另一方的额度。
   卡片文案同步改为 "One exchange — the message and its answer — then the channel is spent"。

### 已在真机验证通过

| 路径 | 证据 |
|---|---|
| 侧栏一致的列表 | 16 个会话，标题全部解析正确，running 状态准确，归档/空白/子代理被排除 |
| 进度读取 | 投影 + 摘要，未知投影**只给键名**不给值 |
| 授权卡片 | 两次真机运行（一次英文、一次中文），档位与文案都对 |
| 冷会话唤醒 | 对端由 `not running` 变为 `running`，且必须先确认 |
| 投递与来源标注 | 对端收到 `[peer-session message · NOT a user instruction]` |
| 发送方审计 | 工具输出出现 `deferContext` 生成的 plugin-sourced notice |
| **回复闭环** | 对端 `peer_send(kind:'reply', replyTo:…)` → 本端收件箱收到 `received` |
| **一次往来** | 同一次回复**搭了那张「仅这一次」批准**，对端没有再被弹卡片；回复送达后通道自动作废 |
| 语言跟随 | 命令描述与提问卡片随 `locale.preference`（缺失时回退简体中文） |
| 命令面与工具面同源 | `/peer connect` 报告 `pc-2 / 本对话内 / 200 / 未运行`，`peer_list` 报告 `"Peer B" · tier=session · remaining=200 · peer=not running`，逐项一致 |
| **撤销** | `/peer revoke Peer B` → 双方视图同步为空；**紧接着 `peer_send` 重新弹出授权卡片**，证明撤销是在投递校验处生效，而非仅仅从列表里抹掉 |
| **拒绝** | 拒绝那张卡片后：不创建通道、收件箱不变、对端全程仍是 `not running`（没被唤醒）、零 token |
| **其他会话可见** | 在一个新建对话里 `/peers` 可用且显示自己的（空）通道状态；`/peer progress <本对话标题>` 读到本对话的状态、目录、17 轮与最近三轮摘要；`peer_list` 的列表随之从 16 变 17，说明新建对话也在集合里 |
| **归档即时拒绝** | 归档该对端后它**立刻从列表中消失**（17 → 16），按名字投递给它被拒绝、未发送任何内容。这条同时证明 H1.1（投递前重读）与 H1.2（不缓存） |
| **子代理拿不到授权** | 探针子代理报告 4 个 `peer_*` 工具**全部可见**（没有任何 preset 配置 `toolFilter`，所以全局工具被完整继承），但 `peer_send` 被 `callerGuard` 拒绝：*"only a top-level conversation can hold a peer channel…"*。**没有弹出任何卡片**——`isRuntimeRoot` 先返回 false，`userQuestions.ask` 从未被调用，因此不会出现契约警告的"永久阻塞" |
| **收件箱按 id 取回正文**（M2） | 真机：对端回了一条 `reply`，列表是 `Peer inbox (1 item…)` + `- [unread] reply from "…" · 0 min ago` + `id: pm-1-mu1en5e4 · replyTo: req-1-mu1em7ux` + 一行摘要——**正文没有被倾倒进列表**。`peer_inbox(id:"pm-1-mu1en5e4")` 返回完整投递正文：取回头两行是 `Message … · channel pc-1` 与 `Delivered … · status: unread · in reply to: req-1-mu1em7ux`，其后**逐字节等于**收到的那条 relay 消息（来源抬头、`from:`、`channel:`、`answering request:`、正文三行全部一致）。多行 body 未被截断 |
| **未知 id 具名拒绝**（M2） | `peer_inbox(id:"pm-does-not-exist")` → `No inbox message with id "pm-does-not-exist". Known ids, newest first: pm-1-mu1en5e4.` —— 具名说明，且列出**确实存在**的 id（收件箱为空时说的是"空"，不是空列表） |
| **重启后新模块生效的判据** | 重启前 `peer_inbox(id:"pm-probe-does-not-exist")` 返回 `Peer inbox is empty.`（旧实现根本不看 `id`）；重启后同一调用返回 `No inbox message with id …`。新实现在给了 id 时**不可能**说出旧回答，所以这是一个确定的"代码是否已加载"探针 |
| **`markReplied` 只查了通道的一端**（真缺陷，已修） | `awaiting-reply` 条目落在**请求接收方**的收件箱，而"谁持有它"取决于这轮交换**谁先开口**——两个方向都合法。旧实现只查**答方自己**的收件箱，于是"**收到别人的请求再回信**"这个最常见用法**永远标不上**：回复照常送达、`replyTo` 照常串联，只有"已回复"静默落空。修法是**两端都查**（`[sessionId, other(channel, sessionId)]`），而不是推断谁先开口 |
| **已读推进不能吃掉"待回复"** | 加已读推进时暴露的边界：`markRead` 把 `awaiting-reply` 写成 `read` 会抹掉 B6 的待回复标记。改为 `awaiting-reply → new`，并让 `markReplied` 也接受 `new` |
| **诊断方向问题要测,不要读** | 定位上面那个真缺陷时我翻了三次（先判断对、又从代码"读出"相反结论并回滚、最后打探针才定论）。教训记在 `MAINTENANCE.md` 第十一节：**"测试全绿"不等于"判断正确"——如果我为了让它绿而改了断言，那说明我改的是语义** |

> 关于上表最后一行：本插件的子代理安全性来自**代码守卫**，不是"工具不存在"。这是有意的（D4：无授权时工具返回说明而非报错），但也意味着若 `isRuntimeRoot` 判断出错，工具就会落到子代理手里。守卫因此是承重件，不是装饰。

### 仍未在生产中验证的部分

- `peer_inbox` 的**已读推进**（已按用户选定的语义实现，差真机复核）：**取回正文才算读**，列表看一眼不算。
  真机曾确认过旧行为：那条回复在"列表看过一次 + 按 id 取过全文"之后仍然是 `[unread]`，即没有任何路径能改变状态。
  新语义下：`unread → read`、`awaiting-reply → new`，已读条目不显示任何标记；**"是否已读"与"是否已答"是两个正交事实共用一个字段**，所以已读不会抹掉"还没人回"这个标记（否则就违反了 B6），`markReplied` 也因此必须接受 `new`。
  尚未在真机上看到的是：回复送达后，**发起方**那条请求是否真的变成 `[replied]`（见下一条）。

## 13. 里程碑与进度

### M1 · 已完成（待真机验收）

侧栏一致列表（H1）· 2 条命令 + 4 个工具 · 插件直接取授权 · `followup` 投递（空闲才投递）· 冷会话唤醒（当场确认）· 双向审计 · 单元测试（当时的 54 项，现在 58 项）。

因为会话内授权改成了进程内 Map（§6），原本排在 M2 的"仅本对话授权"与"冷会话唤醒"也随之落进 M1。

### M2 · 进行中

- ~~**`peer_inbox` 只能给摘要，取不回正文**~~ —— **已实现**。真机暴露的原始缺陷：对端回了一封**结构完整、很长**的答复，而 `peer_inbox` 只显示 `summary`（一行），正文只能从转录里那条 relay 消息读到。于是"收件箱"其实只是提示而非索引——**那条消息若不在当前上下文里，正文就取不回来**。
  实现方式：投递时把**跨通道的那份完整正文**（含来源抬头，与收到的消息**同一份字符串**）存进收件箱条目，`peer_inbox({ id })` 取回它。存在正文而不是摘要的拼接，是为了让"归档的那份"与"投递的那份"**不可能漂移**；来源抬头随正文一起回来，则是为了让很久之后的一次取回**仍然写明这不是用户指令**（H2 的延寿，而不是只在新消息上生效）。
- ~~`peer_inbox` 摘要里补上 `replyTo`~~ —— **已实现**（正文里本来就有，摘要里漏了）。
- ~~`peer_inbox` 的**已读推进**~~ —— **已实现**，语义由用户在看过真机列表后选定：**取回正文才算已读**，列出摘要不算。
  实现：`unread → read`（无标记）、`awaiting-reply → new`（标记 `new · never answered`，即"读过但没人回"）。`markRead` 只在**按 id 取回**那条路径上调用。
  **一处必须记住的约束**：读没读过、有没有人回，是两个正交事实却共用一个 `status` 字段，所以已读**不能**把 `awaiting-reply` 写成 `read`——那会抹掉 B6 要的待回复标记。为此 `markReplied` 也必须接受 `new`。
- `peer_progress` 深化：`plan`、`contextPressure` 等投影的渲染。**真机已证实这些键确实存在**（2026-09-14 重启后的那次 `peer_progress`）："其他存在的投影"一行列出 `tokenUsage, contextPressure, contextBreakdown, sessionStats, agentPreset, subagentCatalog, subagentTiming, subagent, modelSelection, sessionListMetadata, imageLimits, plan`。所以第 5 项是"渲染已有数据"，不是"先找数据"；但渲染前仍要先确认 `plan` 的内容边界（C2 禁止对话原文）。
- 环路防护完整版：每对速率上限、跳数上限、请求超时后的主动通知
- **真机复核三件**：① 已读推进生效（列表先 `[unread]` → 取回后无标记）；② 收到请求的一方回信后，那条请求从 `[never opened]` / `[new · never answered]` 变成不显示标记——**这一条此前从未生效过**（见 §12 的 `markReplied` 一行），所以它同时也是那个缺陷的修复验收；③ 反向次序（自己开的头、收到对端回信）同样要变。三件都因为新代码要再重启一次才生效。

### M3 · 待做

- 双语文档完善、GitHub 发布

### 单元测试规模

`npm test` 当前 **60 项**（M1 首次交付时为 54 项，本节曾写作 25 项——那是 M1 中途的数字，未随实现更新）。

### M1 验收（真机）

两个真实会话 → `/peer connect <标题> session`（重名时列候选）→ `/peers` 可见通道 → A 调 `peer_send`（B 忙 → 排队不打断）→ B 空闲后自动醒来看到带来源标注的消息 → B 用 `peer_send(kind:'reply')` 回信 → A 醒来 → `/peer revoke` → 再发被拒 → **归档对端后立刻被拒**。
