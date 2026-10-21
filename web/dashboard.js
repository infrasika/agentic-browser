import { requestJson } from "/request.js";
import { team, browserHeaders, mountAccount, defaultStartUrl } from "/team-client.js";
const $ = (id) => document.getElementById(id);
const token = $("token");
token.value = sessionStorage.getItem("agent-token") || "";
$("url").value = defaultStartUrl;

async function api(path, method = "GET", body) {
  if (!team) sessionStorage.setItem("agent-token", token.value);
  return requestJson(path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: team ? browserHeaders() : { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

const labels = { agent: "Agent working", human: "Waiting for you", switching: "Transferring control", closed: "Closed" };
async function refresh() {
  const [{ sessions }, { profiles, available }] = await Promise.all([api("/api/sessions"), api("/api/profiles")]);
  const agentKeys = team ? (await api("/api/credentials")).credentials : [];
  $("sessions").replaceChildren();
  if (!sessions.length) $("sessions").textContent = "No sessions yet. Create a browser above.";
  for (const session of sessions) {
    const { article, controls } = row(session.purpose,
      `${session.id.slice(0, 8)} · ${labels[session.control]} · ${session.profile?.name ?? "Temporary session"} · expires ${new Date(session.expiresAt).toLocaleTimeString("en-US")}`);
    controls.append(button("Open / resume control ↗", async () => {
      const { humanUrl } = await api(`/api/sessions/${session.id}/human-link`, "POST", {});
      location.assign(humanUrl);
    }));
    if (team && agentKeys.length) {
      const select = document.createElement("select"); select.setAttribute("aria-label", "Select an Agent for this session");
      select.add(new Option("Select an Agent to connect", ""));
      for (const key of agentKeys) select.add(new Option(key.name, key.id));
      controls.append(select, button("Connect Agent and take control", async () => {
        if (!select.value) throw new Error("Select an Agent first.");
        await api(`/api/human/${session.id}/bind-agent`, "POST", { credentialId: select.value });
        location.assign((await api(`/api/sessions/${session.id}/human-link`, "POST", {})).humanUrl);
      }));
    }
    controls.append(button("Extend", async () => {
      await api(`/api/sessions/${session.id}/extend`, "POST", {});
      await refresh();
      $("message").textContent = "Session extended.";
    }));
    controls.append(button("Close", async () => {
      await api(`/api/sessions/${session.id}`, "DELETE");
      await refresh();
    }, "quiet"));
    $("sessions").append(article);
  }
  const selected = $("profile").value;
  $("profile").replaceChildren(new Option("Temporary session · cleared on close", ""));
  if (available) $("profile").add(new Option("New profile · save login state", "new"));
  for (const profile of profiles) $("profile").add(new Option(`Use saved profile: ${profile.name}`, profile.id));
  if ([...$("profile").options].some((option) => option.value === selected)) $("profile").value = selected;
  $("profile-hint").textContent = available
    ? "Saved login state stays on the deployment server until you delete the profile. Temporary sessions do not save it."
    : "This browser mode only supports temporary sessions. Saving login state requires desktop mode.";
  profileChanged();
  $("profiles").replaceChildren();
  if (!profiles.length) $("profiles").textContent = "No saved login profiles yet.";
  for (const profile of profiles) {
    const active = sessions.some((session) => session.profile?.id === profile.id);
    const { article, controls } = row(profile.name, active ? "In use · close the session before reopening or deleting" : "Saved · available for new sessions");
    const use = button("Use for a new session", async () => {
      $("profile").value = profile.id;
      profileChanged();
      $("purpose").focus();
      $("create-form").scrollIntoView({ behavior: "smooth" });
    });
    const remove = button("Delete profile", async () => {
      if (!confirm(`Delete profile “${profile.name}”? This permanently removes its local login state for all websites.`)) return;
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
  $("message").textContent = "Starting the browser…";
  try {
    let profileId = $("profile").value;
    if (profileId === "new") {
      const profile = await api("/api/profiles", "POST", { name: $("profile-name").value });
      profileId = profile.id;
      $("profile").add(new Option(`Use saved profile: ${profile.name}`, profile.id));
      $("profile").value = profile.id;
      profileChanged();
    }
    await api("/api/sessions", "POST", {
      purpose: $("purpose").value, url: $("url").value,
      ...(profileId ? { profileId } : {}),
    });
    await refresh();
    $("message").textContent = "Browser ready. Click “Open / resume control” below to begin.";
  } catch (error) { $("message").textContent = error.message; }
  finally { $("create").disabled = false; }
};
$("refresh").onclick = () => refresh().catch((error) => { $("message").textContent = error.message; });
token.onchange = () => refresh().catch((error) => { $("message").textContent = error.message; });
async function refreshStatus() {
  const button = $("refresh-status"); button.disabled = true;
  try {
    const data = await api('/api/service-status');
    const lines = [
      `Controller: ${data.version} (${data.revision.slice(0, 12)})`,
      `Browsers: ${data.capacity.currentSessions} / ${data.capacity.maxSessions} slots in use; ${data.ownSessions} yours. ${data.capacity.full ? 'Full — close an idle session or retry later.' : ''}`,
      `Agent endpoint: ${data.mcp.url} — ${data.mcp.authentication}. ${data.mcp.message}`,
    ];
    if (data.checks) {
      const c = data.checks;
      lines.push(`Browser mode: ${c.browserMode} · ${c.platform}`,
        `Docker: ${c.docker.message}`, `Runtime: ${c.runtime.message}`,
        `Storage: ${c.storage.message}${c.storage.freeMiB === undefined ? '' : ` (${c.storage.freeMiB} MiB free)`}`,
        `Checked: ${new Date(c.checkedAt).toLocaleTimeString('en-US')}. Checks are cached for up to 15 seconds.`);
    }
    $('service-status').replaceChildren(...lines.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  } catch (error) { $('service-status').textContent = error.message; }
  finally { button.disabled = false; }
}
$('refresh-status').onclick = refreshStatus;
await mountAccount(api);
if (team || token.value) void refreshStatus();
if (team || token.value) void refresh().catch((error) => { $("message").textContent = error.message; });
