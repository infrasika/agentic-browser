"""Idle daily backups for one installation; invoked under agentctl's operation lock."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import agentctl as ctl

POLICY = 'agentic-browser-backup-policy-v1'
NAME = re.compile(r'\d{8}T\d{6}Z-[a-f0-9]{8}')


def validate(value, root):
    expected = {'kind', 'timeZone', 'hour', 'keep', 'retryMinutes', 'copyTo'}
    if set(value) != expected or value['kind'] != POLICY:
        raise ctl.Failure('invalid_backup_policy')
    for key, low, high in [('hour', 0, 23), ('keep', 1, 365), ('retryMinutes', 1, 1440)]:
        if type(value[key]) is not int or not low <= value[key] <= high:
            raise ctl.Failure('invalid_backup_policy')
    try: ZoneInfo(value['timeZone'])
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ctl.Failure('invalid_backup_timezone; install host tzdata') from None
    if value['copyTo'] is not None:
        dest = Path(value['copyTo'])
        if not dest.is_absolute() or dest.resolve() != dest or dest == root or root in dest.parents or dest in root.parents:
            raise ctl.Failure('backup_copy_requires_separate_absolute_directory')
    return value


def status(install):
    path = install.root / 'config/backup.json'
    policy = validate(ctl.read_json(path), install.root) if path.exists() else None
    path = install.root / 'state/backup-status.json'
    state = ctl.read_json(path) if path.exists() else {}
    return {'configured': policy is not None, 'policy': policy, 'state': state,
            'maintenancePending': install.intent.exists() or install.gate.exists()}


def unit_quote(value):
    # systemd has its own expansion rules, not shell rules.
    return json.dumps(str(value).replace('%', '%%').replace('$', '$$'))


def configure(install, args):
    policy = validate({'kind': POLICY, 'timeZone': args.timezone, 'hour': args.hour,
                       'keep': args.keep, 'retryMinutes': args.retry_minutes,
                       'copyTo': str(args.copy_to.absolute()) if args.copy_to else None}, install.root)
    if policy['copyTo']: ctl.private(Path(policy['copyTo']), True)
    ctl.install_tools(install.root)
    ctl.atomic(install.root / 'config/backup.json', policy)
    units = install.root / 'state/systemd'; units.mkdir(mode=0o700, exist_ok=True)
    ctl.private(units, True)
    name = 'agentic-backup-' + install.meta['project']
    command = ' '.join(unit_quote(v) for v in [sys.executable, install.root / 'agentctl.py', '--directory', install.root, 'maintain'])
    ctl.atomic(units / (name + '.service'), '[Unit]\nDescription=Private Agent idle backup and recovery\n'
               '[Service]\nType=oneshot\nUMask=0077\nExecStart=' + command + '\n'
               'TimeoutStartSec=60min\nTimeoutStopSec=5min\nKillMode=control-group\n')
    ctl.atomic(units / (name + '.timer'), '[Unit]\nDescription=Check private Agent backup and recovery each minute\n'
               '[Timer]\nOnCalendar=*-*-* *:*:00 UTC\nPersistent=true\nRandomizedDelaySec=10\n'
               '[Install]\nWantedBy=timers.target\n')
    return {'configured': True, 'unitDirectory': str(units), 'timer': name + '.timer',
            'next': 'Link both units with systemctl --user link, then enable --now the timer. Enable user lingering for boot recovery.'}


def mirror(install, policy, backup):
    if not policy['copyTo']: return
    base = Path(policy['copyTo'])
    # Never silently create a missing destination root on the local filesystem.
    ctl.private(base, True)
    if base.resolve() != base: raise ctl.Failure('backup_copy_path_changed')
    target = base / install.meta['project']; target.mkdir(mode=0o700, exist_ok=True)
    ctl.private(target, True)
    final = target / backup.name
    if final.exists() or final.is_symlink():
        ctl.verify_backup(final)
        if ctl.digest(final / 'manifest.json') != ctl.digest(backup / 'manifest.json'):
            raise ctl.Failure('backup_copy_collision')
        return
    pending = target / ('.pending-' + backup.name + '-' + uuid.uuid4().hex)
    try:
        shutil.copytree(backup, pending, symlinks=True)
        ctl.verify_backup(pending)
        pending.rename(final)
    finally:
        if pending.exists(): shutil.rmtree(pending)


def prune(install, policy, state):
    # Only backups explicitly recorded by this scheduler can be pruned. Manual,
    # pre-upgrade and incomplete backups are intentionally outside this list.
    names = state.get('managedBackups', [])
    if not isinstance(names, list) or len(set(names)) != len(names) or any(not isinstance(n, str) or not NAME.fullmatch(n) for n in names):
        raise ctl.Failure('invalid_managed_backup_list')
    for name in names[:-policy['keep']]:
        original = install.root / 'backups' / name
        if original.exists() or original.is_symlink():
            ctl.verify_backup(original)
            shutil.rmtree(original)
        if policy['copyTo']:
            copied = Path(policy['copyTo']) / install.meta['project'] / name
            if copied.exists() or copied.is_symlink():
                ctl.verify_backup(copied)
                shutil.rmtree(copied)
    state['managedBackups'] = names[-policy['keep']:]


def tick(install, now=None):
    now = now or datetime.now(timezone.utc)
    path = install.root / 'state/backup-status.json'
    state = ctl.read_json(path) if path.exists() else {}

    def save(result, **fields):
        state.update(fields, status=result, checkedAt=now.isoformat())
        ctl.atomic(path, state)
        return {'status': result, **fields}

    try:
        # The lock proves the original operator is gone. Only interrupted plain
        # backups are safe to resume; upgrades/restores always need human review.
        if install.intent.exists():
            intent = ctl.read_json(install.intent)
            if intent.get('kind') != ctl.KIND or intent.get('operation') != 'backup' or intent.get('phase') not in ['drain', 'stopping']:
                return save('operator_required')
            install.recover()
            return save('recovered_interrupted_backup')
        if install.gate.exists(): return save('operator_required')
        policy_path = install.root / 'config/backup.json'
        if not policy_path.exists(): return save('not_configured')
        policy = validate(ctl.read_json(policy_path), install.root)
        local = now.astimezone(ZoneInfo(policy['timeZone']))
        retry = state.get('lastAttemptAt')
        if retry and now < datetime.fromisoformat(retry) + timedelta(minutes=policy['retryMinutes']):
            return {'status': 'retry_not_due'}
        pending = state.get('copyPending')
        if pending:
            if not isinstance(pending, str) or not NAME.fullmatch(pending): raise ctl.Failure('invalid_pending_copy')
            backup = install.root / 'backups' / pending
            ctl.verify_backup(backup)
        else:
            if state.get('lastSuccessDay') == local.date().isoformat() or local.hour < policy['hour']:
                return {'status': 'not_due'}
            save('checking_idle', lastAttemptAt=now.isoformat())
            if not install.idle(): return save('deferred_busy')
            backup = install.backup()
            # Persist the successful local snapshot before copying, so a copy
            # outage never causes repeated service interruptions every retry.
            state.setdefault('managedBackups', []).append(backup.name)
            save('local_backup_completed', lastSuccessDay=local.date().isoformat(),
                 lastBackup=backup.name, copyPending=backup.name)
        save('copying', lastAttemptAt=now.isoformat())
        mirror(install, policy, backup)
        prune(install, policy, state)
        return save('completed', copyPending=None, lastCompletedAt=now.isoformat())
    except (ctl.Failure, OSError, ValueError, KeyError, TypeError) as error:
        # Do not put command output, email addresses or secrets into the journal.
        code = str(error).split(';', 1)[0] if isinstance(error, ctl.Failure) else 'filesystem_or_configuration_error'
        save('failed', lastAttemptAt=now.isoformat(), failureCode=code)
        raise ctl.Failure('maintenance_failed; inspect private state and service readiness') from None
