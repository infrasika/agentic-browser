function showAccount() {
  const name = sessionStorage.getItem("demo-user");
  if (!name) return;
  document.getElementById("login").hidden = true;
  document.getElementById("account").hidden = false;
  document.getElementById("welcome").textContent = `Signed in: ${name}`;
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
    "Task complete: the Agent continued in the same session after the human signed in.";
};
showAccount();
