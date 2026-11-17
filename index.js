// role-bus: 跨会话工单邮箱 + 角色边界。
//
// 角色来自 agent preset id（agentPresets.composedPreset）。每个命中角色的 Agent 在
// 自己的 ctx 上获得：未读注入（systemPrompt.context，每轮重算）、三个邮箱工具、
// 以及一个同步守卫（禁工具 + 写路径白名单）。
//
// 存储只用两个只追加文件：messages.jsonl 与 acks.jsonl，状态由折叠得出，
// 从不重写文件，所以两个会话并发写不会互相覆盖。
//
// 兼容性：只用公开 Service / Event，能力探测集中在 compat.js。DSH 的 Agent
// composition 在运行中不热切换（切 preset 只影响之后新建的会话），所以角色在
// attach 时快照一次，注入、工具、守卫共用同一个快照——避免出现「注入按新角色
// 渲染、守卫还是旧角色」的半新半旧状态。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { probeAgent, probePlugin } from './compat.js'

export const name = 'role-bus'
// agentPresets 是硬依赖：没有它就无法把 preset 映射成角色，插件不激活。
// workingDirectory / agents 是可选能力，缺了走降级分支。
export const inject = ['tools', 'systemPrompt', 'agentPresets']

const ACTIONS = new Set(['read', 'done', 'rejected'])

// 已知的具名写工具。这些工具的参数里有路径，白名单可以直接拦。
// 不在清单里的工具走 looksLikeWrite() 启发式（见 makeGuard）。
const BASE_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'ops_write_file',
  'ops_write_files',
  'ops_edit_file',
])

// 设计类角色只允许碰 ops_ 开头的只读工具；其余 ops_ 工具一律当直通 shell 处理。
const OPS_READ_ALLOW = new Set([
  'ops_read_files',
  'ops_discover_tools',
  'ops_inspect_local_file',
])

const PROMPT_ORDER = 500

// resume 时 Agent 可能先挂到基础组合，随后才 rebind 到会话记录的 preset；
// 空 preset 和「preset 还没落到角色上」共用这一份重试预算。
const MAX_ATTACH_ATTEMPTS = 6

// 启发式写工具：名字里出现写动词 + 参数里带路径，两个条件都满足才当写工具。
// 这样 create_plan / update_goal 这类没有路径参数的规划工具不会被误拦。
const WRITE_VERBS = new Set([
  'write', 'edit', 'save', 'create', 'delete', 'remove', 'move', 'rename',
  'copy', 'append', 'update', 'patch', 'apply', 'mkdir', 'touch', 'rm', 'put', 'upload',
])
const PATH_ARG_KEYS = [
  'path', 'file_path', 'filePath', 'file', 'files',
  'dest', 'destination', 'source', 'target',
]

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 末尾被截断的半行直接忽略
    }
  }
  return out
}

function appendJsonl(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

function foldStates(acks) {
  const states = new Map()
  for (const ack of acks) {
    if (ack && typeof ack.id === 'string' && ACTIONS.has(ack.action)) states.set(ack.id, ack)
  }
  return states
}

function loadMailbox(dir) {
  return {
    messages: readJsonl(resolve(dir, 'messages.jsonl')),
    states: foldStates(readJsonl(resolve(dir, 'acks.jsonl'))),
  }
}

function asJsonText(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function statusOf(state, id) {
  return state.states.get(id)?.action ?? 'pending'
}

function describeValue(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

// 配置校验是 fail-fast：类型写错直接在加载时报错，不静默退化成空数组。
// 旧配置里把数组写成单个字符串是常见笔误，这里兼容成单元素数组。
function asStringList(value, where) {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map(String)
  }
  throw new Error(`role-bus: ${where} 必须是字符串数组（收到 ${describeValue(value)}）`)
}

function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('role-bus: 配置必须是对象')
  }

  const rawRoles = raw.roles ?? {}
  if (typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    throw new Error('role-bus: roles 必须是对象（角色名 → 角色配置）')
  }

  const roles = {}
  for (const [role, value] of Object.entries(rawRoles)) {
    if (!role) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`role-bus: roles.${role} 必须是对象`)
    }
    const presets = asStringList(value.presets, `roles.${role}.presets`)
    roles[role] = {
      label: typeof value.label === 'string' && value.label ? value.label : role,
      presets: presets.length > 0 ? presets : [role],
      denyTools: asStringList(value.denyTools, `roles.${role}.denyTools`),
      writeAllow: asStringList(value.writeAllow, `roles.${role}.writeAllow`),
      // 比 writeAllow 更细：可以点名具体文件，把它们从目录白名单里挖出去。
      writeDeny: asStringList(value.writeDeny, `roles.${role}.writeDeny`),
      // 追加的具名写工具：不在 BASE_WRITE_TOOLS 里的自定义工具写在这里。
      writeTools: asStringList(value.writeTools, `roles.${role}.writeTools`),
    }
  }

  const refreshMs = raw.refreshMs ?? 1000
  if (!Number.isInteger(refreshMs) || refreshMs < 200) {
    throw new Error('role-bus: refreshMs 必须是 ≥200 的整数（毫秒）')
  }
  const maxInject = raw.maxInject ?? 8
  if (!Number.isInteger(maxInject) || maxInject < 1) {
    throw new Error('role-bus: maxInject 必须是 ≥1 的整数')
  }
  const mailDir = raw.mailDir ?? '.dsh/mail'
  if (typeof mailDir !== 'string' || !mailDir) {
    throw new Error('role-bus: mailDir 必须是非空字符串')
  }

  return {
    mailDir,
    refreshMs,
    maxInject,
    stateFiles: asStringList(raw.stateFiles, 'stateFiles'),
    roles,
  }
}

// 名字可能写成 write_file、saveFile、dsh-write-file，统一拆成小写词。
function nameTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function pickPathArg(args) {
  if (!args || typeof args !== 'object') return undefined
  for (const key of PATH_ARG_KEYS) {
    if (typeof args[key] === 'string' && args[key]) return args[key]
  }
  return undefined
}

function looksLikeWrite(name, args) {
  if (name.startsWith('ops_')) return false
  if (!nameTokens(name).some((token) => WRITE_VERBS.has(token))) return false
  return pickPathArg(args) !== undefined
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const roleNames = Object.keys(cfg.roles)
  if (roleNames.length === 0) return

  const caps = probePlugin(ctx)
  const warn = (message) => {
    try {
      if (ctx.logger?.warn) ctx.logger.warn(`role-bus: ${message}`)
      else if (process.env.ROLE_BUS_DEBUG) console.warn(`role-bus: ${message}`)
    } catch {
      // 日志失败不能影响插件
    }
  }

  if (!caps.presets) {
    // inject 已声明 agentPresets；这里是双保险，避免宿主绕过 inject 直接 apply。
    warn('agentPresets.composedPreset 不可用，插件不激活')
    return
  }

  const resolveRole = (preset) => {
    for (const [role, roleCfg] of Object.entries(cfg.roles)) {
      if (role === preset || roleCfg.presets.includes(preset)) return role
    }
    return ''
  }

  const boxes = new Map()
  const attached = new Set()
  const inflight = new Map()
  const perAgent = new Map()

  const box = (dir) => {
    let state = boxes.get(dir)
    if (!state) {
      state = loadMailbox(dir)
      boxes.set(dir, state)
    }
    return state
  }

  const refresh = () => {
    for (const dir of Array.from(boxes.keys())) boxes.set(dir, loadMailbox(dir))
  }

  const timer = setInterval(refresh, cfg.refreshMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  ctx.effect(() => () => {
    for (const cleanup of Array.from(perAgent.values())) {
      try {
        cleanup()
      } catch {
        // 元素已经被 agent 自己处置掉
      }
    }
    perAgent.clear()
    inflight.clear()
  })

  const stateRev = (cwd) => {
    if (cfg.stateFiles.length === 0) return ''
    const hash = createHash('sha1')
    let seen = false
    for (const rel of cfg.stateFiles) {
      hash.update(`${rel}:`)
      try {
        hash.update(readFileSync(resolve(cwd, rel)))
        seen = true
      } catch {
        hash.update('missing')
      }
    }
    return seen ? hash.digest('hex').slice(0, 6) : ''
  }

  // role 是 attach 时快照下来的，不再每轮现查——见文件头的兼容性说明。
  const renderInbox = (role, dir, cwd) => {
    const state = box(dir)
    const roleCfg = cfg.roles[role]
    const unread = state.messages.filter(
      (message) => message.to === role && statusOf(state, message.id) === 'pending',
    )
    const lines = [`## 角色 ${role}（${roleCfg.label}）`]

    // 边界要写进提示，而不能只靠守卫拒绝。守卫只说不，不说能做什么，
    // 会话会先撞几次才摸清范围——每次撞都是一整个 step 的浪费。
    const others = roleNames.filter((item) => item !== role)
    const bound = []
    if (roleCfg.writeAllow.length > 0) bound.push(`可写 ${roleCfg.writeAllow.join(' / ')}`)
    if (roleCfg.writeDeny.length > 0) bound.push(`禁写 ${roleCfg.writeDeny.join(' / ')}`)
    if (roleCfg.denyTools.length > 0) bound.push(`禁用 ${roleCfg.denyTools.join(' / ')}`)
    if (bound.length > 0) {
      lines.push(`边界：${bound.join('；')}。这些之外的动作会被直接拒绝，不要试。`)
      if (others.length > 0) {
        lines.push(
          `越界的事用 mail_post 发给 ${others.join(' / ')}；你改的文件不会自动提交，改完在回答或工单里列出，由对方提交。`,
        )
      }
    }

    const rev = stateRev(cwd)
    if (rev) lines.push(`状态文件版本 ${rev}：发工单时带上它，对方据此判断是否过期。`)

    if (unread.length === 0) {
      lines.push('收件箱：无未读工单。')
      return lines.join('\n')
    }

    lines.push(
      `收件箱：${unread.length} 条未读。用 mail_inbox 读全文，处理完用 mail_ack 回执（action=done 必须带 evidence）。`,
    )
    for (const message of unread.slice(0, cfg.maxInject)) {
      const refs = Array.isArray(message.refs) && message.refs.length > 0
        ? ` refs=${message.refs.join(',')}`
        : ''
      lines.push(`- [${message.id}] ${message.from} → ${role}（${message.kind}）：${message.subject}${refs}`)
    }
    if (unread.length > cfg.maxInject) {
      lines.push(`- ……另有 ${unread.length - cfg.maxInject} 条，用 mail_inbox 查看。`)
    }
    return lines.join('\n')
  }

  const buildTools = (role, dir, cwd) => {
    const otherRoles = () => roleNames.filter((item) => item !== role)
    const post = {
      name: 'mail_post',
      description:
        '给另一个角色投递一条工单。消息落盘在项目里，对方下一次推理时会看到未读摘要。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件角色之一（不能发给自己）' },
          subject: { type: 'string', description: '一句话主题' },
          body: { type: 'string', description: '完整内容' },
          kind: {
            type: 'string',
            enum: ['task', 'decision', 'question', 'report'],
            description: 'task=派活，decision=设计决定，question=提问，report=回执',
          },
          refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可追溯锚点：规则 id、commit sha、文件路径',
          },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => asJsonText(value),
      },
      async execute(args) {
        const to = String(args?.to ?? '')
        if (!cfg.roles[to]) throw new Error(`未知角色 ${to}；可选：${otherRoles().join(' / ')}`)
        if (to === role) throw new Error('不能给自己发工单。')
        const state = box(dir)
        const id = `m${String(state.messages.length + 1).padStart(4, '0')}`
        const message = {
          id,
          from: role,
          to,
          kind: typeof args?.kind === 'string' ? args.kind : 'task',
          subject: String(args.subject),
          body: String(args.body),
          refs: Array.isArray(args?.refs) ? args.refs.map(String) : [],
          state_rev: stateRev(cwd),
          created: new Date().toISOString(),
        }
        appendJsonl(resolve(dir, 'messages.jsonl'), message)
        refresh()
        return { id, to, state_rev: message.state_rev }
      },
    }

    const inbox = {
      name: 'mail_inbox',
      description: '读自己收件箱里的工单。默认只列还没回执的。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'done', 'all'],
            description: '默认 pending',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          withBody: { type: 'boolean', description: '是否带正文，默认 true' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => asJsonText(value),
      },
      async execute(args) {
        const state = box(dir)
        const want = typeof args?.status === 'string' ? args.status : 'pending'
        const limit = Number.isInteger(args?.limit) ? Math.min(args.limit, 50) : 20
        const withBody = args?.withBody !== false
        const rows = []
        for (const message of state.messages) {
          if (message.to !== role) continue
          const status = statusOf(state, message.id)
          if (want === 'pending' && status !== 'pending') continue
          if (want === 'done' && status === 'pending') continue
          rows.push(
            withBody
              ? { ...message, status }
              : {
                  id: message.id,
                  from: message.from,
                  kind: message.kind,
                  subject: message.subject,
                  status,
                },
          )
        }
        return { total: rows.length, returned: Math.min(rows.length, limit), items: rows.slice(0, limit) }
      },
    }

    const ack = {
      name: 'mail_ack',
      description: '给自己收件箱里的工单回执。action=done 时必须带 evidence。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '工单 id，例如 m0001' },
          action: { type: 'string', enum: ['read', 'done', 'rejected'] },
          evidence: {
            type: 'string',
            description: 'action=done 时必填：证明已完成的凭据（commit sha / 测试输出 / 文件路径）',
          },
          note: { type: 'string', description: '可选说明' },
        },
        required: ['id', 'action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => asJsonText(value),
      },
      async execute(args) {
        const state = box(dir)
        const id = String(args?.id ?? '')
        const message = state.messages.find((item) => item.id === id)
        if (!message) throw new Error(`没有 id 为 ${id} 的工单`)
        if (message.to !== role) throw new Error(`工单 ${id} 不是发给 ${role} 的`)
        const action = String(args?.action ?? '')
        if (!ACTIONS.has(action)) throw new Error('action 只能是 read / done / rejected')
        const evidence = String(args?.evidence ?? '').trim()
        if (action === 'done' && !evidence) throw new Error('action=done 必须带 evidence')
        appendJsonl(resolve(dir, 'acks.jsonl'), {
          id,
          by: role,
          action,
          evidence: evidence || undefined,
          note: typeof args?.note === 'string' ? args.note : undefined,
          created: new Date().toISOString(),
        })
        refresh()
        return { id, action }
      },
    }

    return [post, inbox, ack]
  }

  const makeGuard = (role, cwd) => {
    const roleCfg = cfg.roles[role]
    const deny = new Set(roleCfg.denyTools)
    const writeTools = new Set([...BASE_WRITE_TOOLS, ...roleCfg.writeTools])
    const allowPaths = roleCfg.writeAllow.map((item) => resolve(cwd, item))
    const denyPaths = roleCfg.writeDeny.map((item) => resolve(cwd, item))
    const allowLabel = roleCfg.writeAllow.join(' / ')
    const restricted = deny.size > 0 || allowPaths.length > 0

    return (exec) => {
      if (deny.has(exec.name)) {
        return `角色 ${role}（${roleCfg.label}）不允许调用 ${exec.name}。需要改代码请用 mail_post 交给实现角色。`
      }
      if (restricted && exec.name.startsWith('ops_') && !OPS_READ_ALLOW.has(exec.name)) {
        return `角色 ${role}（${roleCfg.label}）只能用 ops_read_files / ops_discover_tools 这类只读的 ops 工具，不能用 ${exec.name}。`
      }
      if (allowPaths.length === 0) return undefined

      const args = exec.arguments ?? {}
      if (!writeTools.has(exec.name) && !looksLikeWrite(exec.name, args)) return undefined
      const target = pickPathArg(args)
      if (typeof target !== 'string' || !target) return undefined
      const abs = resolve(cwd, target)

      // 拒绝优先：writeDeny 可以点名文件或目录，把白名单里的一部分挖出去。
      // 例：memory/ 开放，但 memory/project-state.md 归实现角色。
      if (denyPaths.some((item) => abs === item || inside(item, abs))) {
        return `角色 ${role} 不能写 ${target}：这个文件归别的角色维护。要改请用 mail_post 发给对方。`
      }
      // 白名单条目可以是目录，也可以是单个文件。
      if (allowPaths.some((item) => abs === item || inside(item, abs))) return undefined
      return `角色 ${role} 只能写 ${allowLabel} 下的文件（目标：${target}）。代码改动请用 mail_post 交给实现角色。`
    }
  }

  // attach 是「会合点」：created 事件、热重载补挂、空 preset 重试三条路都会进来。
  // 用 inflight 去重，并保证永远不 reject——agent/created 的 listener 抛错会让
  // 整个会话创建失败（DSH 契约），这是最贵的失败模式。
  const attach = (agent, attempt = 1, signal) => {
    if (!agent?.id) return Promise.resolve()
    if (attached.has(agent.id)) return Promise.resolve()
    const running = inflight.get(agent.id)
    if (running) return running
    const task = doAttach(agent, attempt, signal)
      .catch((error) => {
        warn(`绑定角色失败（${agent.id}）：${error?.message ?? error}`)
      })
      .finally(() => {
        if (inflight.get(agent.id) === task) inflight.delete(agent.id)
      })
    inflight.set(agent.id, task)
    return task
  }

  const doAttach = async (agent, attempt, signal) => {
    if (!agent?.id || attached.has(agent.id)) return

    // agent 已被销毁时不要再往它身上注册。
    const agents = ctx.get('agents')
    if (typeof agents?.get === 'function') {
      let live
      try {
        live = agents.get(agent.id)
      } catch {
        live = undefined
      }
      if (live && live !== agent) return
    }

    let preset = ''
    try {
      preset = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) ?? ''
    } catch {
      preset = ''
    }
    const role = resolveRole(preset)
    if (!role) {
      // 两种可能：preset 还没组装完（空串），或 resume 时先挂基础组合、
      // 稍后才 rebind 到会话记录里的 preset。有限次重试等它稳定。
      if (attempt < MAX_ATTACH_ATTEMPTS) {
        const retry = setTimeout(() => {
          void attach(agent, attempt + 1, signal)
        }, Math.min(250 * attempt, 1000))
        retry.unref?.()
      } else {
        warn(`会话 ${agent.id} 的 preset=${preset || '(空)'} 不属于任何角色，跳过绑定`)
      }
      return
    }

    // workingDirectory 是 Agent 级服务：插件根 ctx 上探测不到（caps.cwd=false），
    // 要等 created 之后从 agent.ctx 取。
    let wd
    try {
      wd = (typeof agent.ctx?.get === 'function' ? agent.ctx.get('workingDirectory') : undefined)
        ?? ctx.get('workingDirectory')
    } catch {
      wd = undefined
    }
    let cwd = ''
    try {
      cwd = (await wd?.ensure?.(agent, signal)) ?? ''
    } catch (error) {
      warn(`拿不到工作目录（${agent.id}）：${error?.message ?? error}`)
      cwd = ''
    }
    if (!cwd) {
      // 绝不用 process.cwd() 兜底：路径白名单用错 cwd 会要么误放要么误拦。
      warn(`工作目录为空（${agent.id}），跳过角色绑定`)
      return
    }
    if (attached.has(agent.id)) return

    const dir = resolve(cwd, cfg.mailDir)
    box(dir)
    const capsAgent = probeAgent(agent)
    const disposers = []

    // 幂等：agent scope 销毁和插件 unload 都可能调用它。
    const cleanup = () => {
      attached.delete(agent.id)
      perAgent.delete(agent.id)
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try {
          disposers[index]?.()
        } catch {
          // 注册已被宿主回收
        }
      }
      disposers.length = 0
    }

    try {
      if (capsAgent.prompt === 'context') {
        disposers.push(
          agent.ctx.systemPrompt.context({
            name: 'role-bus',
            order: PROMPT_ORDER,
            text: () => (attached.has(agent.id) ? renderInbox(role, dir, cwd) : ''),
          }),
        )
      } else if (capsAgent.prompt === 'section') {
        disposers.push(
          agent.ctx.systemPrompt.section({
            name: 'role-bus',
            order: PROMPT_ORDER,
            text: () => (attached.has(agent.id) ? renderInbox(role, dir, cwd) : ''),
          }),
        )
      } else {
        warn(`systemPrompt.context/section 都不可用（${agent.id}），未读摘要不注入`)
      }

      if (capsAgent.register) {
        for (const tool of buildTools(role, dir, cwd)) {
          disposers.push(agent.ctx.tools.register(tool))
        }
      } else {
        warn(`tools.register 不可用（${agent.id}），mail 工具未注册`)
      }

      if (capsAgent.guard) {
        disposers.push(agent.ctx.tools.guard(makeGuard(role, cwd)))
      } else {
        warn(`tools.guard 不可用（${agent.id}），角色边界不会生效`)
      }

      // agent scope 销毁时自动清理；插件 unload 时由 apply 的 effect 兜底。
      try {
        agent.ctx.effect(() => cleanup)
      } catch {
        // agent 已 disposed，注册会抛；清理仍由 apply 的 effect 负责。
      }

      attached.add(agent.id)
      perAgent.set(agent.id, cleanup)
    } catch (error) {
      cleanup()
      throw error
    }
  }

  // 插件热重载后已有会话不会重新触发 agent/created，这里补挂一次。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      let list = []
      try {
        list = ctx.get('agents')?.list?.() ?? []
      } catch {
        list = []
      }
      for (const agent of list) void attach(agent, 1)
    }, 0)
    timer.unref?.()
    return () => clearTimeout(timer)
  })

  ctx.on('agent/created', async ({ agent, signal }) => {
    try {
      await attach(agent, 1, signal)
    } catch (error) {
      // attach 内部已不抛；这里只是最后一道保险，绝不让会话创建失败。
      warn(`agent/created 处理失败：${error?.message ?? error}`)
    }
  })
}
