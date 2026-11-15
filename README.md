# dsh-model-prompts

Per-model prompt blocks for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

给不同的模型注入不同的行为约束，比如"DeepSeek 回答简短些"、"走 Anthropic 路由时先给计划"。
文本来自本地配置文件，插件把它渲染成一条 **user 角色的运行时快照**，并且**只在渲染结果变化时才重新追加**——改完文件下一个模型请求就生效，稳定前缀（系统提示 + 历史）的缓存不会被打断。

从 pi 扩展 [`proper-model-prompts`](https://github.com/sharaf-nassar/proper-pi-extensions/tree/main/proper-model-prompts) 移植。设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

```bash
dsh plugin add github:nmapleaf/dsh-model-prompts
```

插件通过 `cordis.patch.yml` 自动挂载，装完即生效。想临时关掉就把配置里的 `enabled` 设为 `false`。

> **尚未发布到 npm**：`dsh plugin add dsh-model-prompts` 会 404，请用上面的 GitHub 源安装。
> 本地开发可以指向源码目录：`dsh plugin add /path/to/dsh-model-prompts`（pnpm 会建 `link:` 依赖，
> 改代码不用重装；但每次 `pnpm add` 都可能把 `@deepseek-ai/schemastery` 提到 profile 根目录，
> 装完记得确认共享层软链还在）。

## 配置

两层：**机制层**是插件配置，**内容层**是 JSON 文件。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册 |
| `order` | `270` | 快照在运行时上下文里的排序 |
| `globalRoot` | `~/.dsh/model-prompts` | 全局层目录，读取其中的 `*.json`（不递归） |
| `projectFile` | `.dsh/model-prompts.json` | 项目层文件，相对会话工作目录 |
| `allowProject` | `false` | 项目层总闸 |
| `maxBytes` | `12288` | 单文件上限 |
| `maxTotalBytes` | `24576` | 整次装配上限 |

内容层：

```json
{
  "prompts": [
    {
      "models": ["*"],
      "position": "append",
      "text": "Treat this block as a constraint on the current run, not as a suggestion."
    },
    {
      "models": ["anthropic/*", "!anthropic/claude-3*"],
      "file": "prompts/anthropic.md"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `models` | 是 | 通配模式。匹配 `provider/model` 或裸模型 id，大小写不敏感；`!` 前缀为排除项 |
| `position` | 否 | `append`（默认）或 `prepend`，决定多条命中时的拼接顺序 |
| `when` | 否 | `{ "origin": "subagent" }` / `{ "agentPreset": "…" }` / `{ "delegationDepthMin": 1 }`，并列 AND |
| `text` | 二选一 | 正文 |
| `file` | 二选一 | 正文文件路径。相对路径以所在 JSON 文件的目录为基准，且必须落在该层根目录内 |

可直接复制的样例见 [examples/model-prompts.json](examples/model-prompts.json)。复制到 `~/.dsh/model-prompts/` 即可。

## 生效时机

**下一个模型请求**生效，不是"下一轮对话"。DSH 每个 step 都会重新解析运行时上下文，所以工具调用之后的下一步就能看到新文本；文本没变时不会重复追加（由宿主的深等去重保证）。

## 安全

- 项目层默认关闭；开启后其中的 `file` 引用必须落在项目目录内。
- 所有路径都先 `realpath` 再判定包含关系，符号链接逃逸会被拒绝。
- FIFO、设备文件、目录一律拒绝（先 `stat` 再读，不会挂死）。
- 正文里的 `<system-reminder` / `</system-reminder` 会被转义，前后加边框声明。
- 单文件与总装配都有字节上限。

## 开发

```bash
npm test
```

单元测试覆盖匹配、校验、分层加载与渲染，不依赖 DSH 运行时。
