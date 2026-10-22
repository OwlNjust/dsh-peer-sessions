# dsh-peer-sessions · 维护手册

> 交接文档，给下一个维护者（人或对话）。按顺序读：**§一** 它是什么、怎么接进来；**§二** 现在什么状态；**§三** 踩过的坑（价值最高）。
>
> **规格**在 `docs/design.md`；**完整历史**在 git——每次事故的推理过程都在提交信息与 tag body 里，本文只留**结论、规则和指针**。

## 一、它是什么、怎么接进来

平级对话通道：**用户同时开着的两个会话**之间，经用户授权建立对称通道——没有父子、没有优先级。四个模型工具（`peer_send` / `peer_inbox` / `peer_progress` / `peer_list`）加两个命令（`/peers` / `/peer`）。

### 文件地图

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 入口：`Config` schema、`inject` 清单、`apply` 装配、语言跟随；**模块级 `sharedStore`**（坑 1） |
| `lib/addressable.js` | 可寻址集合（H1）与目标解析；零宽字符清洗 |
| `lib/core.js` | 投递编排、授权解析、hop/速率、合并投递 `mergeQueued`、durable grant 的 `hydrate`/`persist` |
| `lib/store.js` | 进程内状态（通道、额度、收件箱、pending、hop 记忆）+ durable sink 挂接点 |
| `lib/grants.js` | 授权持久化：插件记录快照/墓碑、折叠、跨日志合并 |
| `lib/consent.js` | 向人取授权（H3）、`isRuntimeRoot` 守卫、失败原因分类 |
| `lib/messages.js` | 消息构造与渲染（来源抬头、`sent:`、批次合并）——v4 准入的前提 |
| `lib/tools.js` / `lib/commands.js` | 模型面 / 人面 |
| `lib/i18n.js` | 命令与回答的本地化（`zh` / `en` 两张表必须同步） |
| `locale/*.json` | 插件管理器的标题/描述（宿主只读这里，不读 `package.json.meta`） |

### 安装：两条路线，只能选一条

| | A 组合包 | B 本地克隆 + `install.sh` |
|---|---|---|
| 载体 | 包声明 `dsh.bundle`，名字进 `dsh.profile.bundles` | profile 用户 patch 层**手写** insert 行 |
| 生效 | 管理器装完自动 | 手改 profile + 重启 |
| 更新 | git 快照，发版后在管理器更新 | `link:` 实时，改代码重启即生效 |

两条路线激活**同一个 id**：组合层把这行解析两次，加载器 `Object.fromEntries` **靠后者覆盖前者**，只挂一个 Entry、只 `apply` 一次（全程静默）。所以代价是**一行被静默遮蔽**（决定 `config` 的可能是另一份），不是崩溃。`install.sh` 第 3 步有守卫：已是活跃组合包就拒绝追加手写行。核查：`dsh --profile web --dump-config | grep -c 'id: dsh-peer-sessions'`，期望 `1`。

### 四条硬不变量（重构时别拆）

| | 含义 | 落点 |
|---|---|---|
| H1 | 可寻址集合 ⊆ 侧栏集合（只能更严） | `addressable.js`，每次投递重读 |
| H2 | peer 消息可归属、不能伪造成用户指令；不走 `sessionController.prompt()` | `messages.js` |
| H3 | 授权由插件**直接**向人取得，模型不经手 | `consent.js` |
| H4 | peer 消息不升级任何权限 | `core.js` / `tools.js` |

## 二、当前状态（v1.3.1）

### 已验证（真机，dsh 0.2.1-rc.2）

- **授权持久化**：通道跨重启仍在，额度随花随记；`/peer revoke` 的墓碑跨重启生效；撤销后重建正常。
- **跨日志合并**：真机抓到"旧墓碑删掉新授权"，已修（坑 19）。
- **忙时合并投递**：对端 45 秒任务期间连发 3 条通知 → **一个回合读一批**（3/3 段、按 `sent` 排序）；反方向同样成立（对端两条回信在我忙时合成一批）。
- **授权卡片**在 0.2.1 上可用（不带档位的 `/peer connect` 弹卡，带档位不弹）。
- 每条消息带 `sent:`；`peer_inbox` 按 id 取回正文，并正确处理已读/未答/已回复。
- 命令注册与语言跟随后，`/peers`、`/peer connect|revoke|progress` 由测试里的真 Loader 覆盖。

### 已知限制（刻意，别当欠账）

- **进程内**：收件箱正文、待答期限、hop 记忆、速率窗口——它们描述在途投递，重启结束这一半。`peer_inbox` 的"正文仍可取回"以**进程生命周期**为界。
- **授权只在批准方日志里**：重启后要等批准方先加载；对端先发话会重新要**它自己人**的卡片（它的人确实没批准过）。
- **合并只在"上一条还没被读"时发生**；已被 claim 就各自成回合——不丢，只是不合并。
- `once` = 一次往来（消息 + 对该 request 的回复）；跳数只防接力，不防聊得久。

### 下一步（如果有）

- 请求期限改为"被读到"起算（现为发送时起算；长任务下会提前超时）。见 `docs/design.md` §7。
- 其余没有已知欠账。**先问用户最近用起来哪里别扭**——这个项目里真机比推理更会教人。

## 三、踩过的坑（21 条）

> 每条只留：症状 / 根因与规则。排查过程和证据在引用的提交里。

### 坑 1：加载器 re-apply 不重新求值模块；0.2.1 起 HMR 会驱逐过期模块
- 症状：改了 `lib/*.js` 以为生效，跑的还是旧代码；`apply()` 里创建的状态被丢弃。
- 规则：`store` 放**模块作用域**。0.2.1 的 `dsh-hmr` 会在 profile 重组前比对磁盘并 evict 过期模块，所以一次重组会**同时**让新代码生效、把 store 换成新实例（通道/授权清空）。跨重载保留授权靠 `grants.js`，**不要**把 store 挪到别处。指针：`22713a8`。

### 坑 2：技能必须**复制**，不能软链
- 症状：技能目录在 `~/.dsh/skills/` 下但从不被发现。
- 规则：技能提供者用 `lstat` 语义列举（软链被判成 `other`），`install.sh` 用 `cp -R`。

### 坑 3：本包 `node_modules` 必须是**软链**到宿主同一份 realpath
- 症状：`@deepseek-ai/dsh-llm` / `dsh-tools` 解析不到，或解析到**另一个版本**的实例（身份分裂：两份定义同一类型）。
- 规则：由 `scripts/link-deps.sh` 选实例（优先从 PATH 的 `dsh` 反推，`profiles/node_modules` 只兜底；每层同时看 `$d/node_modules` 与 `$d/*/node_modules`）。**判据是 `readlink -f` + 包版本，不是"功能看起来正常"**；升级宿主后必须重跑。

### 坑 4：`.gitignore` 的 `node_modules/`（带斜杠）匹配不到软链
- 规则：必须同时有裸写的一行 `node_modules`，否则软链会被提交进仓库。

### 坑 5：工具是**全局注册**的，子代理也看得到
- 规则：子代理安全性来自代码守卫 `isRuntimeRoot`（真机验证：工具可见、调用被拒、**不弹卡**——`userQuestions.ask` 从未被调用）。守卫是承重件。

### 坑 6：投影值是 `JsonValue`——键存在 ≠ 值是对象
- 症状：`title` 为 `null` 时读属性崩溃。
- 规则：一律走 `asRecord()`。真实形状也不直观：`todos` 是数组；`goal` 是 `goal.goal.objective` + `roundsStarted`；`turnOutline` 是 `{turn,prompt,response}[]`；`inbox` 是 `{'next-turn':[], 'next-step':[]}`。

### 坑 7：空闲会话是**冷的** → 一张卡覆盖唤醒
- 症状：每次投递都确认唤醒 = 每条消息两张卡（真机观察：会话跑完一轮又变回 `running:false`）。
- 规则：唤醒算在通道批准里，撤销就是关开关；卡片在需要唤醒时**明说代价**。用 `ctx.agents.get()` 判活（本进程即时视图）；**不要**换成 `agentAvailable`（权威但可能滞后，语义不同）。

### 坑 8：`once` 是**一次往来**，不是一条消息
- 规则：一条消息 + 它对某条 request 的回复，然后作废。方向校验只认**对端发起**的 request（否则一方能用自己发过的 request 解锁另一方的额度）。见 `store.noteRequest` / `isAnswerableOn`。

### 坑 9：`turnOutline` 的预览是**逐字摘录**，是刻意选择
- 规则：每轮 200 字符、最近 3 轮，合计约 600 字符原文。不要当漏洞"修"；要改就改 `RECENT_TURNS` / `PREVIEW_MAX_CHARS` 并先问用户。

### 坑 10：粘贴文本可能带**零宽字符**
- 症状：自相矛盾的报错——`未知子命令「connect」`，同时把 `connect` 列为可用。
- 规则：解析命令前**和**匹配目标前都调 `stripInvisible()`（后者同样重要：带零宽的标题匹配不到真实会话）；报错用 `displayToken()` 打出码位。

### 坑 11：`followup` 让入站消息出现在对端**输入区**（刻意保留）
- 规则：两个"收件箱"不是一回事——GUI 队列条 = 宿主 inbox 的 `next-turn`（**不看 source kind**）；`peer_inbox` = 插件自己的 store，投递那一刻写入。所以中继消息下一回合才进上下文，但**已送达的回复当前回合就能全文取回**。
- 另有物理事实：**阻塞中的步骤收不到任何东西**（工具调用原子，`followup` 不打断）。

### 坑 12：`silent: true` 与冷对端**互斥**
- 规则：直接拒绝（`silent-needs-running`），连卡都不弹——自相矛盾的请求不该让人裁决。

### 坑 13：Windows 侧 git 把三个 `100755` 脚本显示成"已修改"——不是真改动
- 规则：**不要**从 Windows `add`/`commit`（会把 `100755→100644` 记进历史，脚本失去可执行位）；**不要** `core.fileMode false`（`.git/config` 共享，会同时关掉 WSL 侧的检查）。Windows 侧只用来 `push`。

### 坑 14：会话格式 v4 只认**生产者自有**的 `source.kind`，`kind:'plugin'` 被拒
- 症状：`peer_send` 发一次，整个对话每轮报 `format v4 message requires a producer-owned source kind`；**对端已收到**。
- 规则：校验在**宿主 writer**（构造不校验），失败发生在投递**之后**（`exec.deferContext`）。本包只写 `peer-message`（relay）与 `plugin:dsh-peer-sessions`（审计）；每条写进会话的消息都必须过宿主的 `assertV4RowAdmission`（测试用它当 oracle）。指针：`0d3d88a`。

### 坑 15：`Config` 的两个**静默失效**陷阱
- 陷阱 1：模块里有 `default` 导出 → loader 的 `unwrapExports` 只返回 default，兄弟具名导出（含 `Config`）全部不可见 → `Config` 永远 `absent`、`apply` 收到 `undefined`，**不报错**。规则：**纯具名导出**（`export const Config`），并有测试拿真 `unwrapExports` 当 oracle。
- 陷阱 2：字段少 `.default(...)` → 省略 `config` 时校验失败 → 插件 INACTIVE，启动**只有警告**（进程照常起，插件没了）。规则：每个字段都有默认值且引用 `STORE_DEFAULTS` / `CORE_DEFAULTS`，测试断言两侧相等。
- 旁注：行的 `config` 是**整体替换**，不是深合并；改 `config` 走 `patchReload: live` **不需要重启**（验证探针：`peer_progress(peer:'zzz-无此会话')` 的候选行数）。

### 坑 16：`remaining=0` 的 `once` 有两种含义，只显示一种是缺陷
- 症状：`tier=once, remaining=0` 之后一条 `reply` 仍投递成功——看起来像额度漏洞，其实是"中途态"（请求花掉唯一投递，答案搭乘同一批准，送达后当场 revoke）。
- 规则：`peer_list` 与 `/peers` 必须点名中途态并写出是哪条 request 花掉的。**一行状态如果能让读者推出相反的判据，它就是缺陷**。指针：`8b9d796`。

### 坑 17：没有 `wait.callId` 的提问卡是**无名卡**——关不掉，只会取消
- 症状：桌面上 `/peer connect <标题>` 与 `peer_send` 每次都 `ask-failed`，而原生 `ask_user_question` 正常。
- 根因：客户端按 `wait?.callId` 决定 `dismissal: 'hide' | 'cancel'`；无名卡一失去编辑器座位就以**裸字符串 `ASK_CANCELLED`** reject，跨 Remote 无法还原成带 code 的错误。
- 规则：tool 路径把 `exec.callId` 透传成 `wait: { callId }`；失败原因按 `code` → 裸字符串 → `name: message` 依次保留；命令路径无 callId，仍匿名（官方语义：关闭 ≠ 拒绝，请求继续挂着）。指针：`06e50c2`、`84811b8`。

### 坑 18：用可选链读宿主契约 = **静默降级**
- 症状：语言跟随跨两个宿主版本"一直绿"，实际永远回退中文——`settings.get(ns)` 与 `settings/updated` 在 dsh 0.1.7-rc.2 被移除，插件用 `?.` 读、用静默订阅听，契约没了也不报错。
- 规则：读设置走 `describe()`（活值在 `.value`），监听 `settings/document-updated`；**凡可选链读的契约，必须有一条只提供新契约的测试**（"旧 API 也在场"不算证据）。指针：`83effcf`。

### 坑 19：共享 store + 两份日志 → 旧墓碑会删掉新授权（真机抓到）
- 症状：重启后通道正常，投递也成功；对端被唤醒并第一次调 `peer_list` 后，本端通道从共享 store 消失——而日志里的授权完好。
- 根因：撤销时两端都活着，墓碑写进**两份**日志；对端折叠自己的日志时**无条件**执行墓碑，删掉了本端**更新**的授权。
- 规则：折叠必须按记录时间合并——每个通道记 `stateAt`（产生它的记录时间），`existing.stateAt > operation.at` 就跳过；`adopt` 用记录时间，`changed()` 在每次非 revoke 变更时推进。新墓碑仍应赢；同一毫秒无法排序时**撤销优先**。指针：`564db42`。

### 坑 20：`pairKey(a, b)` 少传一个参数不报错，只算出永不匹配的 key
- 症状：跨日志核对永远 `continue`，通道永远删不掉，而常规测试全绿。
- 规则：写"对象键"一类的辅助函数时，**只做看起来对的调用**不会报错也不会被抓；要有一条专门走这条分支的测试。

### 坑 21：插件记录快照里不能有 `undefined`
- 症状：写入抛"non-JSON-serializable data"，被 `persist` 吞掉，授权根本没落盘。
- 规则：`appendPluginRecord` 要求**无损 JSON**；可选字段**省略**而不是置 `undefined`。真机上这些字段总在，所以**只有测试能抓**。

## 四、Host 契约与升级复核

### 依赖的契约（0.2.1-rc.2 现状）

| 契约 | 现状 |
|---|---|
| `dsh-llm` / `dsh-tools` / `dsh-client-locale` / `dsh-session-title` / `dsh-session-format-v3-to-v4` 导出集合 | 与 0.2.0 完全一致；`createUserMessage` / `boundContextSummary` / `defineTool` / `assertV4RowAdmission` 函数体逐字相同 |
| `sessionController.list/resolveAgent` | `{items}` / `{agent}|{error}`，签名不变 |
| `SessionSummary` | 新增 `formatStatus?`，插件读的 `sessionId/updatedAt/running/blank/origin/cwd/projections` 全在 |
| `agents.get/roots`、`sessions.get`、`sessionTitle.get`、`workspaceRegistry.archivedSessionIds`、`userQuestions.ask`、`commands.register`、`tools.register` | 全在，签名与调用处一致 |
| `settings/document-updated` | 仍是唯一设置事件；`locale` 命名空间常量未变 |
| 会话格式 | 仍为 **v4**；`assertV4RowAdmission` 规则未变 |
| 插件记录 | `appendPluginRecord` / `pluginRecordOf`（0.2.1 新增）、`PluginRecordMap`；类型语法 `plugin:<段>/<段>` |
| `Agent.inbox` | `nextTurn` / `replace(id, msg)` / `remove(id)`（合并投递依赖它） |
| `engines.dsh` | 声明了 `>=0.2.0-0`；声明后 `peerDependencies` 被忽略 |
| 版本兼容 | 本包不需要豁免；**没有上界**是刻意的（将来 0.3 需人工复核） |

### 升级复核清单（照抄）

1. `npm test`；先确认 `readlink -f node_modules` 指向宿主当前那份（坑 3）。
2. 双版本 tarball diff：五个包的 `export {…}` 集合 + 四个函数体。**`npm pack` 一条命令只能给最后一个包写版本后缀**——逐个 `for p in …; do npm pack "@deepseek-ai/$p@$V"; done`，解包后先断言每个 `package.json` 的 version 再比。
3. Inspect 活宿主（`cordis_inspect_query`）：服务签名、`settings/document-updated`、本包那一行的 Config 状态。比读类型定义更硬，也最省 token。
4. 发布说明里搜四个词：`invariant`、`engines`、`Session`、`HMR`。
5. 真机：`peer_list` / `peer_progress` / `peer_inbox`，外加**一张授权卡**。

### 事故索引（结论 + 指针）

| 事故 | 结论 | 指针 |
|---|---|---|
| 跳数把"聊得久"当"接力" | 回复不加深；只数换了收件人的投递 | `711ca74` |
| `peer_send` 每发一次打死回合 | v4 拒收 `kind:'plugin'`；改用 `plugin:<包名>` | `0d3d88a`（坑 14） |
| 语言跟随从 0.1.7 起静默失效 | `describe()` + `settings/document-updated` | `83effcf`（坑 18） |
| 桌面版授权卡全灭 | 缺 `wait.callId`；失败原因丢失 | `06e50c2`、`84811b8`（坑 17） |
| `once` 的 `remaining=0` 被误报成配额漏洞 | 显示点名"中途态" | `8b9d796`（坑 16） |
| 两条安装路线并存 | 只静默遮蔽一行，不崩；`install.sh` 守卫 | `3f2a388` |
| 阈值硬编码、用户改不了 | `Config` + 每字段默认值 | `6081abc`、`7d30cb5` |
| 跨日志墓碑删掉新授权 | 按记录时间合并 | `564db42`（坑 19） |
| 忙时 N 条 = N 个过时回合 | 未读队列内就地合并 | `d8e2016`（`docs/design.md` §7.1） |

## 五、测试与发布

### 测试哲学（四课，都是血泪）

1. **夹具必须对数据忠实**：先去声明该类型的包里抄真实形状，别凭直觉；`null`、空数组、缺字段都要喂。
2. **夹具必须对宿主契约忠实，且按当前版本抄**：写 `settings.get` 的时候，测的就是"一个已经不存在的宿主"。夹具里的签名要能说出"抄自哪版哪文件"。
3. **不要让假宿主返回写死的值**：让假 answerer **回显它收到的标签**，让假会话用**真实投影键名**；写死的值会在插件换语言/形状后静默失配，测试还是绿的。
4. **断言要按 id / 按状态取，不要依赖数组位置**；**需要改断言才能通过时，先问这个断言原先在断言什么语义**（把断言改成迁就实现，测试就不再是测试）。

另：**别让测试窗口落在一次调用之内**（依赖时序的断言要给"任何单次调用都不可能跨越"的余量）；夹具新增一种真实能力会改变所有既有测试的语义——**默认关闭、专项测试显式打开**。

### 真机验收

`npm test` 只覆盖逻辑。涉及真机契约的改动必须人工走一遍：

```sh
./install.sh          # 或 npm run link（只改代码时）
# 重启 web profile（坑 1；0.2.1 起一次 profile 重组也可能生效）
```

| 步骤 | 期望 |
|---|---|
| `/peers` | 列出通道；描述与结果用客户端语言 |
| `/peer connect <标题> session` | 建通道、**不发送**（零 token；带档位不弹卡） |
| `/peer connect <标题>` | 弹卡（无通道时） |
| `/peer revoke <标题>` | 断开；紧接着发送应重新弹卡 |
| `peer_send` 到不存在目标 | **具名说明原因**（归档 / 子代理 / 空白），不倾倒整份列表 |
| 授权跨重启 | 重启后 `/peers` 仍在；`peer_send` 不再弹卡 |
| 合并投递 | 对端忙时连发 3 条 → 对端一个回合读到一条 `[peer-session batch · 3 messages]` |

再让一个**对端会话**验另一半：它能否看到命令、能否 `peer_progress` 读本会话、回复能否闭环。

### 发布

```sh
npm test && ./scripts/privacy-scan.sh
npm pack --dry-run            # 逐行看清单：报告类文件必须在包外
git push origin main v1.3.1   # 分支与 tag 一起推（tag 用 annotated）
git status --short            # 必须为空
git ls-files -s install.sh    # 必须是 100755
git ls-remote origin refs/heads/main 'refs/tags/v1.3.1^{}'   # 两个都等于本地 HEAD
```

推送细节（代理、凭据）因机器而异，见本机 `MAINTENANCE-NOTES.md`；Windows 侧"已修改"是视错觉（坑 13）。

## 六、仓库卫生

**绝对不能提交**：真实会话标题 / 工作目录 / 用户名 / 主机名；凭据、token、`settings.yaml`、`~/.dsh` 下任何东西；本机绝对路径（示例用 `/srv/...` 这类中性路径）；本机笔记 `MAINTENANCE-NOTES.md`（与公开的 `MAINTENANCE.md` 是两份东西）。

**扫描**：`./scripts/privacy-scan.sh` 四步——HEAD 跟踪文件 → **每个提交的内容**（push 推的是全部可达提交，"每个 tag 干净"不等于"推送内容干净"）→ 未跟踪未忽略文件 → 提交信息与署名。模式取自 `$PRIVACY_PATTERNS` / `$PRIVACY_PATTERN_FILE` / `./PRIVACY-PATTERNS.txt`（gitignore："要搜的真实字符串"本身就是泄漏）；已公开且决定不重写历史的标记放 `PRIVACY-ACCEPTED.txt`（命中照常列出、不判失败，否则永远红的检查会被忽略）。

**`package.json` 的 `files` 是第二条外发通道**：写**目录**会把被 gitignore 的报告类文件一起打进 tarball（v1.0.3 实测，含真实会话标题）。白名单**逐个文件写**，发布前 `npm pack --dry-run` 核对。

**语言**：`docs/design.md` 与本文中文，README 双语，**代码与注释英文**；新增文案同时补 `lib/i18n.js` 的 `zh` 与 `en`（有测试检查键完整性）。

## 七、进一步阅读

| 想了解 | 去哪 |
|---|---|
| 为什么这么设计、每条需求落在哪个原语 | `docs/design.md`（**权威**） |
| 模型怎么用这个插件 | `skill/peer-session/SKILL.md` |
| 真机验过什么、怎么验的 | `docs/design.md` §12 + 本文 §二 |
| 安装/配置/数据边界 | `README.zh.md` / `README.md` |
| 完整历史与逐次推理 | `git log`、`git tag -n`（含 `v1.3.1`） |
