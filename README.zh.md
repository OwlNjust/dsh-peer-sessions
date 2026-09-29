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

**[MAINTENANCE.md](MAINTENANCE.md)** 写给下一个接手的人，包括**没有任何历史上下文的新对话**：怎么接线、四条硬不变量，以及十五个**已经真实花过时间**的坑——会 re-apply 却不重新读模块的加载器、不能软链的技能、必须是软链的 `node_modules`、以及和直觉不符的投影形状。

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

改之前有两件事值得知道：

- **一行的 `config` 是整体替换，不是深合并。** 只写一个字段没问题（其余由 schema 声明的默认值补齐，有测试钉住）；但**多层覆盖同一行**时，靠后的那个 `config` 对象**整块**胜出。若你从两处设置，靠后的那处要列全你想保留的字段。
- **每个字段都有默认值。** 少一个默认值，省略 `config` 就会变成校验失败；而校验失败的插件在启动时**只是一条警告**——profile 照常启动，插件却静默消失。默认值就是上表的值，所以完全省略 `config` 永远安全。

## 数据与边界

本插件拥有的一切都在**进程内存**里，不落盘、也不写进任何会话日志：

- 通道、授权、收件箱、待办期限——全是按 session id 索引的 Map，**重启即清空**。授权随进程结束而消失，这是"本对话内"这一档位的既定边界，不是疏漏。
- 因为不写会话事件，这些状态**无法从对话记录里重放或恢复**。`peer_inbox(id)` 那句"正文仍可取回"的边界是**宿主进程的生命周期**。
- 为什么不持久化：持久化读取路径会拒绝词汇表之外的自定义 `type`，除非该事件带 `ignorable: true`，而实时 `Session.append()` 设不了这个标记——那样这个会话从此打不开。详见 `docs/design.md` H2 与 `MAINTENANCE.md` §2.1。
- 由此有两个值得明说的推论：**插件被 re-apply**（文件变更后加载器重放）**通道还在**；**停用再启用该行也还在**——它们不随卸载清除，只随进程结束消失。

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

**两条路线，只能选一条。** 它们都会激活同一个插件 id。重复不会有人拦——组合层会把这一行列两次，加载器把该 id **只挂一次、靠后者胜出、且没有任何警告**（0.2.0-rc.2 实测，见 `MAINTENANCE.md` §十一之四）。所以代价不是崩溃，而是**一行被静默遮蔽**：靠后的那份决定该行的 `config`，而这种事往往要花掉一个下午才会发现"某个设置根本没生效"。

### 路线 A：作为组合包安装（桌面端「管理插件」/ 仓库地址）

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
