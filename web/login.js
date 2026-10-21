import { requestJson } from "/request.js";
import { browserHeaders } from '/team-client.js';
const $ = id => document.getElementById(id);
const requested = new URLSearchParams(location.search).get('next') || '/';
const next = requested === '/' || /^\/view#[a-f0-9-]{36}$/.test(requested) ? requested : '/';
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('submit').disabled = true; $('message').textContent = '';
  try {
    await requestJson('/api/auth/login', { method: 'POST', headers: browserHeaders(), body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    $('password').value = '';
    location.assign(next);
  } catch (error) { $('message').textContent = error.status === 401 ? 'Username or password not recognized. Try again, or reset your workspace password from the deployment terminal.' : error.message; }
  finally { $('password').value = ''; $('submit').disabled = false; }
};
