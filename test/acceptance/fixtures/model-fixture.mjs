// Synthetic model only. Drives real graph tools, Chrome, handoff and resume.
import { createServer } from 'node:http';
let calls = 0, maxSnapshotRequestBytes = 0;
createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url === '/stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ calls, maxSnapshotRequestBytes })); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
  // A follow-up in the same conversation starts a new task. Historical tool
  // results must not make the fixture treat the new user message as completed.
  const history = body.messages ?? [];
  const messages = history.slice(history.findLastIndex(m => m.role === 'user') + 1);
  const last = messages.findLast(m => m.role === 'tool');
  const prior = messages.flatMap(m => m.tool_calls ?? []).find(t => t.id === last?.tool_call_id);
  if (prior?.function?.name === 'browser_snapshot') maxSnapshotRequestBytes = Math.max(maxSnapshotRequestBytes, Buffer.byteLength(JSON.stringify(body)));
  const text = value => typeof value === 'string' ? value : (value ?? []).map(part => part.text ?? '').join('');
  let command, content = 'agentic-browser-acceptance — browser handoff completed.';
  if (body.tools?.some(t => t.function?.name === 'browser_open')) {
    if (!last) command = { name: 'browser_open', arguments: { url: 'https://httpbin.org/anything/agentic-browser-acceptance', purpose: 'Self-hosted browser acceptance' } };
    else {
      let result; try { result = JSON.parse(text(last.content)); } catch { result = {}; }
      if (result.ok !== true) content = 'Browser fixture failed: ' + JSON.stringify(result);
      else if (prior?.function?.name === 'browser_open') command = { name: 'browser_request_handoff', arguments: { leaseId: result.value.id, reason: 'Please confirm the example page and return control.' } };
      else if (prior?.function?.name === 'browser_request_handoff') command = { name: 'browser_snapshot', arguments: { leaseId: result.value.id } };
      else if (prior?.function?.name === 'browser_snapshot') {
        const handoff = messages.flatMap(m => m.tool_calls ?? []).findLast(t => t.function?.name === 'browser_request_handoff');
        const snapshots = messages.flatMap(m => m.tool_calls ?? []).filter(t => t.function?.name === 'browser_snapshot').length;
        command = { name: snapshots < 2 ? 'browser_snapshot' : 'browser_close', arguments: { leaseId: JSON.parse(handoff.function.arguments).leaseId } };
      }
    }
  } else content = 'Read agentic-browser-acceptance';
  const toolCalls = command ? [{ id: 'call_' + calls, type: 'function', function: { name: command.name, arguments: JSON.stringify(command.arguments) } }] : undefined;
  console.log(JSON.stringify({ call: calls, previousTool: prior?.function?.name, outputTool: command?.name, tools: body.tools?.map(t => t.function?.name), result: last ? text(last.content).slice(0,600) : undefined }));
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  const response = { id: 'fixture-' + calls, object: 'chat.completion', created: 1, model: 'selfhost-fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: command ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: command ? 'tool_calls' : 'stop' }], usage };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
  res.setHeader('content-type', 'text/event-stream');
  const delta = { role: 'assistant', ...(toolCalls ? { tool_calls: toolCalls.map((t, index) => ({ index, ...t })) } : { content }) };
  res.write('data: ' + JSON.stringify({ ...response, object: 'chat.completion.chunk', usage: undefined, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: command ? 'tool_calls' : 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}).listen(9000, '0.0.0.0');
