# dsh-peer-sessions

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**同层级会话之间**的、
> 由用户授权的对称通道——两个你自己指挥的会话互相对话。**没有上级，也没有下级。**

**中文 · [English](README.md)**

---

## 这是什么

两个长期会话——比如 `/mnt/d/CodeWorks` 和 `/mnt/d/CodeWorks/GarmentCodaData`——都归你，
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

完整冻结规格见 **[docs/design.md](docs/design.md)**。

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
| `peer_inbox` | 读收件箱 |
| `peer_progress` | 读对端投影 + 摘要 |
| `peer_list` | 查看通道与权限 |

**零客户端代码。** 命令结果走现有聊天 UI，授权卡片走现有 user-questions UI，
消息来源标注走现有的 `form: 'relay'` 渲染。本包不声明 `dsh.client`。

## 安装

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

复制技能（是**复制**，不是软链——技能提供者用 `lstat` 语义列举目录，
软链的 skill 目录永远不会被发现）：

```sh
mkdir -p ~/.dsh/skills && cp -r skill/peer-session ~/.dsh/skills/
```

重启 web profile。或者直接运行 `./install.sh`。

## 状态

预发布。设计已冻结，实现从 M1 开始（见 [docs/design.md §13](docs/design.md)）。
`lib/index.js` 尚未存在，`install.sh` 在它存在之前拒绝做任何接线。
