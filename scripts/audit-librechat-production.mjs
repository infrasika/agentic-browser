import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only production evidence. Reports contain aggregate checks, never account
// identities, messages, private page contents, credentials, or individual balances.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, '../librechat-agent/package.json'));
const { MongoClient } = require('mongodb');
const config = JSON.parse(await readFile(resolve(root, '.deployment/librechat/production.yaml'), 'utf8'));
const client = await MongoClient.connect('mongodb://127.0.0.1:27019/LibreChatBrowserDemo');
const ledger = new DatabaseSync(resolve(root, '.data/librechat-browser/scheduler.sqlite'), { readOnly: true });
const checks = [];
let report;
try {
  const db = client.db();
  const users = await db.collection('users').find({
    role: 'USER', provider: 'local', email: { $not: /@demo-acceptance\.invalid$/ },
  }, { projection: { _id: 1 } }).toArray();
  assert.ok(users.length > 0, 'No ordinary local account exists yet');
  assert.equal(config.balance.autoRefillEnabled, false);
  assert.equal(config.turnstile.verification.required, true);
  assert.equal(config.turnstile.verification.hostname, 'agentic-browser.zkpass.org');
  checks.push('ordinary_local_account_exists', 'production_turnstile_required');
  let reconciled = 0;
  let usedAccounts = 0;
  for (const user of users) {
    const [balance, usage] = await Promise.all([
      db.collection('balances').findOne({ user: user._id }),
      db.collection('transactions').aggregate([
        { $match: { user: user._id } },
        { $group: { _id: null, value: { $sum: '$tokenValue' }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    assert.ok(balance, 'Ordinary account is missing its balance');
    assert.equal(balance.autoRefillEnabled, false);
    // Compare only idle accounts; reservations/in-flight deductions need a later snapshot.
    const active = ledger.prepare("SELECT COUNT(*) AS n FROM leases WHERE userId = ? AND state IN ('queued','starting','active','closing','cleanup_pending')").get(String(user._id)).n;
    if (active || balance.reservedCredits > 0) continue;
    const adminCredits = (balance.adminCredits ?? []).reduce((sum, adjustment) => sum + adjustment.credits, 0);
    const inferredStart = balance.tokenCredits - (usage[0]?.value ?? 0) - adminCredits;
    assert.ok(Math.abs(inferredStart - config.balance.startBalance) < 0.01,
      'Idle account balance and transaction ledger do not reconcile to the configured initial credits');
    reconciled += 1;
    if (usage[0]?.count) usedAccounts += 1;
  }
  assert.ok(reconciled > 0, 'No idle ordinary account was available for balance reconciliation');
  checks.push('ordinary_accounts_have_independent_balances', 'initial_credits_reconcile_with_actual_usage', 'auto_refill_disabled');
  const userIds = users.map(user => String(user._id));
  const placeholders = userIds.map(() => '?').join(',');
  const returnedTasks = ledger.prepare(`SELECT COUNT(DISTINCT conversationId) AS n FROM events WHERE type = 'control_returned' AND userId IN (${placeholders})`).get(...userIds).n;
  const completedTasks = ledger.prepare(`SELECT COUNT(*) AS n FROM leases WHERE state = 'completed' AND userId IN (${placeholders})`).get(...userIds).n;
  assert.ok(returnedTasks > 0, 'No ordinary account has returned browser control yet');
  assert.ok(completedTasks > 0, 'No completed ordinary-account browser task is recorded yet');
  checks.push('ordinary_account_control_return_recorded', 'ordinary_account_browser_task_completed');
  report = {
    passed: true, completedAt: new Date().toISOString(), checks,
    ordinaryAccounts: users.length, reconciledAccounts: reconciled, accountsWithUsage: usedAccounts,
    initialCredits: config.balance.startBalance, returnedTasks, completedTasks,
    scope: 'Read-only production account, balance, transaction and browser-ledger audit; does not automate a new Turnstile challenge or independently verify GitHub contents.',
  };
} catch (error) {
  report = { passed: false, completedAt: new Date().toISOString(), checks, reason: error instanceof assert.AssertionError ? error.message : 'Production audit failed; inspect dependencies privately.' };
  process.exitCode = 1;
} finally {
  ledger.close();
  await client.close();
  await mkdir(resolve(root, 'output/librechat'), { recursive: true });
  await writeFile(resolve(root, 'output/librechat/production-audit.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
