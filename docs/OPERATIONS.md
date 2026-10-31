# Operations

Run these commands from the directory containing `compose.yaml`. The server needs Docker and Compose; `ops` is an on-demand management container with no public interface. Site administrators use the application administrator interface to adjust balances and the daily budget.

## Health and manual backups

```bash
docker compose run --rm ops status
docker compose run --rm ops backup
```

`status` reports health, maintenance state and the latest scheduled-backup receipt. Backup requires no active Agent or browser tasks; if busy, it exits so you can retry later. It enables maintenance, drains requests, stops writers and saves complete application data before restoring service. The result's `backup` field is relative to the deployment directory, such as `backups/20261031T040000Z-1234abcd`.

Backups include both input configuration files, the current Compose file and nine application data/configuration volumes, including identity keys. Files are SHA256-checked. Incomplete `.pending-*` directories are not restorable backups. Keep archives private and copy the entire completed directory for off-host storage. Target project name, bind address and port come from the target's `.env`; they are not overwritten by a backup.

Replace `BACKUP_ID` below with the actual completed directory name:

```bash
docker compose run --rm ops verify-backup backups/BACKUP_ID
```

## Daily backup scheduling

Add or update these deployment `.env` values:

```dotenv
AGENT_BACKUP_TIMEZONE=Asia/Shanghai
AGENT_BACKUP_HOUR=4
AGENT_BACKUP_KEEP=7
```

```bash
docker compose --profile backups up -d backup
docker compose logs --tail 20 backup
```

The scheduler checks every minute. After the configured hour in that timezone, it backs up when the site is idle; missed schedules run later, and a successful day is not repeated. Retention keeps the newest seven completed backups by default. Manual and pre-upgrade backups count toward retention too. `AGENT_BACKUP_KEEP` accepts 1–365. The scheduler shares the manual-operations lock and defers during maintenance. Repeat the `up` command after changing its settings.

## Restore into a new project

First verify restoration in a new deployment directory and Compose project. Obtain matching release files containing `ops`, and copy the complete backup directory into the new deployment's `backups/`. Configure a different project name and unused port in its `.env`:

```dotenv
COMPOSE_PROJECT_NAME=agent-restored
AGENT_PORT=3334
AGENT_BIND=127.0.0.1
```

```bash
docker compose run --rm ops restore backups/BACKUP_ID
```

The tool verifies checksums and archive paths before restoring data and identity. It leaves services stopped with maintenance enabled. Inspect the restored `settings.json` and `secrets.env`. If changing the access domain or port, update `origin` before starting:

```bash
docker compose run --rm ops recover
docker compose run --rm ops status
```

Verify accounts, chats, credits and browser behavior before directing traffic to the restored project. Restore refuses to overwrite an existing project by default. Add `--replace` only when you intend to replace all its data with the backup. Corrupt backups are rejected before existing services are modified.

## Upgrade and rollback

Read the target release notes and verify its `SHA256SUMS`. Save the new `compose.yaml` under `releases/VERSION/compose.yaml` inside the active deployment directory. Do not overwrite the active Compose file or user configuration manually.

```bash
docker compose run --rm ops upgrade releases/VERSION/compose.yaml
docker compose run --rm ops status
```

Upgrade prepares images, checks for idle operation, takes a full backup, replaces the version and checks service health. A failure leaves maintenance enabled rather than exposing a possibly migrated database to old code. Rollback restores both the previous version and its complete pre-upgrade data:

```bash
docker compose run --rm ops rollback
```

If the new image cannot even run `ops`, start the old management tool using the pre-upgrade backup's Compose file:

```bash
docker compose --project-directory "$PWD" \
  -f backups/PRE_UPGRADE_BACKUP_ID/compose.yaml run --rm ops rollback
```

After an interrupted ordinary backup, `ops recover` cleans up archive helpers and resumes service. It refuses to bypass an incomplete upgrade or destructive restore: use `rollback` or restore again from a verified backup as appropriate. Do not remove maintenance markers manually.

## Create accounts and reset passwords

Editing `DEMO_ADMIN_PASSWORD` does not reset an existing account. Create a private temporary input file and edit it instead of passing passwords on the command line:

```bash
umask 077
touch account.json
chmod 600 account.json
nano account.json
```

For password reset, use this shape, replacing both values:

```json
{"email":"admin@example.com","password":"replace-with-your-new-password"}
```

```bash
docker compose run --rm -T ops user-reset < account.json
rm account.json
```

This resets a local administrator or ordinary account and revokes existing login sessions without sending email. For a new ordinary account, prepare a private file with these fields:

```json
{"email":"user@example.com","password":"replace-with-your-new-password","name":"Example User","username":"example-user"}
```

```bash
docker compose run --rm -T ops user-create < account.json
rm account.json
```

Use a unique username and a password of at least 12 characters. New accounts receive the configured initial credits once.

## Change configuration or stop the site

Wait for tasks to finish, take a backup, stop services, edit input configuration and regenerate runtime configuration:

```bash
docker compose run --rm ops backup
docker compose --profile '*' stop
# Edit settings.json and/or secrets.env now.
docker compose up -d --force-recreate
docker compose run --rm ops status
# Re-enable this if daily backup was previously running:
docker compose --profile backups up -d backup
```

`restart` alone does not regenerate input configuration. Preserve the project name and network. `stop` retains containers, networks and data volumes. To remove containers, `docker compose --profile '*' down` can be used without `-v` or `--volumes`; recheck the Docker gateway in `trustedProxyIPs` after network recreation.

Backups do not include image layers, host Nginx/certificates, custom extra mounts or override files. Keep these dependencies separately. Restore to the same application version and a supported CPU architecture; database major-version changes need separate validation. A named-volume backup is not a database-format converter.

## Enable email password recovery

The application uses one TLS SMTP implementation. For Cloudflare Email Sending, onboard and verify a sending domain such as `mail.example.com`, then create an API token with `Email Sending: Edit` for the correct account. Email Routing's inbound forwarding does not grant sending access. Availability and onboarding requirements are determined by Cloudflare.

Add this `smtp` object to the top level of your existing `settings.json`; merge the field rather than replacing the whole file:

```json
{
  "smtp": {
    "host": "smtp.mx.cloudflare.net",
    "port": 465,
    "encryption": "tls",
    "from": "noreply@mail.example.com",
    "username": "api_token"
  }
}
```

Set `SMTP_PASSWORD` to that token. The sender must belong to your verified sending domain, and `api_token` is the literal username. See [Cloudflare's SMTP parameters and permissions](https://developers.cloudflare.com/email-service/api/send-emails/smtp/).

Load the settings using the configuration-change procedure above, then explicitly send a test message to an address you own:

```bash
docker compose run --rm ops mail-test --to your-address@example.com
docker compose restart agent
docker compose up -d --wait agent
```

This command sends real email. Confirm both an accepted response and actual receipt; SMTP acceptance alone does not prove inbox delivery. The verified receipt is stored in the configuration volume, and Agent enables Forgot Password after restarting. Changing origin, sending settings or credentials invalidates the old receipt and requires retesting.

Other SMTP providers use the same fields, with implicit TLS (`tls`) or mandatory STARTTLS (`starttls`) and certificate verification. Without email, use `ops user-reset`. Backup, restore and upgrade themselves do not call the model or send email.

## Troubleshooting

```bash
docker compose ps -a
docker compose logs --tail 50 init agent browser gateway
docker compose run --rm ops status
```

For initialization errors, correct the reported configuration fields without deleting volumes. Resolve maintenance according to the recorded operation with recover, rollback or restore. Redact email addresses, user content and session information before sharing logs. Ordinary users cannot use the administrator interface even though all roles share the same login page.
