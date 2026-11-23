import { readFile } from 'node:fs/promises';

try {
  const secrets = JSON.parse(await readFile('.secrets.json', 'utf8'));
  const deployment = JSON.parse(await readFile('deployment.json', 'utf8'));
  const check = await fetch(`${deployment.url}/admin/check`, {
    method: 'POST', headers: { Authorization: `Bearer ${secrets.TELEGRAM_WEBHOOK_SECRET}` }, signal: AbortSignal.timeout(45000),
  });
  const result = await check.json();
  if (!check.ok) throw new Error(result.error || 'Readiness check failed.');
  console.log(`Notion schema, database connection and Telegram credentials verified. Bot: @${result.bot}`);
  const response = await fetch(`https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${deployment.url}/telegram`, secret_token: secrets.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !(await response.json()).ok) throw new Error('Webhook registration failed.');
  console.log(`Connected. Send /start to @${result.bot}, then: BacklogBot: test task capture`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
