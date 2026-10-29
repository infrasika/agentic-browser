# Public Agent demo

Open [agentic-browser.zkpass.org](https://agentic-browser.zkpass.org/), register a local account, complete the human verification and log in. The same login page serves ordinary users and administrators; permissions come from the account role.

Choose the GitHub example in chat. The Agent opens GitHub in the browser panel and asks you to take control. Sign in there, including any verification steps, then click Done to return control. The Agent resumes and counts the private repositories owned by your account, checking pagination and listing their names. Repositories you can access through other owners or organizations are a different scope; specify that scope explicitly if needed.

Enter passwords, one-time codes and other sign-in secrets only in the remote browser while you have control. Do not send them as chat messages. The browser belongs to this session and does not reuse your local browser's login. After control is returned, the Agent can read the signed-in pages needed for the task.

Accounts have separate chat history and credits. Each account can hold one browser session; when all available browser slots are busy, the task queues. Admission capacity is chosen by the operator, with a hard ceiling of ten. Personal credits and the shared daily budget can also prevent a new model request. These public limits are not a resource guarantee for self-hosted installations.

Use the account password recovery flow if email is configured. Administrators additionally have an operations interface for users, balances and the site budget; ordinary users cannot access it.

The demo includes its Agent and model configuration. For your own complete installation, see the [Agent installation guide](DEPLOYMENT.md).
