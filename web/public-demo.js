import { browserHeaders } from '/team-client.js';
const button = document.getElementById('start-demo');
button.onclick = async () => {
  button.disabled = true; document.getElementById('demo-message').textContent = 'Preparing your temporary browser…';
  try {
    const response = await fetch('/api/demo/start', { method: 'POST', headers: browserHeaders(), body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to start the demo right now.');
    location.assign(result.humanUrl);
  } catch (error) { document.getElementById('demo-message').textContent = error.message; button.disabled = false; }
};
