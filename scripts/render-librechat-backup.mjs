import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.deployment/librechat');
const path = `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const service = `[Unit]
Description=Idle backup and Mongo restore verification for Browser Demo
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=${root}
Environment="PATH=${path}"
UMask=0077
RuntimeDirectory=librechat-backup
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
ExecStart=/usr/bin/python3 ${root}/scripts/backup-librechat.py --scheduled
ExecStopPost=/usr/bin/python3 ${root}/scripts/backup-librechat.py --recover
TimeoutStartSec=6min
TimeoutStopSec=2min
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
`;
const timer = `[Unit]
Description=Daily Browser Demo backup with hourly idle retries

[Timer]
OnCalendar=*-*-* 04..23:00:00 Asia/Shanghai
RandomizedDelaySec=5min
Persistent=true
Unit=librechat-browser-backup.service

[Install]
WantedBy=timers.target
`;
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, 'librechat-browser-backup.service'), service, { mode: 0o600 });
await writeFile(resolve(directory, 'librechat-browser-backup.timer'), timer, { mode: 0o600 });
console.log('Rendered backup service and timer. Installation is a separate deployment step.');
