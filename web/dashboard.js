import { team, browserHeaders, mountAccount, defaultStartUrl } from "/team-client.js";
const $ = (id) => document.getElementById(id);
const token = $("token");
token.value = sessionStorage.getItem("agent-token") || "";
$("url").value = defaultStartUrl;

async function api(path, method = "GET", body) {
  if (!team) sessionStorage.setItem("agent-token", token.value);
  const response = await fetch(path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: team ? browserHeaders() : { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "请求失败");
  return data;
}

function button(label, handler, className = "secondary") {
  const element = document.createElement("button");
  element.textContent = label;
  element.className = className;
  element.onclick = async () => {
    element.disabled = true;
    try { await handler(); }
    catch (error) { $("message").textContent = error.message; }
    finally { element.disabled = false; }
  };
  return element;
}

function row(title, description) {
  const article = document.createElement("article");
  article.className = "session-row";
  const details = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = title;
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = description;
  details.append(name, meta);
  const controls = document.createElement("div");
  controls.className = "row-actions";
  article.append(details, controls);
  return { article, controls };
}

const labels = { agent: "Agent 执行中", human: "等待人工操作", switching: "正在交接", closed: "已结束" };
async function refresh() {
  const [{ sessions }, { profiles, available }] = await Promise.all([api("/api/sessions"), api("/api/profiles")]);
  const agentKeys = team ? (await api("/api/credentials")).credentials : [];
  $("sessions").replaceChildren();
  if (!sessions.length) $("sessions").textContent = "还没有会话。从上方创建一个浏览器。";
  for (const session of sessions) {
    const { article, controls } = row(session.purpose,
      `${session.id.slice(0, 8)} · ${labels[session.control]} · ${session.profile?.name ?? "临时会话"} · ${new Date(session.expiresAt).toLocaleTimeString()} 到期`);
    controls.append(button("打开 / 恢复接管 ↗", async () => {
      const { humanUrl } = await api(`/api/sessions/${session.id}/human-link`, "POST", {});
      location.assign(humanUrl);
    }));
    if (team && agentKeys.length) {
      const select = document.createElement("select"); select.setAttribute("aria-label", "选择会话的 Agent");
      select.add(new Option("选择要绑定的 Agent", ""));
      for (const key of agentKeys) select.add(new Option(key.name, key.id));
      controls.append(select, button("绑定并接管", async () => {
        if (!select.value) throw new Error("请先选择一个 Agent。");
        await api(`/api/human/${session.id}/bind-agent`, "POST", { credentialId: select.value });
        location.assign((await api(`/api/sessions/${session.id}/human-link`, "POST", {})).humanUrl);
      }));
    }
    controls.append(button("续期", async () => {
      await api(`/api/sessions/${session.id}/extend`, "POST", {});
      await refresh();
      $("message").textContent = "会话已续期。";
    }));
    controls.append(button("结束", async () => {
      await api(`/api/sessions/${session.id}`, "DELETE");
      await refresh();
    }, "quiet"));
    $("sessions").append(article);
  }
  const selected = $("profile").value;
  $("profile").replaceChildren(new Option("临时会话 · 结束后清理", ""));
  if (available) $("profile").add(new Option("新建配置 · 保存登录状态", "new"));
  for (const profile of profiles) $("profile").add(new Option(`使用已保存的配置：${profile.name}`, profile.id));
  if ([...$("profile").options].some((option) => option.value === selected)) $("profile").value = selected;
  $("profile-hint").textContent = available
    ? "选择保存后，登录状态将留在 Ubuntu 服务器，直到你删除配置。默认临时会话不会保存。"
    : "当前浏览器模式只支持临时会话。保存登录状态需要远程桌面模式。";
  profileChanged();
  $("profiles").replaceChildren();
  if (!profiles.length) $("profiles").textContent = "尚未保存登录配置。";
  for (const profile of profiles) {
    const active = sessions.some((session) => session.profile?.id === profile.id);
    const { article, controls } = row(profile.name, active ? "正在使用 · 结束会话后才能再次打开或删除" : "已保存 · 可用于新会话");
    const use = button("用于新会话", async () => {
      $("profile").value = profile.id;
      profileChanged();
      $("purpose").focus();
      $("create-form").scrollIntoView({ behavior: "smooth" });
    });
    const remove = button("删除配置", async () => {
      if (!confirm(`删除「${profile.name}」？这会清除配置中所有网站的本地登录状态，无法恢复。`)) return;
      await api(`/api/profiles/${profile.id}`, "DELETE");
      await refresh();
    }, "quiet");
    use.disabled = remove.disabled = active;
    controls.append(use, remove);
    $("profiles").append(article);
  }
}

function profileChanged() {
  const creating = $("profile").value === "new";
  $("new-profile").hidden = !creating;
  $("profile-name").required = creating;
}
$("profile").onchange = profileChanged;
$("create-form").onsubmit = async (event) => {
  event.preventDefault();
  $("create").disabled = true;
  $("message").textContent = "正在启动浏览器…";
  try {
    let profileId = $("profile").value;
    if (profileId === "new") {
      const profile = await api("/api/profiles", "POST", { name: $("profile-name").value });
      profileId = profile.id;
      $("profile").add(new Option(`使用已保存的配置：${profile.name}`, profile.id));
      $("profile").value = profile.id;
      profileChanged();
    }
    await api("/api/sessions", "POST", {
      purpose: $("purpose").value, url: $("url").value,
      ...(profileId ? { profileId } : {}),
    });
    await refresh();
    $("message").textContent = "浏览器已就绪。点击下方「打开 / 恢复接管」开始体验。";
  } catch (error) { $("message").textContent = error.message; }
  finally { $("create").disabled = false; }
};
$("refresh").onclick = () => refresh().catch((error) => { $("message").textContent = error.message; });
token.onchange = () => refresh().catch((error) => { $("message").textContent = error.message; });
await mountAccount(api);
if (team || token.value) void refresh().catch((error) => { $("message").textContent = error.message; });
