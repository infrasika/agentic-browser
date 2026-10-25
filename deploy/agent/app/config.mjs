// Shared by the existing hosted renderer and the portable Agent image.
// Secrets remain placeholders resolved only inside LibreChat.
export function createAgentConfiguration({ origin, model, promptRate, completionRate,
  startCredits, dailyCredits = 20000000, timeZone = 'Asia/Shanghai',
  name = 'Browser Demo', starters, browserURL, turnstile }) {
  const permissionOff = { use: false, create: false, share: false, public: false };
  return {
    version: '1.3.18', cache: true,
    interface: {
      customWelcome: name, modelSelect: false, parameters: false, presets: false,
      multiConvo: false, memories: false, runCode: false, webSearch: false, fileSearch: false,
      mcpServers: permissionOff, prompts: permissionOff,
      agents: { use: true, create: false, share: false, public: false },
      buildInfo: false, mascot: false, temporaryChat: false, contextCost: true,
    },
    registration: { socialLogins: [] },
    ...(turnstile ? { turnstile: { siteKey: turnstile,
      verification: { required: true, hostname: new URL(origin).hostname, timeoutMs: 10000 } } } : {}),
    balance: { enabled: true, startBalance: startCredits, autoRefillEnabled: false, display: 'credits',
      siteBudget: { enabled: true, dailyCredits, timeZone, endpoints: ['Qwen'],
        maxPromptTokens: 64000, maxOutputTokens: 4096, maxRequestBytes: 262144 } },
    transactions: { enabled: true },
    browser: { enabled: true, baseURL: browserURL,
      agentIds: ['agent_browser_demo'], pollIntervalMs: 1000 },
    endpoints: {
      agents: { disableBuilder: true, allowedProviders: ['Qwen'], capabilities: [],
        recursionLimit: 40, maxRecursionLimit: 40, checkpointer: { type: 'mongo', ttl: 3600 } },
      custom: [{ name: 'Qwen', apiKey: '${QWEN_API_KEY}', baseURL: '${QWEN_BASE_URL}',
        models: { default: [model], fetch: false },
        titleConvo: true, titleModel: model, titleMethod: 'completion', titleTiming: 'immediate',
        titlePromptTemplate: '{input}',
        titlePrompt: 'Write a short, specific conversation title describing the user\'s task. Use the same language as the user\'s request. Keep it to 3–7 words, or at most 20 Chinese characters. Return only the title, without quotes or a prefix. Do not use generic titles such as New Chat. Describe the task, not its result, and omit credentials, email addresses, account names and private repository names.\n\nUser request:\n{convo}',
        addParams: { enable_thinking: false, parallel_tool_calls: false },
        tokenConfig: { [model]: { prompt: promptRate, completion: completionRate, context: 64000 } },
      }],
    },
    modelSpecs: { enforce: true, list: [{ name: 'browser-demo', label: name, default: true,
      preset: { endpoint: 'agents', agent_id: 'agent_browser_demo' }, conversation_starters: starters }] },
  };
}
