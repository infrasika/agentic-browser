import { team, requireMember, browserHeaders } from "/team-client.js";
await requireMember();
import RFB from "/vendor/novnc/core/rfb.js";

const $ = (id) => document.getElementById(id);
const fragment = location.hash.slice(1);
const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(fragment);
let credentials = match ? { id: match[1], token: match[2] } : null;
if (credentials) {
  sessionStorage.setItem("viewer-session", JSON.stringify(credentials));
  history.replaceState(null, "", "/view");
} else {
  try {
    credentials = JSON.parse(
      sessionStorage.getItem("viewer-session") || "null",
    );
  } catch {}
}
if (team) {
  const teamId = /^[a-f0-9-]{36}$/.test(fragment) ? fragment : sessionStorage.getItem("team-viewer-id");
  credentials = teamId ? { id: teamId } : null;
  if (teamId) { sessionStorage.setItem("team-viewer-id", teamId); history.replaceState(null, "", "/view"); }
}
let state = null;
let imageUrl = "";
let stopped = false;
let actionTail = Promise.resolve();
let busy = false;
let desktopSocket = null;
let desktopRfb = null;
let desktopRevision = -1;
let retryDesktopAt = 0;
let connected = false;
let desktopConnected = false;
let inputEpoch = 0;
let observationEpoch = 0;
let failures = 0;
let deadlineAt = 0;

function accept(next) {
  if (!connected && state) $("message").textContent = "连接已恢复，控制权已确认。";
  deadlineAt = performance.now() + Date.parse(next.expiresAt) - (next.serverTime ? Date.parse(next.serverTime) : Date.now());
  connected = true;
  failures = 0;
  if (next.control === "closed") stopped = true;
  render(next);
}

function connectionStatus() {
  const ready = connected && (state?.control !== "human" || state?.transport !== "desktop" || desktopConnected);
  $("connection").textContent = stopped
    ? "会话已结束或链接已失效。可返回首页恢复已保存的配置。"
    : ready ? "连接正常" : "连接中断或正在连接；恢复后会确认控制权。请检查远程端口转发。";
  $("reconnect").hidden = ready || stopped;
  $("recover").hidden = !stopped;
}

function expiryStatus() {
  if (!state) return;
  const remaining = Math.max(0, Math.ceil((deadlineAt - performance.now()) / 1000));
  $("expiry").textContent = `${new Date(state.expiresAt).toLocaleTimeString()} 到期 · 剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  $("expiry-warning").hidden = remaining > 120 || stopped;
  $("expiry-warning").textContent = remaining > 0
    ? `会话即将到期，请点击「延长会话」。${state.profile ? "到期后将关闭浏览器，保存的登录配置仍保留。" : "此为临时会话，到期后登录状态会清理。"}`
    : "正在确认会话是否到期，输入已暂停。";
}

function failedRequest(error) {
  if ([401, 404, 410].includes(error.status)) stopped = true;
  if (!error.status || stopped || error.status >= 500) {
    connected = false;
    inputEpoch++;
    failures++;
    $("text").value = "";
    clearScreen();
    if (state) render(state);
    connectionStatus();
  }
  if (error.status !== 409) $("message").textContent = stopped
    ? "会话不可用。若服务已重启，请返回首页使用已保存的配置新建会话。"
    : error.status ? error.message : "连接中断，正在重试。未确认的输入不会自动重发。";
}

function disconnectDesktop() {
  const socket = desktopSocket;
  desktopSocket = null;
  desktopConnected = false;
  desktopRfb?.disconnect();
  desktopRfb = null;
  socket?.close();
  $("desktop").replaceChildren();
  $("desktop").hidden = true;
}

function connectDesktop() {
  if (desktopSocket && desktopRevision === state.revision) return;
  if (Date.now() < retryDesktopAt) return;
  disconnectDesktop();
  desktopRevision = state.revision;
  const revision = state.revision;
  const url = new URL(`/api/human/${credentials.id}/desktop`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  desktopSocket = socket;
  const failed = () => {
    if (desktopSocket !== socket) return;
    inputEpoch++;
    $("text").value = "";
    disconnectDesktop();
    if (state) render(state);
    retryDesktopAt = Date.now() + 2000;
    $("placeholder").hidden = false;
    $("message").textContent = "远程桌面连接已断开，正在重新连接…";
  };
  socket.onopen = async () => {
    try {
      const auth = team ? await api("desktop-grant", "POST", {}) : { token: credentials.token, revision };
      if (desktopSocket !== socket || state?.revision !== revision || socket.readyState !== WebSocket.OPEN) { socket.close(); return; }
      socket.send(JSON.stringify(auth));
    } catch (error) { failedRequest(error); failed(); }
  };
  socket.onerror = failed;
  socket.onclose = event => {
    if (event.code === 4409 && desktopSocket === socket) {
      inputEpoch++; disconnectDesktop(); retryDesktopAt = Infinity;
      $('message').textContent = '浏览器已在另一个窗口接管。请关闭那个窗口，再点击「重新连接」。';
      connectionStatus(); return;
    }
    failed();
  };
  socket.onmessage = (event) => {
    if (
      event.data !== "ready" ||
      state?.control !== "human" ||
      busy ||
      state.revision !== revision
    ) {
      failed();
      return;
    }
    $("desktop").hidden = false;
    $("placeholder").hidden = true;
    const rfb = new RFB($("desktop"), socket, { shared: true });
    desktopRfb = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.addEventListener("disconnect", failed);
    rfb.addEventListener("connect", () => {
      if (desktopSocket === socket) {
        desktopConnected = true;
        render(state);
        $("message").textContent = "已连接远程浏览器，可以直接操作。";
      }
    });
  };
}

function desktopAction(value) {
  if (!desktopConnected || !desktopRfb) throw new Error("远程桌面尚未连接，请稍候。");
  desktopRfb.focus();
  if (value.type === "type") {
    for (const character of value.text) {
      const point = character.codePointAt(0);
      const keysym =
        character === "\n"
          ? 0xff0d
          : point <= 0xff
            ? point
            : 0x01000000 | point;
      desktopRfb.sendKey(keysym);
    }
  } else if (value.type === "press") {
    const keys = {
      Tab: 0xff09,
      Enter: 0xff0d,
      Backspace: 0xff08,
      Escape: 0xff1b,
    };
    if (keys[value.key]) desktopRfb.sendKey(keys[value.key]);
  }
}

async function api(operation = "", method = "GET", body) {
  if (!credentials) {
    stopped = true;
    throw new Error("接管链接无效，请从首页打开接管页面。");
  }
  const response = await fetch(
    `/api/human/${credentials.id}${operation ? `/${operation}` : ""}`,
    {
      method,
      signal: AbortSignal.timeout(method === "GET" ? 6000 : 25000),
      headers: team ? browserHeaders() : {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const body = await response.json();
    const error = new Error(body.message || "请求失败");
    error.status = response.status;
    throw error;
  }
  return operation === "screen" ? response.blob() : response.json();
}

function clearScreen() {
  disconnectDesktop();
  $("screen").hidden = true;
  $("screen").removeAttribute("src");
  $("placeholder").hidden = false;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = "";
}

function render(next) {
  state = next;
  const human = next.control === "human";
  const switching = next.control === "switching";
  const desktop = next.transport === "desktop";
  document.querySelector(".browser-toolbar").hidden = desktop;
  $("screen-wrap").classList.toggle("desktop-mode", desktop);
  $("input-hint").textContent = desktop
    ? "直接操作远程浏览器窗口。可使用窗口中的地址栏、标签页和返回按钮。"
    : "点击网页中的控件，再直接使用键盘输入。支持滚轮、Tab 和 Enter。";
  $("state").textContent = human
    ? "● 你正在操作"
    : switching
      ? "正在交接"
      : "● Agent 操作中";
  $("state").classList.toggle("human", human);
  $("purpose").textContent = next.purpose;
  expiryStatus();
  connectionStatus();
  $("storage-mode").textContent = next.profile ? `保存登录状态：${next.profile.name}` : "临时会话 · 结束后清理登录状态";
  const unavailable = !connected || stopped || performance.now() >= deadlineAt;
  $("extend").disabled = unavailable || busy;
  $("end-session").disabled = stopped || busy;
  $("extend").textContent = `延长会话 · 从现在起 ${Math.ceil((next.ttlSeconds ?? 1800) / 60)} 分钟`;
  $("control-title").textContent = human
    ? "现在由你掌控"
    : switching
      ? "等待已有操作结束"
      : "当前由 Agent 操作";
  $("reason").textContent =
    next.reason ||
    (human
      ? "完成登录或确认后，点击下方按钮交还控制权。"
      : "需要登录或人工确认时，可以接管浏览器。");
  $("takeover").hidden = human;
  $("takeover").disabled = switching || busy || unavailable;
  $("resume").hidden = !human;
  $("resume").disabled = switching || busy || unavailable;
  for (const element of document.querySelectorAll(
    "[data-action], [data-key], #text, #send-text, #tabs",
  ))
    element.disabled = !human || busy || unavailable || (desktop && !desktopConnected);
  if (!human) {
    $("text").value = "";
    clearScreen();
  }
}

function action(value) {
  const revision = state?.revision;
  const epoch = inputEpoch;
  actionTail = actionTail
    .then(async () => {
      if (
        state?.control !== "human" ||
        state.revision !== revision ||
        busy ||
        stopped || !connected || epoch !== inputEpoch || performance.now() >= deadlineAt
      )
        return;
      if (state.transport === "desktop") desktopAction(value);
      else await api("actions", "POST", value);
    })
    .catch(failedRequest);
  return actionTail;
}

async function transfer(operation) {
  if (!connected || stopped || busy) return;
  observationEpoch++;
  inputEpoch++;
  busy = true;
  disconnectDesktop();
  if (state) render(state);
  $("message").textContent = "正在交接控制权…";
  try {
    const next = await api(
      operation,
      "POST",
      operation === "takeover" ? { reason: "用户主动接管浏览器" } : {},
    );
    accept(next);
    $("message").textContent =
      operation === "resume"
        ? next.control === 'human' ? next.reason : "已交还。Agent 可以继续使用当前登录会话。"
        : "已接管，可以在左侧操作。";
  } catch (error) {
    failedRequest(error);
  } finally {
    observationEpoch++;
    busy = false;
    if (state) render(state);
  }
}

$("reconnect").onclick = () => location.reload();
$("end-session").onclick = async () => {
  if (stopped || busy) return;
  busy = true; observationEpoch++; inputEpoch++; disconnectDesktop();
  if (state) render(state);
  $('message').textContent = '正在结束会话并回收临时浏览器…';
  try {
    await api('', 'DELETE'); stopped = true;
    clearScreen(); $('message').textContent = '会话已结束，临时浏览器已回收。主动保存的登录配置仍保留。';
  } catch (error) { failedRequest(error); }
  finally { busy = false; if (state) render(state); connectionStatus(); }
};
window.addEventListener("offline", () => failedRequest(new Error("offline")));
$("extend").onclick = async () => {
  if (!connected || stopped || busy) return;
  busy = true;
  observationEpoch++;
  if (state) render(state);
  try {
    accept(await api("extend", "POST", {}));
    $("message").textContent = "会话已续期。";
  } catch (error) { failedRequest(error); }
  finally { observationEpoch++; busy = false; if (state) render(state); }
};
setInterval(() => {
  expiryStatus();
  if (state && performance.now() >= deadlineAt && connected && !stopped) {
    inputEpoch++;
    clearScreen();
    render(state);
  }
}, 1000);

$("takeover").onclick = () => transfer("takeover");
$("resume").onclick = () => transfer("resume");
for (const button of document.querySelectorAll("[data-action]"))
  button.onclick = () => action({ type: button.dataset.action });
for (const button of document.querySelectorAll("[data-key]"))
  button.onclick = () => action({ type: "press", key: button.dataset.key });
$("tabs").onchange = (event) =>
  action({ type: "selectTab", tabId: event.target.value });
$("text-form").onsubmit = (event) => {
  event.preventDefault();
  const text = $("text").value;
  $("text").value = "";
  if (text) void action({ type: "type", text });
};
$("screen").onclick = (event) => {
  const rect = $("screen").getBoundingClientRect();
  $("screen-wrap").focus();
  void action({
    type: "pointer",
    x: ((event.clientX - rect.left) * 1280) / rect.width,
    y: ((event.clientY - rect.top) * 800) / rect.height,
  });
};
$("screen-wrap").addEventListener(
  "wheel",
  (event) => {
    if (state?.control !== "human" || state.transport === "desktop") return;
    event.preventDefault();
    void action({
      type: "scroll",
      x: Math.max(-5000, Math.min(5000, event.deltaX)),
      y: Math.max(-5000, Math.min(5000, event.deltaY)),
    });
  },
  { passive: false },
);
$("screen-wrap").onkeydown = (event) => {
  if (
    state?.control !== "human" ||
    state.transport === "desktop" ||
    event.isComposing ||
    ["Shift", "Control", "Alt", "Meta"].includes(event.key)
  )
    return;
  event.preventDefault();
  if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    void action({ type: "type", text: event.key });
  } else {
    const keys = [];
    if (event.ctrlKey || event.metaKey) keys.push("Control");
    if (event.altKey) keys.push("Alt");
    if (event.shiftKey) keys.push("Shift");
    keys.push(event.key === " " ? "Space" : event.key);
    void action({ type: "press", key: keys.join("+") });
  }
};

async function poll() {
  const epoch = observationEpoch;
  try {
    if (busy) return;
    const next = await api();
    if (busy || epoch !== observationEpoch) return;
    accept(next);
    if (next.control === "human" && !busy) {
      if (next.transport === "desktop") {
        connectDesktop();
        return;
      }
      const blob = await api("screen");
      if (
        state.control === "human" &&
        state.revision === next.revision &&
        !busy
      ) {
        const previous = imageUrl;
        imageUrl = URL.createObjectURL(blob);
        $("screen").src = imageUrl;
        $("screen").hidden = false;
        $("placeholder").hidden = true;
        if (previous) URL.revokeObjectURL(previous);
      }
      const { result: tabs } = await api("actions", "POST", { type: "tabs" });
      if (document.activeElement !== $("tabs")) {
        $("tabs").replaceChildren(
          ...tabs.map((tab) => {
            const option = document.createElement("option");
            option.value = tab.id;
            option.textContent = tab.title || tab.url;
            option.selected = tab.active;
            return option;
          }),
        );
      }
    }
  } catch (error) {
    // A poll racing a successful transfer is expected to lose its old control lease.
    if (epoch !== observationEpoch) return;
    failedRequest(error);
    if (stopped) {
      clearScreen();
      $("state").textContent = "会话不可用";
      for (const control of document.querySelectorAll("button, input, select"))
        control.disabled = true;
      connectionStatus();
    }
  } finally {
    if (!stopped) setTimeout(poll, Math.min(8000, 800 * 2 ** Math.min(failures, 4)));
  }
}
void poll();
