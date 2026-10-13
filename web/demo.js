function showAccount() {
  const name = sessionStorage.getItem("demo-user");
  if (!name) return;
  document.getElementById("login").hidden = true;
  document.getElementById("account").hidden = false;
  document.getElementById("welcome").textContent = `已登录：${name}`;
}
document.getElementById("login").onsubmit = (event) => {
  event.preventDefault();
  sessionStorage.setItem(
    "demo-user",
    document.getElementById("username").value,
  );
  document.getElementById("password").value = "";
  showAccount();
};
document.getElementById("continue").onclick = () => {
  document.getElementById("result").textContent =
    "任务完成：Agent 已在人工登录后的同一个会话中继续操作。";
};
showAccount();
