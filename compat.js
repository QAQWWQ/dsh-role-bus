// compat.js：集中探测宿主能力。
//
// role-bus 只用 DSH 的公开 Service 与 Event，但不同版本的 DSH 对同一个 Service
// 提供的形状可能不同。这里把「这个能力在不在」一次问清，apply / attach 只按
// 探测结果分支，避免把 ctx.get(...)?.method?.() 散落到各处。
//
// 探测是只读的：不注册、不改状态；缺失一律返回 null / false，由调用方决定
// 降级还是跳过。

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

export function probePlugin(ctx) {
  const systemPrompt = safeGet(ctx, 'systemPrompt')
  const agentPresets = safeGet(ctx, 'agentPresets')
  const workingDirectory = safeGet(ctx, 'workingDirectory')
  const agents = safeGet(ctx, 'agents')

  return {
    // 注入一段每轮重算的提示：新版是 context()，旧版是 section()。
    prompt: typeof systemPrompt?.context === 'function'
      ? 'context'
      : typeof systemPrompt?.section === 'function'
        ? 'section'
        : null,
    // 没有 composedPreset 就分不清角色，插件没有意义。
    presets: typeof agentPresets?.composedPreset === 'function',
    // 没有 ensure 就拿不到可靠的 cwd，写路径白名单不能瞎猜。
    cwd: typeof workingDirectory?.ensure === 'function',
    // 补挂已有会话用 list()；老版本可能只有 get()。
    agents: typeof agents?.list === 'function' || typeof agents?.get === 'function',
  }
}

export function probeAgent(agent) {
  const prompt = agent?.ctx?.systemPrompt
  const tools = agent?.ctx?.tools

  return {
    prompt: typeof prompt?.context === 'function'
      ? 'context'
      : typeof prompt?.section === 'function'
        ? 'section'
        : null,
    register: typeof tools?.register === 'function',
    guard: typeof tools?.guard === 'function',
  }
}
