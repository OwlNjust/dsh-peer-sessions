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
（`dsh-client-ui-workspace` 里的 `sessionVisible`）：

```js
const archived = new Set(ctx.workspace.archivedSessionIds)
const summaries = await ctx.sessionController.list()   // 与侧栏同源
const addressable = summaries.filter(s =>
      s.origin !== 'subagent'
   && !archived.has(s.sessionId)
   && !s.blank)
```

归档的、空白占位的、子代理的会话被排除。**每次投递都会重新读取这个列表**，
所以归档一个对端会立刻切断可达性——不需要监听器，也没有缓存。

## 设计

完整冻结规格见 **[docs/design.md](docs/design.md)** —— 它规定"应该做成什么样、为什么"，是唯一权威来源。

## 维护

**[MAINTENANCE.md](MAINTENANCE.md)** 写给下一个接手的人，包括**没有任何历史上下文的新对话**：怎么接线、四条硬不变量，以及十三个**已经真实花过时间**的坑——会 re-apply 却不重新读模块的加载器、不能软链的技能、必须是软链的 `node_modules`、以及和直觉不符的投影形状。

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

两个会话互相回复可以无限持续，所以有三道上限加一个超时通知，**全部在投递之前判定**——被拒绝的投递不消耗额度、也不推进链条：

| 防护 | 上限 | 说明 |
|---|---|---|
| 每对速率 | 30 条 / 60 秒 | 按**通道**计的固定窗口 |
| 每对总量 | 200 条 | 一条通道一生的投递总量（`once` 档为 1） |
| 跳数 | 3 跳 | 一条**因果链**跨会话被接力转发的深度；两个会话正常来回不受此限 |
| 请求超时 | `replyWithin` | 到点**通知发起方一次**，**绝不自动重发** |

`request` 的 `replyWithin`（如 `"15m"`、`"4h"`）是真正的期限：到点后发起方下一次调用工具时会看到一条 `Overdue` 提示；收到请求的一侧在列表里看到 `[timed out · …]`，取回正文时抬头多一行 `deadline: OVERDUE`。

## 安装

```sh
./install.sh
```

它会做四件事：把本包的 `node_modules` 软链到 profile 的（这样 `@deepseek-ai/dsh-llm`
和 `@deepseek-ai/dsh-tools` 才能解析，而且指向**与宿主同一份模块实例**）、加 profile 依赖、
追加 composition 行、部署技能。

手动安装：

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

复制技能——是**复制**不是软链，因为技能提供者用 `lstat` 语义列举技能根，
软链的目录永远不会被发现：

```sh
mkdir -p ~/.dsh/skills && cp -r skill/peer-session ~/.dsh/skills/
```

重启 web profile，然后用 `/peers` 检查。

## 开发

```sh
node --test      # 25 项测试，不需要 harness
```

测试跑真实的 `@deepseek-ai/dsh-llm` 消息构造 + 一个假宿主上下文，
所以每条不变量都被覆盖，而不需要启动进程。

## 状态

**M1 已实现**，等待真实双会话验收。里程碑划分与验收路径见
[docs/design.md §13](docs/design.md)；实现期实测到的运行时事实见 §12——
其中两条修正了设计初稿。
