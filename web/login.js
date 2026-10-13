import { browserHeaders } from '/team-client.js';
const $ = id => document.getElementById(id);
const requested = new URLSearchParams(location.search).get('next') || '/';
const next = requested === '/' || /^\/view#[a-f0-9-]{36}$/.test(requested) ? requested : '/';
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('submit').disabled = true; $('message').textContent = '';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: browserHeaders(), body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    $('password').value = '';
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '登录失败，请稍后重试。');
    location.assign(next);
  } catch (error) { $('message').textContent = error.message; }
  finally { $('submit').disabled = false; }
};
