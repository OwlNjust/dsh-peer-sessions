# dsh-peer-sessions

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**同层级会话之间**的、
> 由用户授权的对称通道——两个你自己指挥的会话互相对话。**没有上级，也没有下级。**

**中文 · [English](README.md)**

---

## 这是什么

两个长期会话——比如 `/srv/orders-api` 和 `/srv/web-client`——都归你，
谁也不比谁高一级。一个改了 API 契约就通知另一个；另一个改完就回一声。

这**不是** `subagent`。分界线是：

> **一方结束就意味着另一方也该停 —— 那是 subagent。
> 两者可以各自独立地活下去 —— 那才是 peer。**

现有的 `send_message` / `list_agents` 建立在"父拥有子"（`isOwnedBy`）之上，
而 peer 通道没有所有权关系，所以不能复用它。

## 那条硬规则

**agent 眼里的对话列表，必须是人在侧栏能看到的列表的子集。
一个 agent 绝不能对着一个人类看不见的对话说话。**

可寻址集合直接由侧栏自己的可见性规则推导
（`dsh-client-ui-workspace` 里的 `sessionVisible`）。下面是那两处宿主读取——
**服务名与返回形状都请注意**，README 初稿两处都写错了：

```js
// 规则的完整形态（含"每个隐藏会话为什么被隐藏"）在 lib/addressable.js 的
// `classify`——那个文件是权威，这里只是示意。
const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
const { items } = await ctx.sessionController.list({}, signal)   // 是 { items }，不是数组
const addressable = items.filter(s =>
      s.origin !== 'subagent'
   && !archived.has(s.sessionId)
   && !s.blank)
```

归档的、空白占位的、子代理的会话被排除。**每次投递都会重新读取这个列表**，
所以归档一个对端会立刻切断可达性——不需要监听器，也没有缓存。

## 设计

完整冻结规格见 **[docs/design.md](docs/design.md)** —— 它规定"应该做成什么样、为什么"，是唯一权威来源。

## 维护

**[MAINTENANCE.md](MAINTENANCE.md)** 写给下一个接手的人，包括**没有任何历史上下文的新对话**：怎么接线、四条硬不变量，以及十七个**已经真实花过时间**的坑——会 re-apply 却不重新读模块的加载器、不能软链的技能、必须是软链的 `node_modules`、以及和直觉不符的投影形状。

**动手前先读它。**

## 接口

**你手打的命令**

| 命令 | 作用 |
|---|---|
| `/peers` | 列出通道：对端、授权档位、剩余额度、对端可见性 |
| `/peer connect <标题> [once\|session]` | 建立通道；档位选择走原生选项卡片 |
| `/peer revoke <标题>` | 断开通道 |
| `/peer progress <标题>` | 查看对端进度 |

**模型调用的工具**

| 工具 | 作用 |
|---|---|
| `peer_send` | 发消息；无授权时弹出授权卡片 |
| `peer_inbox` | 读收件箱：每条一行摘要，或按 id 取回某条的完整投递正文 |
| `peer_progress` | 读对端投影 + 摘要 |
| `peer_list` | 查看通道与权限 |

**零客户端代码。** 命令结果走现有聊天 UI，授权卡片走现有 user-questions UI，
消息来源标注走现有的 `form: 'relay'` 渲染。本包不声明 `dsh.client`。

## 环路防护

两个会话互相回复可以无限持续，所以有三道上限加一个超时通知，**全部在投递之前判定**——被拒绝的投递不消耗额度、也不推进链条。下表每个数字都是**配置项**（见[配置](#配置)），这里给的是默认值。

| 防护 | 上限 | 说明 |
|---|---|---|
| 每对速率 | 30 条 / 60 秒 | 按**通道**计的固定窗口 |
| 每对总量 | 200 条 | 一条通道一生的投递总量（`once` 档为 1） |
| 跳数 | 3 跳 | 一条**因果链**跨会话被接力转发的深度；两个会话正常来回不受此限 |
| 请求超时 | `replyWithin` | 到点**通知发起方一次**，**绝不自动重发** |

`request` 的 `replyWithin`（如 `"15m"`、`"4h"`）是真正的期限：到点后发起方下一次调用工具时会看到一条 `Overdue` 提示；收到请求的一侧在列表里看到 `[timed out · …]`，取回正文时抬头多一行 `deadline: OVERDUE`。

### 怎么"等"，以及为什么不要等

投递在两个方向上都遵循"空闲才投递"，**第二个方向才是最容易踩的**：

- 你发出的消息排在**对端**当前回合之后——绝不打断它；
- 对端的回信排在**你自己**当前回合之后，会**新开一个回合**，而不是打断你正在跑的这一轮。阻塞调用是原子的，所以一条长命令执行期间到达的回信只能排在它后面。

所以 agent **不要**为等对端而 sleep、轮询或挂 `wait_agent`。要么结束回合、让回信把你唤醒；要么必须在本回合继续干活时**主动拉取** `peer_inbox`——它读的是插件自己的收件箱，**已经送达的回复立刻就能读到全文**，尽管它的中继消息要到下一回合才进上下文。

回合进行中，入站的 peer 消息会出现在**输入框上方的队列条**里，并带着**完整来源抬头**——那一栏里不属于你的文字会写明是谁说的。每一项都带 编辑 / 删除 / **提升为 steer** 三个控件，`Cmd`/`Ctrl`+`Enter` 则可把**全部**排队消息插话发送。这就是长步骤卡住回信时，人这边的逃生门。

### 积压会合并，而且每条都带发送时间

长任务期间，同一对话可能连着发来好几条。宿主每个回合只取**一条**排队消息，所以"三条 = 三个回合"——第一个回合读到的状态，往往已经被后面两条推翻了，而它要**干完活才会看到**后面两条。两处改动针对这件事：

- **每条 peer 消息的抬头里都有 `sent: 2026-10-17T20:01:02+08:00`**（本地时间带偏移，可以直接和每轮运行环境里的时间比）。看一眼就知道这条是刚发的还是排队 8 分钟的。
- **忙时的新消息会合并进"还没被读到"的那条**：对端读过之前，后到的一条被折叠进同一条排队消息里，于是对端一个回合读到**一批**，带顺序、带每条的时间、并明确写着"后面的可能修正或推翻前面的"。队列条里始终只有一条，不会变成 N 个回合。
  - **一条都不会丢**：如果那条排队消息刚好被读了（`replace` 返回 false），新消息照旧成为自己的回合；超过 `mergeMaxChars` 上限时，多出来的部分也照旧单独成条。
  - `silent` 投递不参与合并（它走的是"下一步"上下文注入，替换在途内容风险不同）。
  - 收件箱仍是**每条一个条目**：合并只发生在投递这一侧，`peer_inbox(id)` 仍按原 id 取回各自正文。

## 配置

阈值由你在插件的组合行里调：

```yaml
- id: dsh-peer-sessions
  name: dsh-peer-sessions
  config:
    hopLimit: 5
    rateLimit: 60
    rateWindowMs: 60000
    channelBudget: 500
    inboxLimit: 100
    requestMemory: 1000
    pendingGraceMs: 86400000
    hopMemoryMs: 900000
    maxCandidates: 8
    recentTurns: 3
    previewMaxChars: 200
```

| 字段 | 默认 | 管什么 |
|---|---|---|
| `hopLimit` | `3` | 一条链跨会话被接力多少跳之后拒绝 |
| `rateLimit` / `rateWindowMs` | `30` / `60000` | 一对会话在一个固定窗口内能投递多少条 |
| `channelBudget` | `200` | 一条通道一生的投递总量 |
| `hopMemoryMs` | `900000` | 一条入站消息在多长时间内仍算"正在回答的那条" |
| `inboxLimit` | `50` | 每个会话保留的收件箱条目数 |
| `requestMemory` | `500` | 为回复方向校验记住多少个请求发起方 |
| `pendingGraceMs` | `86400000` | 未回答的请求继续被报告多久 |
| `maxCandidates` | `8` | 标题歧义时最多列几个候选会话 |
| `recentTurns` | `3` | `peer_progress` 摘要末尾几轮 |
| `previewMaxChars` | `200` | `peer_progress` 单行预览的上限 |
| `mergeWhileBusy` | `true` | 对端还没读时，把新消息合并进排队的那条 |
| `mergeMaxChars` | `12000` | 一条合并消息的正文上限，超过就分开投递 |

改之前有两件事值得知道：

- **一行的 `config` 是整体替换，不是深合并。** 只写一个字段没问题（其余由 schema 声明的默认值补齐，有测试钉住）；但**多层覆盖同一行**时，靠后的那个 `config` 对象**整块**胜出。若你从两处设置，靠后的那处要列全你想保留的字段。
- **每个字段都有默认值。** 少一个默认值，省略 `config` 就会变成校验失败；而校验失败的插件在启动时**只是一条警告**——profile 照常启动，插件却静默消失。默认值就是上表的值，所以完全省略 `config` 永远安全。

## 数据与边界

**授权写进会话日志，其余一切都在进程内存里。**

- **授权是持久的（v1.3.0 起）**：通道建立时，一条**插件记录**写进**批准它的那个会话**的日志——`ignorable: true`、类型 `plugin:dsh-peer-sessions/channel`、不进模型可见面、不进已发布的事件词汇表。于是**重启 dsh、插件重载、停用再启用之后，通道仍在**，直到你用 `/peer revoke` 撤销。撤销本身也是持久的：墓碑写给两端所有活着的会话，批准方当时是冷的话，它下次加载时跨日志核对（`sessionController.inspect()`，不唤醒）。
- **收件箱、待答期限、hop 记忆、速率窗口仍只在进程内存里**：它们描述的是"在途的投递"，重启结束在途的这一半。`peer_inbox(id)` 那句"正文仍可取回"的边界因此是**宿主进程的生命周期**，不是日志的生命周期。
- **授权记在批准方，不记在对端**：对端的人从没见过那张卡片。所以重启后，通道要等**批准方**先把它加载回来；对端先发话时会重新问它自己的人要卡片——它的人确实没批准过任何东西。
- **额度也是持久的**：花掉的投递、`once` 档的"已花掉这一次往来"都写进日志，重启不会重发额度。
- **fork 会带着授权记录**（日志被复制），所以 fork 出来的同一段历史可以继续用那条通道——那仍是同一个人的同一段对话。
- 为什么能持久化：0.2.1 的 `appendPluginRecord` 写的是**词汇表之外**的 `ignorable` 事件。早先尝试的"自定义 `type`"被否决是对的——那会让会话打不开；插件记录绕开了这个代价。详见 `docs/design.md` §6 与 `MAINTENANCE.md` §二。
- **需要 dsh ≥ 0.2.1**：更老的宿主没有 `appendPluginRecord`，插件**照常工作**，只是授权退回"进程内"的旧寿命，并在日志里留一条警告——不会因为版本不够而拒绝加载。

## 卸载

```sh
./uninstall.sh
```

它按顺序撤销安装的四步：

| 步骤 | 移除什么 |
|---|---|
| 1 | 已部署的技能目录 `~/.dsh/skills/peer-session/` |
| 2 | profile `cordis.patch.yml` 里手写的 `insert` 行（先备份） |
| 3 | profile 依赖（`dsh plugin remove dsh-peer-sessions`） |
| 4 | 本包的 `node_modules` 软链 |

之后**必须重启 profile**——进程不重启，插件就一直还在。走路线 A（插件管理器）安装的，请在管理器里卸载；只对**你实际用的那条路线**执行，事后核对：

```sh
grep -c dsh-peer-sessions ~/.dsh/profiles/web/cordis.patch.yml   # → 0
```

## 安装

**一次只用一条路线。** 它们都会激活同一个插件 id。重复不会有人拦——组合层会把这一行列两次，加载器把该 id **只挂一次、靠后者胜出、且没有任何警告**（0.2.0-rc.2 实测，见 `MAINTENANCE.md` §一 安装）。所以代价不是崩溃，而是**一行被静默遮蔽**：靠后的那份决定该行的 `config`，而这种事往往要花掉一个下午才会发现"某个设置根本没生效"。

### 路线 A：作为组合包安装 —— 来源可以是 npm 或仓库地址

本包已发布到 npm（[`dsh-peer-sessions`](https://www.npmjs.com/package/dsh-peer-sessions)），普通用户用这一条：

```sh
dsh plugin --profile web add dsh-peer-sessions
```

- 装完由管理器当作**组合层**处理，**不需要手改任何 profile 文件**；
- 想固定版本：`dsh plugin --profile web add dsh-peer-sessions@1.3.2`；
- 升级：`dsh plugin --profile web add dsh-peer-sessions@<新版本>`（管理器本身没有"更新"按钮，等价于重装）；
- 桌面端：在「管理插件」里填 **`dsh-peer-sessions`**（包名）即可，不必用 CLI。

> 安装会执行包里的**代码**（和任何插件一样）：它读写你的会话、在工具调用里发消息。看一遍源码再装，或先装在无凭据的环境里试。

#### 路线 A 的另一种来源：仓库地址（git 快照）

本包声明了 `dsh.bundle`，所以 dsh **0.2.0+** 的插件管理器会把它当作**组合层**：装完自动生效，
**不需要手改任何 profile 文件**。

- 桌面端：「管理插件」→ 填仓库地址（或用 npm 名）。
- CLI（`desktop` profile 除外——官方明确拒绝对它做插件管理，桌面端只能用它的 UI）：

```sh
dsh plugin --profile <profile> add <仓库地址或包名>
```

> **0.2.0 的硬要求**：管理器用 `inspectionOf()` 判定 `dsh.bundle` 是否为对象，否则报
> `not-a-bundle`「这个包没有声明组合包，不能作为插件管理」并回滚。本包自 v1.0.3 起已声明。

桌面端装的是 **git 快照**，不跟随本地仓库改代码；每次发版都要在管理器里更新一次。

### 路线 B：本地克隆 + `./install.sh`

```sh
./install.sh
```

它会做四件事：把本包的 `node_modules` 软链到**宿主实际在用的那份实例**（这样
`@deepseek-ai/dsh-llm` 和 `@deepseek-ai/dsh-tools` 才能解析，且与宿主同一份模块）、
加 profile 依赖、追加 composition 行、部署技能。**`link:` 安装是实时的**，改代码重启即生效。

### 手动安装（路线 B 的展开）

```sh
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:/path/to/dsh-peer-sessions
```

然后向 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-peer-sessions
      name: dsh-peer-sessions
```

> `./install.sh` 会**跳过**追加那一行——如果它发现本包已经是该 profile 的活跃组合包（路线 A 装过）。
> 重复的行会静默遮蔽另一行（见上）。

复制技能——是**复制**不是软链，因为技能提供者用 `lstat` 语义列举技能根，
软链的目录永远不会被发现：

```sh
mkdir -p ~/.dsh/skills && cp -r skill/peer-session ~/.dsh/skills/
```

重启 web profile，然后用 `/peers` 检查。

## 开发

```sh
npm run link     # 每台机器跑一次：把 node_modules 链到宿主实际在用的那份
npm test         # 全部测试；不需要宿主进程
```

测试跑真实的 `@deepseek-ai/dsh-llm` 消息构造、把真实的
`@deepseek-ai/dsh-session-format-v3-to-v4` 准入校验当 oracle，外加一个假宿主上下文，
所以每条不变量都被覆盖，而不需要启动进程。

那个软链是**前置条件，不是便利**：裸 `@deepseek-ai/*` 说明符按导入文件的 realpath 解析，
没跑过 `scripts/link-deps.sh` 的机器上测试会在 import 处直接失败。
当前测试条数以 `npm test` 末行为准。

## 状态

**已上线。** 设计冻结在 [docs/design.md](docs/design.md)（§12 记录真机上验过什么，§13 是里程碑划分）。
