const isHttps = location.protocol === 'https:';
document.getElementById('transport-warning').hidden = isHttps;
document.getElementById('github-task').hidden = !isHttps;

function enableCopy(buttonId, sourceId, statusId, successMessage) {
  const button = document.getElementById(buttonId);
  const source = document.getElementById(sourceId);
  const status = document.getElementById(statusId);
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(source.textContent);
      status.textContent = successMessage;
    } catch {
      const preview = source.closest('details');
      if (preview) preview.open = true;
      source.focus();
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = '浏览器未允许自动复制，已选中文字，请按 ⌘C / Ctrl+C 复制。';
    }
  };
  button.disabled = false;
}

try {
  const response = await fetch('/api/auth/config');
  if (!response.ok) throw new Error('Configuration unavailable');
  const config = await response.json();
  const mcpUrl = new URL(config.mcpUrl);
  if (!['https:', 'http:'].includes(mcpUrl.protocol)) throw new Error('Invalid MCP URL');
  const content = JSON.stringify({ mcpServers: { 'agentic-browser': { type: 'http', url: mcpUrl.href } } }, null, 2);
  const claudeCommand = `claude mcp add --transport http --scope user agentic-browser ${mcpUrl.href}`;
  const task = isHttps && mcpUrl.protocol === 'https:'
    ? document.getElementById('github-prompt').textContent
    : '用 agentic-browser 打开 https://example.com，把浏览器交给我体验操作；等我交还后，读取页面标题并关闭会话。当前服务使用 HTTP，请仅使用公开网页和虚构数据。';
  document.getElementById('mcp-config').textContent = content;
  document.getElementById('codex-command').textContent = `codex mcp add agentic-browser --url ${mcpUrl.href}`;
  document.getElementById('claude-command').textContent = claudeCommand;
  document.getElementById('install-prompt').textContent = `请帮我在当前 Agent 客户端中安装并连接 Agentic Browser MCP，然后带我体验一次远程浏览器的人机协作。

服务名称：agentic-browser
服务地址：${mcpUrl.href}
传输方式：Streamable HTTP
这是公共演示服务，无需注册 Agentic Browser 账号，也不需要 API Key；无需在本机部署浏览器或启动服务。

请先确认当前客户端的 MCP 配置方式，添加此远程服务，保留其他已有配置。如果已存在同名服务，请先核对地址，避免直接覆盖。下面是通用 JSON 配置参考，请按当前客户端实际支持的格式使用：
${content}

如果当前客户端是 Claude Code，可在本机终端使用下面的命令添加（user 范围，在当前用户的所有项目中可用）：
${claudeCommand}
添加后运行 claude mcp get agentic-browser 检查连接，并在 Claude Code 中用 /mcp 查看工具状态。

如果你不能直接修改客户端配置，请提供针对当前客户端的具体添加步骤。如果需要用户批准、刷新工具或重启客户端，请明确告知，并等配置生效后再继续。

连接后，确认能发现并调用 agentic-browser 的工具；未验证前不要声称安装成功。然后执行下面的体验任务：
${task}

调用 browser_handoff 后，先把返回的 userMessage 发到当前对话，展示可点击的 humanUrl 和完整原始地址（保留 # 后的全部内容），再调用 browser_wait 等待我。不要只说“点击 Connect”却不提供实际链接。没有链接或链接过期时，调用 browser_human_link 获取新链接并展示，不要猜测地址。

账号、密码和验证码由我在接管页面中输入，不要要求我在聊天里提供。接管链接只发给当前对话中的我，不要公开或转发给其他人；sessionKey 仅用于工具调用，不要展示。人工操作期间等待我交还控制权，再继续读取网页。公共会话初始 5 分钟，最长 10 分钟，完成后关闭会话。`;
  enableCopy('copy-prompt', 'install-prompt', 'prompt-status', '提示词已复制，粘贴到你的 Agent 即可开始。');
  enableCopy('copy-config', 'mcp-config', 'copy-status', '配置已复制。');
  enableCopy('copy-claude', 'claude-command', 'claude-status', 'Claude Code 命令已复制，请在本机终端执行。');
} catch {
  document.getElementById('prompt-status').textContent = '连接配置加载失败，请刷新页面后重试。';
}
