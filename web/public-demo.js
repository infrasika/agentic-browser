import { browserHeaders } from '/team-client.js';
const button = document.getElementById('start-demo');
button.onclick = async () => {
  button.disabled = true; document.getElementById('demo-message').textContent = '正在准备你的临时浏览器…';
  try {
    const response = await fetch('/api/demo/start', { method: 'POST', headers: browserHeaders(), body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '暂时无法开始演示。');
    location.assign(result.humanUrl);
  } catch (error) { document.getElementById('demo-message').textContent = error.message; button.disabled = false; }
};
