# dsh-role-bus

把两个（或更多）**并行的 DSH 会话**绑成一对角色：一个负责设计，一个负责实现。
两边通过项目里的 `.dsh/mail/` 交接工单，各自只能碰自己该碰的工具和文件。

解决的问题很具体：开两个会话分别做设计和实现时，模型并不知道对面存在。
它会把「该交给对方的事」自己做完，或者反复改对方的文件。role-bus 给每个会话
注入一条角色边界，并在工具调用真正发生前拦住越界操作。

- **工单邮箱**：`mail_post` / `mail_inbox` / `mail_ack` 三个工具，消息以 JSONL
  追加到项目内，谁都能读到，不依赖内存或网络。
- **角色边界**：按 agent preset（DSH 的「会话模板」，决定一个会话有哪些工具、
  什么系统提示）把会话映射成角色；越界的工具调用直接拒绝，写文件按路径白名单
  放行。
- **状态戳**：工单带上状态文件的短哈希，收件方能看出「这条工单是基于旧版本提的」。

## 安装

```bash
npm install dsh-role-bus
```

然后在 profile 的 `dsh.profile.bundles` 里加上 `dsh-role-bus`。插件自带
`cordis.patch.yml`，会把自己插入装配；角色配置默认是示例，需要按你的 preset 改。

本地开发也可以用 `link:` 依赖直接指向插件目录。

## 配置

完整示例（这些就是默认值，整块替换，不要只写 delta）：

```yaml
- insert:
    - id: role-bus
      name: dsh-role-bus
      config:
        mailDir: .dsh/mail
        refreshMs: 1000
        maxInject: 8
        stateFiles:
          - memory/project-state.md
        roles:
          designer:
            label: 设计会话
            presets: [design]
            denyTools: [ops_bash, ops_pwsh]
            writeAllow: [README.md, design, memory/rules.yaml]
            writeDeny: [memory/project-state.md]
          implementer:
            label: 实现会话
            presets: [standard, studio]
            denyTools: []
            writeAllow: []
            writeDeny: []
```

| 字段 | 说明 |
| --- | --- |
| `mailDir` | 邮箱目录，相对会话工作目录。默认 `.dsh/mail`。 |
| `refreshMs` | 邮箱重新读取的间隔，毫秒，最小 200。默认 1000。 |
| `maxInject` | 每轮最多在提示里列几条未读。默认 8。 |
| `stateFiles` | 参与版本戳的文件，相对工作目录。默认空。 |
| `roles.<name>.label` | 显示给模型的角色名。 |
| `roles.<name>.presets` | 哪些 preset id 属于这个角色；`presets` 不含角色名时，角色名本身也算一个 preset。 |
| `roles.<name>.denyTools` | 直接禁用的工具名。 |
| `roles.<name>.writeAllow` | 可写路径，相对工作目录；目录递归，文件精确。空数组表示不限制写入。 |
| `roles.<name>.writeDeny` | 禁写路径，优先于 `writeAllow`。 |
| `roles.<name>.writeTools` | 追加的「具名写工具」。自定义写工具不在内置清单里时写这里。 |

配置类型写错会在加载时直接报错（fail-fast），不会静默退化成空数组。
`writeAllow` / `writeDeny` / `denyTools` 允许写成单个字符串，会被当成单元素数组。

## 角色怎么绑定

角色在 **agent 创建时**按当时的 preset 快照一次，注入、工具、守卫共用这份快照。
DSH 的会话 composition 不会在运行中热切换，所以：

> 想换角色，请新开一个会话。中途切 preset 不会改已绑定会话的角色。

这一条是刻意的：如果监听 preset 变化重新挂载，会出现「提示按新角色渲染、工具还是
旧角色」的半新半旧状态，比不换更糟。

## 工具

- `mail_post(to, subject, body, kind?, refs?)`：给另一个角色发工单。不能发给自己。
- `mail_inbox(status?, limit?, withBody?)`：读自己的收件箱，默认只列未回执的。
- `mail_ack(id, action, evidence?, note?)`：回执。`action=done` 必须带 `evidence`
  （commit sha、测试输出、文件路径都行）。

`kind` 取 `task` / `decision` / `question` / `report`，只是分类标签，不强制流程。

## 边界与已知限制

- **守卫是工具层的，不是沙箱。** 它只能拦「经过工具注册表的调用」。如果某个角色
  被允许用 shell（`ops_bash` 等），它可以在 shell 里做任何事；设计类角色默认被
  `denyTools` 禁掉 shell，就是为此。
- **写路径白名单只对能被识别的写工具生效。** 内置清单覆盖 `write` / `edit` /
  `multi_edit` / `apply_patch` / `ops_write_file(s)` / `ops_edit_file`。其它工具
  按「名字含写动词 + 参数里有 `path` / `file_path` / `filePath` 等路径键」判断；
  自定义写工具建议直接写进 `roles.<name>.writeTools`，比启发式可靠。
- 启发式会放过「名字里没有写动词」的写工具，也会误拦同名的只读工具。它是兜底，
  不是保证。
- `evidence` 只要求非空，不验证内容真实性。
- 单机文件，不做多机同步；没有 UI。
- 两个会话同时给同一个 id 回执时，后写的覆盖先写的（折叠时取最后一条）。

## 兼容性

只使用公开的 Service 与 Event：`systemPrompt.context/section`、`tools.register`、
`tools.guard`、`agentPresets.composedPreset`、`workingDirectory.ensure`、
`agents.list/get`、`agent/created`。能力探测集中在 `compat.js`：

| 缺什么 | 行为 |
| --- | --- |
| `systemPrompt.context/section` | 不注入未读摘要，工具与守卫照常 |
| `agentPresets.composedPreset` | 无法映射角色，插件不激活 |
| `tools.register` | 不注册邮箱工具，守卫照常 |
| `tools.guard` | 注册不了边界，只留提示与工具 |
| `workingDirectory.ensure` | 拿不到可靠 cwd，跳过绑定（绝不拿 `process.cwd()` 顶替） |

`agent/created` 的回调**永不 reject**：DSH 里这个 listener 抛错会让新会话创建失败，
所以绑定失败只记日志。拿不到 preset 时会做有限次重试。

## 测试

```bash
npm test
```

自测用假 ctx / 假 agent 驱动，不依赖真实项目，覆盖配置校验、白名单、启发式、
并发去重、失败回滚、能力降级与邮箱全流程。

## 许可证

MIT
