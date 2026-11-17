// role-bus 自测：用假 ctx / 假 agent 驱动 apply，覆盖守卫、注入、邮箱流程、
// 并发与降级路径。不依赖真实项目，也不写真实 .dsh/mail。
//
// 跑法：node selftest.mjs（或 npm test）。失败时退出码非 0。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const ROOT = mkdtempSync(join(tmpdir(), 'role-bus-selftest-'))

const CONFIG = {
  mailDir: '.dsh/mail',
  refreshMs: 200,
  maxInject: 8,
  stateFiles: ['memory/project-state.md'],
  roles: {
    design: {
      label: '设计会话',
      presets: ['design'],
      denyTools: ['ops_bash', 'ops_pwsh'],
      writeAllow: ['README.md', 'design', 'memory/rules.yaml'],
      writeDeny: ['memory/project-state.md'],
    },
    studio: {
      label: '实现会话',
      presets: ['standard', 'studio', 'ptc'],
    },
  },
}

let failures = 0
let passes = 0
function check(name, fn) {
  try {
    fn()
    passes += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message.split('\n')[0]}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passes += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message.split('\n')[0]}`)
  }
}

// 一个最小的宿主：只有 ctx.get / effect / on。
function makeHost({ preset = 'design', noPresets = false, noCwd = false, ensure, workdir = ROOT } = {}) {
  const effects = []
  const handlers = {}
  const presetOf = typeof preset === 'function' ? preset : () => preset
  const ctx = {
    effects,
    handlers,
    get(name) {
      if (name === 'agentPresets') {
        return noPresets ? undefined : { composedPreset: (agent) => presetOf(agent) }
      }
      if (name === 'workingDirectory') {
        return noCwd ? undefined : { ensure: ensure ?? (async () => workdir) }
      }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    on(event, fn) {
      handlers[event] = fn
    },
  }
  return ctx
}

function disposeHost(ctx) {
  for (const dispose of ctx.effects.splice(0).reverse()) {
    try {
      dispose()
    } catch {
      // 忽略重复清理
    }
  }
}

// 假 agent：只实现 role-bus 会碰的那几个方法。
function makeAgent(id, { registerThrows = () => false, noPrompt = false } = {}) {
  const cap = { prompt: null, tools: [], guard: null }
  const agent = {
    id,
    cap,
    ctx: {
      effects: [],
      systemPrompt: noPrompt
        ? undefined
        : {
            context(section) {
              cap.prompt = section
              return () => {
                if (cap.prompt === section) cap.prompt = null
              }
            },
          },
      tools: {
        register(tool) {
          if (registerThrows()) throw new Error('duplicate tool registration')
          cap.tools.push(tool)
          return () => {
            cap.tools = cap.tools.filter((item) => item !== tool)
          }
        },
        guard(guard) {
          cap.guard = guard
          return () => {
            cap.guard = null
          }
        },
      },
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') agent.ctx.effects.push(dispose)
      },
    },
  }
  return agent
}

function disposeAgent(agent) {
  for (const dispose of agent.ctx.effects.splice(0).reverse()) {
    try {
      dispose()
    } catch {
      // 忽略
    }
  }
}

async function attach(host, agent, preset) {
  const created = host.handlers['agent/created']
  assert.equal(typeof created, 'function', 'agent/created 未注册')
  await created({ agent, signal: undefined })
}

function verdict(agent, name, args = {}) {
  assert.equal(typeof agent.cap.guard, 'function', '守卫未注册')
  return agent.cap.guard({ name, arguments: args })
}

async function scenario(preset, opts = {}) {
  const host = makeHost({ preset, ...opts })
  const agent = makeAgent('a-' + preset + '-' + Math.random().toString(36).slice(2, 6))
  apply(host, CONFIG)
  await attach(host, agent, preset)
  return { host, agent }
}

// ---- 配置校验 ----

check('配置：writeAllow 类型错误时抛错', () => {
  assert.throws(() => apply(makeHost(), { roles: { a: { writeAllow: 123 } } }), /writeAllow/)
})

await checkAsync('配置：单个字符串兼容成数组', async () => {
  const host = makeHost()
  apply(host, { roles: { a: { presets: 'a', writeAllow: 'README.md' } } })
  disposeHost(host)
})

check('配置：refreshMs 过小抛错', () => {
  assert.throws(() => apply(makeHost(), { refreshMs: 100, roles: { a: {} } }), /refreshMs/)
})

check('配置：roles 不是对象抛错', () => {
  assert.throws(() => apply(makeHost(), { roles: [] }), /roles/)
})

// ---- 守卫 ----

await checkAsync('design：白名单外拒绝、白名单内放行', async () => {
  const { agent } = await scenario('design')
  assert.ok(verdict(agent, 'edit', { path: 'game/Slice/slice_economy.gd' }), 'game/ 应拒绝')
  assert.equal(verdict(agent, 'edit', { path: 'design/a.md' }), undefined)
  assert.equal(verdict(agent, 'edit', { path: 'README.md' }), undefined)
  assert.equal(verdict(agent, 'ops_read_files', {}), undefined)
})

await checkAsync('design：denyTools 生效', async () => {
  const { agent } = await scenario('design')
  assert.match(verdict(agent, 'ops_bash', {}), /ops_bash/)
  assert.match(verdict(agent, 'ops_pwsh', {}), /ops_pwsh/)
})

await checkAsync('design：writeDeny 优先于 writeAllow', async () => {
  const { agent } = await scenario('design')
  assert.match(verdict(agent, 'edit', { path: 'memory/project-state.md' }), /project-state/)
  assert.equal(verdict(agent, 'edit', { path: 'memory/rules.yaml' }), undefined)
})

await checkAsync('design：启发式拦未知写工具', async () => {
  const { agent } = await scenario('design')
  assert.match(verdict(agent, 'save_file', { path: 'game/a.gd' }), /只能写/)
  assert.match(verdict(agent, 'saveFile', { file_path: 'game/a.gd' }), /只能写/)
})

await checkAsync('design：规划类工具不误伤', async () => {
  const { agent } = await scenario('design')
  assert.equal(verdict(agent, 'create_plan', { text: 'x' }), undefined)
  assert.equal(verdict(agent, 'update_goal', { goal_id: 'g1' }), undefined)
})

await checkAsync('studio：无白名单时放行', async () => {
  const { agent } = await scenario('studio')
  assert.equal(verdict(agent, 'edit', { path: 'game/a.gd' }), undefined)
})

await checkAsync('role 快照：composedPreset 中途变化不影响已绑定会话', async () => {
  let preset = 'design'
  const host = makeHost({ preset: () => preset })
  const agent = makeAgent('a-snapshot')
  apply(host, CONFIG)
  await attach(host, agent, preset)
  const before = agent.cap.prompt.text()
  preset = 'studio'
  assert.equal(agent.cap.prompt.text(), before, '注入文本应仍按 design 渲染')
  assert.ok(verdict(agent, 'edit', { path: 'game/a.gd' }), '守卫应仍按 design 拒绝')
  disposeAgent(agent)
  disposeHost(host)
})

// ---- 注入 ----

await checkAsync('注入：含角色、边界、收件箱', async () => {
  const { agent } = await scenario('design')
  const text = agent.cap.prompt.text()
  assert.match(text, /角色 design（设计会话）/)
  assert.match(text, /可写 README.md \/ design \/ memory\/rules.yaml/)
  assert.match(text, /收件箱：无未读工单/)
})

await checkAsync('注入：agent 注销后返回空串', async () => {
  const { agent } = await scenario('design')
  const section = agent.cap.prompt
  assert.ok(section.text().length > 0)
  disposeAgent(agent)
  assert.equal(section.text(), '')
})

// ---- 邮箱流程 ----

await checkAsync('邮箱：post → inbox → ack 全流程', async () => {
  const designer = makeAgent('design-1')
  const builder = makeAgent('studio-1')
  // composedPreset 收到的是 agent.ctx，不是 agent 本身。
  const host = makeHost({ preset: (agentCtx) => (agentCtx === designer.ctx ? 'design' : 'studio') })
  apply(host, CONFIG)
  await attach(host, designer)
  await attach(host, builder)

  const post = designer.cap.tools.find((tool) => tool.name === 'mail_post')
  const inbox = builder.cap.tools.find((tool) => tool.name === 'mail_inbox')
  const ack = builder.cap.tools.find((tool) => tool.name === 'mail_ack')

  const sent = await post.execute({ to: 'studio', subject: '改一下跳跃', body: '跳跃高度 1.2' })
  assert.equal(sent.to, 'studio')

  const unread = await inbox.execute({})
  assert.equal(unread.total, 1)
  assert.equal(unread.items[0].subject, '改一下跳跃')

  await assert.rejects(() => ack.execute({ id: sent.id, action: 'done' }), /evidence/)
  await ack.execute({ id: sent.id, action: 'done', evidence: 'commit 21edddd' })
  assert.equal((await inbox.execute({})).total, 0)
  assert.equal((await inbox.execute({ status: 'done' })).items[0].status, 'done')

  disposeAgent(designer)
  disposeAgent(builder)
  disposeHost(host)
})

await checkAsync('邮箱：不能发给自己', async () => {
  const { agent } = await scenario('design')
  const post = agent.cap.tools.find((tool) => tool.name === 'mail_post')
  await assert.rejects(() => post.execute({ to: 'design', subject: 'x', body: 'y' }), /自己/)
})

await checkAsync('邮箱：工单文件落在 mailDir 下', async () => {
  const { agent, host } = await scenario('design')
  const post = agent.cap.tools.find((tool) => tool.name === 'mail_post')
  await post.execute({ to: 'studio', subject: 's', body: 'b' })
  const file = join(ROOT, '.dsh/mail/messages.jsonl')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.ok(lines.length >= 1)
  disposeAgent(agent)
  disposeHost(host)
})

// ---- 并发与失败路径 ----

await checkAsync('并发：同一 agent 同时 attach 只注册一次', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const host = makeHost({
    ensure: async () => {
      await gate
      return ROOT
    },
  })
  const agent = makeAgent('a-race')
  apply(host, CONFIG)
  const listener = host.handlers['agent/created']
  const first = listener({ agent })
  const second = listener({ agent })
  release()
  await Promise.all([first, second])
  assert.equal(agent.cap.tools.length, 3, `注册了 ${agent.cap.tools.length} 个工具`)
  disposeAgent(agent)
  disposeHost(host)
})

await checkAsync('失败：注册抛错时 listener 不 reject 且回滚', async () => {
  let n = 0
  const host = makeHost()
  const agent = makeAgent('a-fail', { registerThrows: () => ++n === 2 })
  apply(host, CONFIG)
  await attach(host, agent) // 不应抛
  assert.equal(agent.cap.guard, null, '守卫应被回滚')
  assert.equal(agent.cap.tools.length, 0, '已注册的工具应被回滚')
  disposeAgent(agent)
  disposeHost(host)
})

await checkAsync('失败：ensure 抛错时跳过且不写 process.cwd', async () => {
  const host = makeHost({ ensure: async () => { throw new Error('no cwd') } })
  const agent = makeAgent('a-nocwd')
  apply(host, CONFIG)
  await attach(host, agent)
  assert.equal(agent.cap.tools.length, 0)
  assert.equal(agent.cap.guard, null)
  disposeAgent(agent)
  disposeHost(host)
})

await checkAsync('降级：agentPresets 缺失时不激活', async () => {
  const host = makeHost({ noPresets: true })
  apply(host, CONFIG)
  assert.equal(host.handlers['agent/created'], undefined, '不应注册 created 监听')
})

await checkAsync('降级：workingDirectory 缺失时跳过绑定', async () => {
  const host = makeHost({ noCwd: true })
  const agent = makeAgent('a-nocwd-svc')
  apply(host, CONFIG)
  await attach(host, agent)
  assert.equal(agent.cap.tools.length, 0)
  assert.equal(agent.cap.guard, null)
  disposeAgent(agent)
  disposeHost(host)
})

await checkAsync('降级：agent 没有 systemPrompt 时仍注册工具与守卫', async () => {
  const host = makeHost()
  const agent = makeAgent('a-noprompt', { noPrompt: true })
  apply(host, CONFIG)
  await attach(host, agent)
  assert.equal(agent.cap.tools.length, 3)
  assert.equal(typeof agent.cap.guard, 'function')
  disposeAgent(agent)
  disposeHost(host)
})

await checkAsync('重试：空 preset 四次后放弃', async () => {
  const host = makeHost({ preset: '' })
  const agent = makeAgent('a-empty')
  apply(host, CONFIG)
  await attach(host, agent)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(agent.cap.tools.length, 0)
  disposeAgent(agent)
  disposeHost(host)
})

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
