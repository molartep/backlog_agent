import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';

// Token prompts never echo and the resulting file is excluded from version control.
async function hidden(label) {
  if (!stdin.isTTY) throw new Error('Run this setup from an interactive terminal.');
  stdout.write(label);
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    function finish() { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); }
    stdin.on('data', onData);
  });
}
async function api(token, method) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Telegram ${method} failed (${r.status}); check the token.`);
  const json = await r.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed.`);
  return json.result;
}
try {
  try { await access('.secrets.json'); throw new Error('.secrets.json already exists. Move it aside explicitly before rerunning setup.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const telegramToken = await hidden('Telegram bot token (hidden): ');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramToken)) throw new Error('Unexpected Telegram token format.');
  const notionToken = await hidden('Notion internal integration token (hidden): ');
  if (!notionToken) throw new Error('Notion token is required.');
  const bot = await api(telegramToken, 'getMe');
  const webhook = await api(telegramToken, 'getWebhookInfo');
  if (webhook.url) throw new Error('This bot already has a webhook. Stop here so its existing service is not interrupted.');
  const code = randomBytes(8).toString('hex');
  const rl = createInterface({ input: stdin, output: stdout });
  let owner;
  try {
    await rl.question(`\nOpen @${bot.username} in Telegram and send exactly:\n/setup ${code}\n\nPress Enter after sending it. `);
    const updates = await api(telegramToken, 'getUpdates');
    const message = updates.find(u => u.message?.text === `/setup ${code}` && u.message.chat.type === 'private')?.message;
    if (!message || message.from.id !== message.chat.id) throw new Error('Setup message not found. Run setup again and send its new code to your bot.');
    owner = String(message.from.id);
    console.log(`Verified your private Telegram account: ${owner}`);
  } finally { rl.close(); }
  await writeFile('.secrets.json', JSON.stringify({
    TELEGRAM_BOT_TOKEN: telegramToken, NOTION_TOKEN: notionToken,
    ALLOWED_TELEGRAM_USER_ID: owner, TELEGRAM_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('\nSaved credentials locally to ignored .secrets.json (owner access only).\nTell Codex setup is done. Do not paste this file into chat.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
