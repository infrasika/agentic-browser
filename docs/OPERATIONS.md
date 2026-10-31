# Operations

Maintain an existing installation using Docker and Compose. For first installation, use [Deployment](DEPLOYMENT.md); for file, parameter and storage definitions, use [Configuration](CONFIGURATION.md). Run all commands below from the directory containing `compose.yaml`, keeping its project name unchanged.

`ops` is an on-demand management container with no public interface. Use the application's administrator interface to adjust balances and the daily budget.

## Health and manual backups

```bash
docker compose run --rm ops status
docker compose run --rm ops backup
```

`status` reports health, maintenance state and the latest scheduled-backup receipt. Backup requires no active Agent or browser tasks; retry later if busy. It enables maintenance, drains requests, stops writers, archives data and resumes service. The result's `backup` field gives the completed directory, such as `backups/20261031T040000Z-1234abcd`.

Backups include `settings.json`, `secrets.env`, the current `compose.yaml` and all nine application data/configuration volumes in the [storage reference](CONFIGURATION.md#persistent-data), including MongoDB, Redis and identity keys. The `operations` volume is excluded: locks and maintenance state belong to the target installation.

Also excluded are `.env`, host Nginx configuration/certificates, image layers, custom mounts and override files. Save host configuration separately and ensure the release images remain available. Restoration preserves the target's `.env` project name, bind address, port and backup schedule.

Files are SHA256-checked; incomplete `.pending-*` directories cannot be restored. Verify a completed backup, replacing `BACKUP_ID` with its directory name:

```bash
docker compose run --rm ops verify-backup backups/BACKUP_ID
```

Keep backups private, copy the entire completed directory off-host and test restoration. Persistent volumes alone do not protect against losing the server or disk.

## Daily backup scheduling

Set the schedule in the deployment `.env`, for example:

```dotenv
AGENT_BACKUP_TIMEZONE=Asia/Shanghai
AGENT_BACKUP_HOUR=4
AGENT_BACKUP_KEEP=7
```

```bash
docker compose --profile backups up -d backup
docker compose logs --tail 20 backup
```

The scheduler checks every minute and backs up when idle after the configured hour; missed schedules run later, without repeating a successful day. It shares the operations lock and defers during maintenance. Retention also counts manual and pre-upgrade backups. See [Compose parameters](CONFIGURATION.md#compose-env-and-interpolation) for defaults and limits; repeat `up` after changing them.

## Restore into a new project

Test restoration in a new deployment directory and Compose project. Obtain files from the backed-up application version, use a supported Linux architecture and copy the entire backup directory into `backups/`. Configure a different project name and unused port in the new directory's `.env`:

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

Verify accounts, chats, credits and browser behavior before directing traffic to the restored project. Restore rejects corrupt backups and refuses to overwrite an existing project by default. Add `--replace` only to intentionally replace all its data. Restore does not convert database formats; database major-version changes need separate validation.

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

Choose shutdown and recovery actions with their data effects in mind:

| Action | Effect |
| --- | --- |
| `stop` | Retains containers, networks and data; use the procedure above to apply changed inputs |
| `restart` | Retains data but does not regenerate input configuration |
| `docker compose --profile '*' down` without volume removal | Retains data, removes containers/networks; recheck `trustedProxyIPs` after network recreation |
| Change `COMPOSE_PROJECT_NAME` | Selects different volumes and can look like a fresh installation; check the original name before recovery |
| `down -v`, `down --volumes`, or deletion/pruning of volumes | Deletes stored data; never use these to repair an installation you want to keep |

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

Apply the [configuration update](#change-configuration-or-stop-the-site), then send a test message to an address you own:

```bash
docker compose run --rm ops mail-test --to your-address@example.com
docker compose restart agent
docker compose up -d --wait agent
```

This command sends real email. Confirm both an accepted response and actual receipt; SMTP acceptance alone does not prove inbox delivery. The verified receipt is stored in the configuration volume, and Agent enables Forgot Password after restarting. Changing origin, sending settings or credentials invalidates the old receipt and requires retesting.

Other SMTP providers use the same fields, with implicit TLS (`tls`) or mandatory STARTTLS (`starttls`) and certificate verification. Without email, use [account password reset](#create-accounts-and-reset-passwords).

## Troubleshooting

```bash
docker compose ps -a
docker compose logs --tail 50 init agent browser gateway
```

Use logs and `ops status` to identify the failure:

| Problem | Action |
| --- | --- |
| Initialization rejected configuration | Correct the reported fields and repeat the configuration update; preserve volumes |
| Interrupted ordinary backup | Run `docker compose run --rm ops recover` to clean up archive helpers and resume service |
| Incomplete upgrade or destructive restore | Follow rollback or repeat restore from a verified backup; `recover` refuses to bypass these operations |

Do not remove the `operations` volume or maintenance markers to bypass a failure. Redact secrets, email addresses, user content and session information before sharing logs.
