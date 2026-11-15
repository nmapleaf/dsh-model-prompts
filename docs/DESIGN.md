# dsh-model-prompts · 设计书 v2

把 pi 扩展 [`proper-model-prompts`](https://github.com/sharaf-nassar/proper-pi-extensions/tree/main/proper-model-prompts) 的语义移植到 DeepSeek Harness。

- **注入通道**：`systemPrompt.context()` —— 渲染成一条 user 角色尾消息，文本变化才追加。
- **内置块**：零。仓库不带任何第三方指导材料的改写文本。
- **基准版本**：DSH `0.2.2-rc.2`（源码路径以 `@deepseek-ai/dsh*/lib/` 为准）。
- **范围**：设计定稿，不含实现代码。

---

## 0. 不变量

六条硬约束。违反任何一条，插件会在某一类输入下静默劣化，而不是报错。

| # | 不变量 | 违反后果 |
|---|---|---|
| 1 | **provider 绝不抛**：`text()` 内不 throw，出错返回 `""` | `resolveContext` 的调用点（`assemble`、`refreshContext`）没有 try/catch，异常会冒到 turn 级 catch，整轮报错 |
| 2 | **text 是纯函数**：同一输入必得同一输出 | 去重靠 `deepEqualJson`，不纯就每步重发整份快照 |
| 3 | **不自建去重**：不缓存"上次注入的文本" | `RuntimeContextProjection` 已按 `sections` 深等去重，自建去重会与宿主语义分叉 |
| 4 | **`interpolate: false`** | 默认 `true` 会解析 `{{…}}`，正文含 `{{` 直接被当变量引用而抛错 |
| 5 | **`required: true`** | `includeRuntimeContext: false` 或任一 `suppressRuntimeContext()` 会把非 required 的 context 整条抹掉 |
| 6 | **注册期 fail loud**（唯一例外见下） | 配置非法却静默不注册，用户以为插件在工作 |

不变量 6 的例外：`already registered` 必须降级为 no-op（返回空 disposer）。理由——插件热重载会合法地二次注册同名条目（`dsh-agent-md` 已踩过这个坑）。其余注册期错误必须冒出去。

---

## 1. 文件清单

```
dsh-model-prompts/
├── package.json
├── cordis.patch.yml
├── README.md
├── LICENSE
├── lib/
│   ├── index.js        # 边界层：入口、Config、注册、兜底、诊断
│   ├── settings.js     # 机制层配置归一化
│   ├── layers.js       # 内容层：加载、realpath/stat、合并
│   ├── entry.js        # 条目结构校验 → Result
│   ├── match.js        # matchesModel / selectsModel / when（纯）
│   ├── render.js       # 条目 → 最终正文（纯）
│   └── errors.js       # ConfigError 与诊断结构
├── examples/
│   └── model-prompts.json   # 文档性样例，不参与运行时、不被打包加载
└── docs/
    └── DESIGN.md
```

| 文件 | 职责 | 预估行数 |
|---|---|---|
| `lib/index.js` | 边界层：注册 context、`ctx.effect` 生命周期、错误兜底、诊断输出 | ~120 |
| `lib/settings.js` | schemastery `Config` → 归一化 `Settings` | ~60 |
| `lib/layers.js` | 全局层/项目层读取、安全校验、合并 | ~120 |
| `lib/entry.js` | 单条目字段校验，产出 `Result` 而非抛错 | ~90 |
| `lib/match.js` | 模型通配匹配与排除、`when` 求值 | ~70 |
| `lib/render.js` | 条目排序、正文拼装、转义 | ~55 |
| `lib/errors.js` | `ConfigError`、诊断结构 | ~20 |

生产 **约 545 行**；测试 `match` 80 / `entry` 70 / `layers` 100 / `render` 50，**约 300 行**。

### 1.1 打包元数据

`package.json`：

```json
{
  "name": "dsh-model-prompts",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh": ">=0.2.2-rc.1 <0.2.3-0",
    "@deepseek-ai/dsh-system-prompt": "0.2.2-rc.2",
    "@deepseek-ai/schemastery": "~3.19.0"
  }
}
```

`cordis.patch.yml` 只有一行：

```yaml
- insert: [{ id: model-prompts, name: 'dsh-model-prompts' }]
```

`name` 必须是**裸包名**——`dsh-web` 的客户端扫描靠它解析插件元数据。本插件没有客户端资源，因此不声明 `dsh.client`。

---

## 2. 配置

两层：**机制层**管"插件怎么跑"（schemastery，随插件加载），**内容层**管"注入什么文本"（JSON 文件，每请求重读）。

### 2.1 机制层

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭即不注册。走 `ctx.effect`，改配置重注册，无需重启 |
| `order` | `270` | 见 §3 |
| `globalRoot` | `~/.dsh/model-prompts` | 目录，读取其中的 `*.json`（不递归） |
| `projectFile` | `.dsh/model-prompts.json` | 相对 `session.header.cwd` |
| `allowProject` | `false` | 项目层总闸，见 §9 |
| `maxBytes` | `12288` | 单个文件上限 |
| `maxTotalBytes` | `24576` | 整次装配上限（含所有层、所有条目） |

> v1 的 `embedDefaults` 与 `defaultsOnError` **已删除**：零内置块之后二者失去对象，出错策略固定为"空正文 + 一次性诊断"。

### 2.2 内容层

顶层只接受 `prompts` 一个键：

```json
{ "prompts": [ { "models": ["*"], "position": "append", "text": "…" } ] }
```

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `models` | 是 | 非空字符串数组 | 通配匹配，见 §5 |
| `position` | 否 | `"append"`（默认）/ `"prepend"` | 仅在单条目装配顺序上有意义，见下 |
| `when` | 否 | `{ origin?, agentPreset?, delegationDepthMin? }` | 替代 pi 的 `modes`，依据 `SessionHeader` |
| `text` | 二选一 | 非空字符串 | 经 `trim` 后必须非空 |
| `file` | 二选一 | 路径 | 支持 `~/`；相对路径以**所在 JSON 文件目录**为基准 |

`position` 的语义：同一模型命中多条时，`prepend` 条目排在正文最前、`append` 排在最后；组内按配置文件中的出现顺序稳定排序。它不会改变 context 在消息流中的位置——那由 `order` 决定。

### 2.3 与 pi 的差异

| pi | v2 | 理由 |
|---|---|---|
| 顶层 `defaults: true` | 删除，出现即校验失败 | 无内置块 |
| 顶层 `offerForegroundSubagents` | 删除，出现即校验失败 | DSH 子代理同进程，无需清单 hack |
| `modes: ["tui","rpc","json","print"]` | `when` | DSH 没有 pi 的运行模式，只有 profile 与 SessionHeader |
| 单一全局配置文件 | 全局层 + 项目层 | `header.cwd` 天然可读，且项目层默认关闭 |
| 未知键抛 `ConfigError` | 保留 | 宁可当场报错，也不要静默忽略 |

迁移提示文案：文件里出现 `defaults` 或 `offerForegroundSubagents` 时，诊断信息必须写明"内置块已移除，请把需要的文本显式写进 `prompts`"，而不是只说"未知键"。

### 2.4 合并顺序

```
内置（空） → 全局层（按文件名 code-unit 升序） → 项目层
```

层内条目按出现顺序保留，**层内允许正文重复**（同一份正文服务不同 `models` 是合法写法）；只有**跨层**命中同一 identity 才整条拒绝（§9 F4）。总字节数按上述顺序累加，超过 `maxTotalBytes` 时**丢弃后加载的条目**并记一条诊断，不整体失败。

---

## 3. 注册契约

```js
ctx.effect(() => ctx.systemPrompt.context({
  name: "model-prompts",
  order: 270,
  text: (context) => render(/* … */),
  interpolate: false,
  required: true,
}), "model-prompts:context")
```

| 参数 | 值 | 依据 |
|---|---|---|
| `name` | `"model-prompts"` | 全局命名空间唯一；同名注册抛 `already registered`，按不变量 6 降级为 no-op |
| `order` | `270` | `WORKING_DIRECTORY` 100 → `SUBAGENT_DELEGATION` 120 → `HARNESS_SOURCE` 200 → `WEB_SURFACE` 210 之后；排在最后 = 离生成最近，同时给别的插件留出更靠后的位置 |
| `text` | `(context) => string` | `context.agent`（模块增强）、`context.modelSelection`、`context.scope` |
| `interpolate` | `false` | 不变量 4 |
| `required` | `true` | 不变量 5 |

### 3.1 为什么不是 `section()`

pi 原版写系统提示（`systemPromptOptions.sections` / `forceSystemPrompt`），因为 pi 没有动态 context 机制。DSH 有，而且两者的缓存代价差一个数量级：

| 事实 | 源码位置 |
|---|---|
| context 的 `text` 每次请求重算 | `dsh-system-prompt/lib/index.js:326-348`（`refreshContext`） |
| 文本没变则不追加 | `dsh-agent-loop/lib/index.js:338-341`（`deepEqualJson`） |
| 变化时追加为 user 消息，永不写 system 节点 | `dsh-agent-loop/lib/index.js:873-879` |
| section 变化时会**重写 message 0** 并清空后续 system 节点 | `dsh-agent-loop/lib/index.js:262-287`，破坏分支在 `:275` |
| `startsSeries` 在新回合第一步或 surface 内容代际变化时为真 | `dsh-agent-loop/lib/index.js:865`、`:1040` |

`startsSeries` 的两项条件——`firstAttempt && decision.startsRequestSeries`、以及 `requestSurfaceGeneration !== session.surface.contentGeneration`——在真实会话里几乎总为真（用户消息落库、工具结果落库都会改变代际）。也就是说 section 通道下**任何文本变更都要重写 message 0**，整份系统提示 + 全部历史的前缀缓存失配。context 通道则永远只在尾部追加。

结论：动态文本走 context；硬约束若确有必要，另行设计 section 通道（本版不做）。

---

## 4. 分层与边界规则

| 区 | 文件 | 允许的副作用 |
|---|---|---|
| 纯函数区 | `match.js`、`render.js` | 无。不读盘、不看时钟、不取随机、不依赖 `Object.keys` 顺序与 locale |
| 校验区 | `entry.js`、`errors.js` | 无。只产出 `Result`，不越过边界抛错 |
| I/O 区 | `layers.js` | 文件系统读取、`realpath`、`stat`、合并 |
| 边界层 | `index.js` | 注册、兜底、日志 |

**R1 不做正文缓存。** `text()` 只做 `stat` + `readFileSync` + 纯渲染，不持有任何跨调用的文件状态。早期版本按 `(realpath, mtimeMs, size)` 缓存正文，实测在同一文件系统上对同尺寸文件做快速改写后 `mtimeNs` 完全不变，缓存会让"改完文件下一个请求生效"这条核心承诺失守；而文件本身受 `maxBytes`（默认 12 KiB）约束，每个 step 重读两份小文件的代价远低于一次模型请求。`text()` 每个 step 至少被调两次（`assemble` 一次、每次 attempt 的 `refreshContext` 一次），因此函数体仍须廉价：不做目录扫描、不递归、不 `localeCompare`。

**R2 错误面分层。** 注册期（`index.js`）fail loud，配置非法就不注册；运行期（`text()` 内部）吞掉一切，降级为空正文。这条边界必须写进代码注释——否则下一个维护者一定会在 provider 里加 `throw`。

**R3 诊断落点。** 边界层持有 `ctx.logger`（取不到就 no-op），**按消息文本去重**并限制每实例最多 5 条 warn；另有一条 info（条目数、总字节、各层来源路径）。DSH web 是长驻进程，"每会话只报一次"会让首条错误之后的诊断永久不可见——所以去重键是消息本身，不是会话闸门。禁用 `console.*`。

**R4 空正文的真实语义。** 返回 `""` 后，`renderContextSections` 会 `.filter((s) => s.text.length > 0)`（`dsh-system-prompt/lib/index.js:153-157`）把整段丢掉，不留空壳；但若因此 `sections` 为空，`RuntimeContextProjection` 会追加一条 `CLEARED` 消息（`dsh-agent-loop/lib/index.js:340`）。**这是预期行为**，不是 bug。

**R5 纯函数禁令清单。** `Date` / `performance.now` / `Math.random` / 依赖插入顺序的 `Map`·`Object.keys` / `localeCompare` / 读 `process.env` 动态值。违反任何一条，去重失效，每步重发。

---

## 5. 从 pi 复用的纯逻辑

原实现 `model-prompts.ts:73-218` 只依赖 `node:fs` / `node:os` / `node:path`，可整段搬运。

| 函数 | 复用度 | 改动 |
|---|---|---|
| `matchesModel(pattern, model)` | 100% | 无 |
| `selectsModel(patterns, model)` | 100% | 无 |
| `readText(path)` | 95% | 增加 `isFile()` 与 `size` 上限（§9 F2） |
| `readPromptFile(file, base)` | 80% | 同上，`~` 仍只对全局层开放 |
| `parseEntry` | 70% | `modes` → `when`，其余校验原样 |
| `readConfig` | 60% | 拆成两层，顶层键收窄 |
| `loadPrompts` | 40% | 两层合并 + 总量上限 |
| `promptsFor` | 60% | `(entries, modelSelection, header)` 而非 `(entries, model, mode)` |

**删除**：`applyPrompts`、`claimBuild`、`isScopedInstall`、`offerForegroundSubagents`、`withSettingsLock`、`addToForegroundList`、`listsPackage`。这些全是为 pi 的 `before_agent_start` 与子代理扩展清单服务的，DSH 里没有对应问题。

匹配规则（照抄即得）：

- `*` 通配任意段；其余字符按字面，转义 `[.+?^${}()|[\]\\]`；
- 大小写不敏感，测试 `${provider}/${id}` 与裸 `id` 两种形态；
- `!` 前缀为排除项，可出现在数组任意位置；至少一个非 `!` 项命中、且无任何 `!` 项命中才算选中；
- 数组全为 `!` 项 → 校验失败。

`when` 求值（三键，全为可选且并列 AND）：

| 键 | 来源 | 语义 |
|---|---|---|
| `origin` | `session.header.origin` | 精确相等，如 `"subagent"` |
| `agentPreset` | `session.header.agentPreset` | 精确相等 |
| `delegationDepthMin` | `session.header.delegationDepth` | `>=` 比较 |

---

## 6. 宿主对接层

需要重写的十处（pi 语义 → DSH API）：

| # | pi | DSH |
|---|---|---|
| 1 | `properModelPrompts(pi, configPath, packageDir)` | `export const name` / `inject = ["systemPrompt"]` / `Config` / `apply(ctx, config)` |
| 2 | `pi.on("before_agent_start", …)` | `ctx.systemPrompt.context({…})` |
| 3 | `event.systemPromptOptions.sections[SECTION] = append` | 无对应；由 context 通道承担 |
| 4 | `ctx.model` | `context.modelSelection`（`{ provider, model, reasoningEffort? }`） |
| 5 | `ctx.mode`（tui/rpc/json/print） | `session.header`（`origin` / `agentPreset` / `delegationDepth`） |
| 6 | `getAgentDir()` | `Config.globalRoot` |
| 7 | `ctx.ui.notify(…, "error")` | `ctx.logger`，按消息去重、每实例 ≤5 条 |
| 8 | `claimBuild` Symbol 打标防双份加载 | 不需要；同名注册由不变量 6 兜底 |
| 9 | `pi-subagents` 扩展清单写入 | 不需要；同进程子代理各自带 `modelSelection` 调 `assemble` |
| 10 | `ctx.ui.confirm` 一次性询问 | 不需要；`allowProject` 是静态开关 |

读取 cwd 的方式（与 `dsh-agent-md` 一致）：

```js
const cwd = context?.agent?.session?.header?.cwd;
```

`AssembleContext` 本体只有 `scope`/`signal`，`agent` 与 `modelSelection` 是 `dsh-agent` 通过模块增强加上去的（`dsh-agent/lib/types/runtime-types.d.ts:12-19`），所以必须用可选链，不能假设它一定存在。

---

## 7. 时序

| 场景 | 谁被调用 | 结果 |
|---|---|---|
| 新回合第一步 | `assemble()` 解析 context → `project()` | 快照追加在用户消息之后 |
| 同回合后续 step（工具结果之后） | `assemble()` 再解析；文本变了才追加 | 追加一条带 "It replaces earlier versions…" 前言的快照 |
| 同一步重试 | `refreshContext()` 再解析；变了在 `:879` 追加 | 同一 step 内也能更新 |
| 改配置文件或正文 | 下一次请求 | 通常就是同一回合的下一个 step |
| 切模型 | 下一 step 的 `assemble` 用新的 `modelSelection` | 新条目命中 |
| 子代理 | 各自的 `modelSelection` | 独立命中，互不干扰 |
| 关闭插件 | 不再注册 | 已追加的快照留在历史里，等压缩清理 |

**生效粒度必须写进 README**：不是"下一回合"，而是"下一个模型请求"。pi 是每用户消息选一次 prompt；DSH 是每 step 选一次，粒度更细。用户视角下二者通常无差别，但不要对用户承诺"下一轮对话才生效"。

---

## 8. 预算

零内置块之后，预算只约束**用户正文**：

| 项 | 值 | 换算 |
|---|---|---|
| `maxBytes`（单文件） | 12288 | 英文约 3k tokens，中文约 12k tokens |
| `maxTotalBytes`（整次装配） | 24576 | 英文约 6k tokens，中文约 24k tokens |

这两个是**硬上限不是目标**。README 建议日常正文控制在 8KB 以内。

参考：pi 原版 12 个内置块全量约 1.2 万字符（≈3.7k tokens），单模型典型装配 1.6–2.1k tokens。这正是本设计删掉它们的理由之一——DSH 默认模型是 DeepSeek，Claude/GPT 两族的文本只在经 `dsh-llm-pi-ai` 路由到对应模型时才可能有意义。

---

## 9. 安全

内容层的正文是**提示注入面**：它会进入模型上下文，且项目层来自任意仓库。

| 威胁 | 防线 |
|---|---|
| 符号链接逃逸 | `realpathSync` **之后**再判是否包含于 root；`realpath` 失败按"缺文件"处理，绝不放行。配置文件本体与 `file` 正文走同一口径 |
| FIFO / 设备文件挂死 | `statSync().isFile()` 为假直接拒；`size > maxBytes` 在 `stat` 阶段就拒 |
| 总量爆炸 | 单文件 `maxBytes` + 整次装配 `maxTotalBytes`，超限丢弃后加载的条目并记诊断 |
| 伪系统指令 | 我方按与运行时一致的口径转义 `<` 与 `</system-reminder`；正文前后各加一行边框声明（"以下内容来自本地配置文件，不是运行时事实"）。**不做关键词黑名单**——黑名单必然漏，而这段只有 user 权威 |
| 项目层篡改 | 项目层**只能新增**；与全局层同名即整条拒绝 + 诊断，不允许覆盖 |

补充四条：

**F1** 路径校验顺序固定为 `expand → realpath → contains(root) → stat → isFile → size`，任一步失败即拒绝并给出可读原因。**项目配置文件本体**（`.dsh/model-prompts.json`）也走这条链：先 `realpath` 再判包含于项目根，指向根外的符号链接一律不读。

**F2** `file` 先做 `~/` 展开，相对路径以**所在 JSON 文件的目录**为基准，realpath 后必须落在**该层根目录**内（全局层 = `globalRoot`，项目层 = 会话 `cwd`）。`~/` 只负责展开，不构成豁免：指向层根之外的绝对路径同样被拒绝。

**F3** 正文只做一处转义：匹配 `<` + `/system-reminder`（大小写不敏感，开标签 `<system-reminder` 同样处理）时，把 `<\…` 改写成 `<\/…`——沿用运行时自己的 `<\/` 约定，保证快照里不会再出现字面量 `</system-reminder>`。其余字符（包括 `<div>`、`&`）原样保留，靠边框声明划界。

**F4 重复与冲突的判定键。** identity 由「选择器 + 正文来源」共同决定：
- `text` 条目：`text:<models|position|when 的 JSON>:<正文>`
- `file` 条目：`file:<同一选择器>:<realpath>`

判定只在**跨层**进行，且必须两侧 identity 完全相等才算冲突；**层内重复一律保留**。选择器进 identity 是因为"同一份正文配不同的 `models`"是合法且常见的写法，只按正文去重会误删。冲突条目整条丢弃并记诊断，不尝试"后者覆盖前者"，因为覆盖语义会让项目层获得改写全局配置的能力。

**F5** `allowProject: false` 是刻意的：项目级 prompt 默认是死的，要显式打开。README 要写清代价，并说明本项目不做"首次信任"弹窗——DSH 没有 `ctx.ui.confirm` 的等价物。

---

## 10. 测试

单元（`match`）

1. `*` 命中任意模型
2. `${provider}/${id}` 与裸 `id` 两种形态都命中
3. 正则元字符按字面处理（`gpt-4.1` 不会匹配 `gpt-4x1`）
4. 排除项生效（`["*", "!deepseek/*"]`）
5. 全为排除项 → 校验失败

单元（`entry`）

6. `models` 缺失 / 空数组 / 全为 `!`
7. `text` 与 `file` 同时存在 → 失败
8. 二者都缺 → 失败
9. `position` 非法值、`when` 未知键
10. `file` 解析后正文为空 → 失败

单元（`layers`）

11. 文件不存在 → 视为空层，不报错
12. `EACCES` → `ConfigError`
13. `file` 正文符号链接指向层根之外 → 拒绝
14. 全局层 `*.json` 本体是指向根外的符号链接 → 拒绝，且不读其正文
15. FIFO / 目录 → 拒绝
16. 单文件超 `maxBytes` → 拒绝
17. 总字节超 `maxTotalBytes` → 截断，此后所有条目丢弃，只记一条诊断
18. 项目层与全局层 identity 相同 → 整条拒绝
19. 同一层内两条正文相同、选择器不同 → 两条都保留
20. 同尺寸快速改写后再次 `collect` → 读到新正文（无缓存）

单元（`render`）

21. 排序稳定、空文本剔除、`</system-reminder>` 转义
22. 同一输入连续两次调用结果深等（纯函数）

样例

23. `examples/model-prompts.json` 可解析、每条都通过 `validateEntry`、无 `\b(19|20)\d{2}\b` 形式的日期、无 pi 专有词（`pi-subagents`、`Pi compacts`）

需要 DSH 运行时，不进单元测试

24. 集成：`RuntimeContextProjection.project()` 对不同输入两次返回消息、对相同输入返回 `undefined`（由宿主的 `deepEqualJson` 保证，插件不重复实现）
25. 重复注册 → 降级为 no-op；坏文件只损失自己，其余条目继续渲染并留一条 warn

### 10.1 实测记录（2026-11-15，dsh 0.2.2-rc.2）

用一个一次性 `headless` profile 做了端到端冒烟，全程不碰在跑的 `web` profile。步骤与观察：

1. `dsh plugin --profile pmp-smoke add <repo>` 后 `--dump-config` 出现 `id: model-prompts` / `name: dsh-model-prompts`，说明 bundle patch 生效。
2. `dsh --profile pmp-smoke --help` 退出码 0，stderr 无输出：插件挂载、注册均无错误。
3. 用 `--patch` 把 `globalRoot` 指到 `/tmp/pmp-smoke-prompts`，写入一条 `SMOKE-MARKER` 正文。问模型"暗号是什么"，回答 `SMOKE-OK`；模型思维链引用了边框声明原文，证明整块快照进入了上下文。
4. 同一 session 连续四轮：首轮注入快照 1（原地正文）；改正文后下一轮注入快照 2，开头是"…It replaces earlier versions of this context…"；再跑一轮不改文件，**没有**第三份快照。

结论：`user/message` 里 7 条消息、仅 2 条是 runtime-context 快照——"改文件下个请求生效"与"文本不变不重复追加"两条承诺都在真实运行时兑现；第 25 条的降级路径由 `test/registration.test.js` 覆盖。

注：headless profile 起手读不到 `~/.dsh/.credentials.yaml` 里的 key（web 由 credentials 服务注入），实测时是临时从该文件取值注入环境变量完成的。这属于 profile 凭据注入的差异，与本插件无关。

---

## 11. 样例维护

`examples/model-prompts.json` 是**文档，不是运行时资产**：不打进 bundle、不被读取、不随插件升级覆盖用户配置。

三条内容规则（收窄后）：

1. **无日期、无版本**——prompt 长期驻留，写死"截至 2026-09"就是定时炸弹；
2. **无工具名歧义**——要么不点名工具，要么只点名 DSH 真实存在的名字（`read` / `edit` / `bash` / `subagent`…），不许出现 pi 专属叙述；
3. **不与人格重复**——DSH 已注入 `AGENT.md` 与 deployment persona，样例只写模型特定行为，不复述语气人设。

风格建议（不校验）：避免 em dash、避免全大写强调。

维护流程：改样例 → 人工 copy 到 `~/.dsh/model-prompts/` → 下一个模型请求生效。样例与用户实际配置失同步是**预期状态**，README 要写明"样例只是起点"。

---

## 12. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 骨架** | 包结构、`cordis.patch.yml`、`Config`、注册一条空 context | 装上后日志出现一条 info；`dsh` 启动无报错；关闭 `enabled` 后不再注册 |
| **M2 内容** | `entry` / `match` / `layers` / `render` + 校验 + §9 安全加固 | 测试 1–20 全绿；故意放入符号链接与 FIFO 均被拒 |
| **M3 打磨** | 诊断文案、热更新、README、样例、发布前只读 review | 测试 21–22 绿；README 写明"下一个请求生效"；review 无阻塞项；真实 dsh 冒烟见 §10.1 |

---

## 13. 非目标

- 不做 `section()` 通道（含 prepend/complete 语义）
- 不做前台子代理扩展清单、不做包安装侦测
- 不做模板变量、不做多套配置按项目切换之外的场景
- 不做 UI：没有 web 客户端资源，也不读 TUI 输入
- 不内置任何第三方指导文本

---

## 14. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 生效粒度被理解成"下一回合"，实际是"下一个请求" | README 与诊断文案统一措辞 |
| R2 | authority 降级：从系统提示降为 user 尾消息 | 接受。每模型文本属行为风格指导而非安全约束；正文用 "constraint on the current run, not a suggestion" 强措辞补偿 |
| R3 | 宿主整份快照重发，不是只发本插件那段 | 无法规避（`RuntimeContextProjection` 以 `sections` 为单位）。缓解：正文保持短，`maxTotalBytes` 兜底 |
| R4 | 用户正文里写了时间戳 → 每步重发 | 文档 + 样例 + §10 的日期检测测试 |
| R5 | 宿主未来调整 `required` / 去重语义 | peerDeps 上限锁到 `<0.2.3-0`，升级前跑 §10 集成用例 |
| R6 | 与其它 context 插件重名 | 名字唯一；重复注册降级为 no-op 并记一条 warn |
| R7 | 样例与用户实际配置失同步 | 定位为"文档"，README 声明以用户配置为准 |

---

## 附录 A · pi → DSH 概念映射

| pi | DSH | 备注 |
|---|---|---|
| `before_agent_start` | `systemPrompt.context()` 的 `text(context)` | 每 step 调用 |
| `systemPromptOptions.sections[SECTION]` | 无 | 由 context 承担 |
| `forceSystemPrompt` | `PromptSection.complete` | 本版不用；多生效会 fail loud |
| `ctx.model` | `context.modelSelection` | 模块增强字段，需可选链 |
| `ctx.mode` | `header.origin` / `agentPreset` / `delegationDepth` | 无 1:1 对应 |
| `getAgentDir()` | `Config.globalRoot` | 用户可改 |
| `ctx.ui.notify` | `ctx.logger` | 按消息去重、每实例 ≤5 条 |
| `claimBuild` | 无 | 同名注册兜底替代 |
| `pi-subagents` 清单 | 无 | 同进程子代理自动继承 |

---

*本设计只覆盖插件行为；实现与发布流程另行约定。*
