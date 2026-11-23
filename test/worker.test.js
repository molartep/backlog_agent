import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { applyDraft, authorized, interpret, validateAction, validateSchema } from '../src/worker.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001.sql', import.meta.url), 'utf8'));
  const wrap = (query, args = []) => ({
    bind(...values) { return wrap(query, values); },
    async first() { return sql.prepare(query).get(...args) || null; },
    async run() { const result = sql.prepare(query).run(...args); return { meta: { changes: Number(result.changes) } }; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
  });
  return { prepare: wrap, async batch(items) { return Promise.all(items.map(item => item.run())); }, sql };
}
const schema = () => ({ id: 'source-1', properties: {
  Title: { type: 'title' }, 'Task ID': { type: 'unique_id' }, 'Due date': { type: 'date' },
  Project: { type: 'select', select: { options: ['BacklogBot', 'ResumeLens', 'CCI', 'LIFE'].map(name => ({ name })) } },
  Status: { type: 'status', status: { options: ['Backlog', 'To do', 'In progress', 'Done'].map(name => ({ name })) } },
  Priority: { type: 'select', select: { options: ['Low', 'Medium', 'High', 'Urgent'].map(name => ({ name })) } },
} });
const page = (overrides = {}) => ({ id: 'page-1', url: 'https://notion.so/task-1', last_edited_time: '2026-11-23T12:00:00Z', parent: { data_source_id: 'source-1' }, properties: {
  Title: { title: [{ plain_text: 'Test task' }] }, Project: { select: { name: 'BacklogBot' } }, Status: { status: { name: 'Backlog' } },
  'Task ID': { unique_id: { prefix: 'TASK', number: 42 } },
}, ...overrides });
function env() { return { DB: database(), AI_MODEL: 'test', NOTION_DATABASE_ID: 'db-1', NOTION_TOKEN: 'fake-notion', TELEGRAM_BOT_TOKEN: 'fake-telegram', TELEGRAM_WEBHOOK_SECRET: 'test-secret', ALLOWED_TELEGRAM_USER_ID: '123', AI: { run: async () => ({ response: JSON.stringify({ kind: 'create', project: 'BacklogBot', title: 'Handle retries', description: 'Handle failed delivery.' }) }) } }; }
function mockServices(options = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method || 'GET', body });
    if (String(url).includes('api.telegram.org')) return Response.json({ ok: true, result: { username: 'test_bot', message_id: 99 } });
    if (String(url).endsWith('/databases/db-1')) return Response.json({ data_sources: [{ id: 'source-1' }] });
    if (String(url).endsWith('/data_sources/source-1')) return Response.json(schema());
    if (String(url).endsWith('/query')) return Response.json({ results: [options.current || page()], has_more: false });
    if (String(url).endsWith('/pages') && init.method === 'POST') {
      if (options.failCreate) throw new Error('ambiguous timeout');
      return Response.json(page());
    }
    if (String(url).endsWith('/pages/page-1')) return Response.json(options.current || page());
    if (String(url).endsWith('/blocks/page-1/children')) return Response.json({ results: [] });
    throw new Error(`Unexpected test request: ${url}`);
  };
  return calls;
}
function message(update_id, value) { return { update_id, message: { text: value, from: { id: 123 }, chat: { id: 123, type: 'private' } } }; }
async function deliver(environment, update, secret = 'test-secret') {
  const pending = [];
  const response = await worker.fetch(new Request('https://bot.example/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), environment, { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  return response;
}
async function addDraft(environment, action, options = {}) {
  const id = crypto.randomUUID();
  await environment.DB.prepare('INSERT INTO drafts(id, owner, chat_id, action, original, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, '123', '123', JSON.stringify(action), 'BacklogBot: handle retries', options.expires || Math.floor(Date.now() / 1000) + 1000).run();
  return id;
}

test('creation is a preview only, and repeated deliveries do not create another draft', async () => {
  const environment = env(), calls = mockServices();
  const update = message(1, 'BacklogBot: handle retries');
  assert.equal((await deliver(environment, update)).status, 200);
  await deliver(environment, update);
  assert.equal(environment.DB.sql.prepare('SELECT count(*) n FROM drafts').get().n, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/pages') && c.method === 'POST').length, 0);
  const preview = calls.find(c => c.url.endsWith('/sendMessage')).body;
  assert.match(preview.text, /Priority: unset/);
  assert.deepEqual(preview.reply_markup.inline_keyboard[0].map(b => b.text), ['Approve', 'Edit', 'Cancel']);
});
test('atomic approval writes only once even with concurrent approval calls', async () => {
  const environment = env(), calls = mockServices();
  const id = await addDraft(environment, { kind: 'create', project: 'BacklogBot', title: 'Handle retries' });
  await Promise.all([applyDraft(environment, id, '123'), applyDraft(environment, id, '123')]);
  assert.equal(calls.filter(c => c.url.endsWith('/pages') && c.method === 'POST').length, 1);
  assert.equal(environment.DB.sql.prepare('SELECT state FROM drafts').get().state, 'applied');
});
test('uncertain write is locked and never repeated', async () => {
  const environment = env(), calls = mockServices({ failCreate: true });
  const id = await addDraft(environment, { kind: 'create', project: 'BacklogBot', title: 'Handle retries' });
  assert.match((await applyDraft(environment, id, '123')).message, /could not confirm/);
  await applyDraft(environment, id, '123');
  assert.equal(calls.filter(c => c.url.endsWith('/pages') && c.method === 'POST').length, 1);
  assert.equal(environment.DB.sql.prepare('SELECT state FROM drafts').get().state, 'uncertain');
});
test('expired and foreign-owned drafts cannot be approved', async () => {
  const environment = env(), calls = mockServices();
  const id = await addDraft(environment, { kind: 'create' }, { expires: 1 });
  await applyDraft(environment, id, '123');
  const other = await addDraft(environment, { kind: 'create' });
  await applyDraft(environment, other, '456');
  assert.equal(calls.length, 0);
});
test('changed Notion task rejects stale approval before writing', async () => {
  const environment = env(), calls = mockServices();
  const id = await addDraft(environment, { kind: 'update', project: 'BacklogBot', pageId: 'page-1', status: 'Done', before: { revision: 'old' } });
  await assert.rejects(applyDraft(environment, id, '123'), /changed since/);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 0);
});
test('approved update changes requested properties and preserves unrelated fields', async () => {
  const environment = env(), calls = mockServices();
  const id = await addDraft(environment, { kind: 'update', project: 'BacklogBot', pageId: 'page-1', status: 'Done', before: { revision: page().last_edited_time } });
  await applyDraft(environment, id, '123');
  assert.deepEqual(calls.find(c => c.method === 'PATCH').body, { properties: { Status: { status: { name: 'Done' } } } });
});
test('invalid webhook secret and other users never reach the AI or database', async () => {
  const environment = env(); mockServices();
  assert.equal((await deliver(environment, message(1, 'x'), 'wrong')).status, 401);
  const foreign = message(2, 'x'); foreign.message.from.id = 456;
  await deliver(environment, foreign);
  assert.equal(environment.DB.sql.prepare('SELECT count(*) n FROM inbox').get().n, 0);
  assert.equal(authorized({ ...message(1, 'x'), message: { from: { id: 123 }, chat: { id: 123, type: 'group' } } }, '123'), false);
});
test('model cannot select an unmentioned project or inject an action/page ID', () => {
  assert.throws(() => validateAction({ kind: 'create', project: 'LIFE', title: 'x' }, 'BacklogBot: task'), /name the project/);
  assert.throws(() => validateAction({ kind: 'delete', project: 'LIFE' }, 'LIFE: delete'), /create, list, or update/);
  const action = validateAction({ kind: 'update', project: 'LIFE', taskId: 'TASK-42', status: 'Done', pageId: 'injected' }, 'LIFE: mark TASK-42 Done');
  assert.equal(action.pageId, undefined);
});
test('invented priority and deadlines are removed; supported values must be valid', () => {
  const invented = validateAction({ kind: 'create', project: 'CCI', title: 'x', priority: 'High', dueDate: '2026-12-01' }, 'CCI: x');
  assert.equal(invented.priority, undefined);
  assert.equal(invented.dueDate, undefined);
  assert.throws(() => validateAction({ kind: 'create', project: 'CCI', title: 'x', dueDate: '2026-02-30', dateEvidence: 'tomorrow' }, 'CCI: x tomorrow'), /deadline explicitly/);
  const result = validateAction({ kind: 'create', project: 'CCI', title: 'x', priority: 'High', priorityEvidence: 'high priority' }, 'CCI: x high priority');
  assert.equal(result.priority, 'High');
});
test('schema validation names missing properties and options', () => {
  const missing = schema(); delete missing.properties['Task ID'];
  assert.throws(() => validateSchema(missing), /Task ID/);
  const options = schema(); options.properties.Project.select.options = [];
  assert.throws(() => validateSchema(options), /BacklogBot/);
});
test('query reads Notion with project and status filters and never writes', async () => {
  const environment = env(), calls = mockServices();
  environment.AI.run = async () => ({ response: { kind: 'query', project: 'BacklogBot' } });
  await deliver(environment, message(10, 'Show open BacklogBot tasks'));
  const query = calls.find(c => c.url.endsWith('/query')).body;
  assert.deepEqual(query.filter.and, [{ property: 'Project', select: { equals: 'BacklogBot' } }, { property: 'Status', status: { does_not_equal: 'Done' } }]);
  assert.equal(environment.DB.sql.prepare('SELECT count(*) n FROM drafts').get().n, 0);
});
test('cancel blocks a later approval; editing requires a fresh approval', async () => {
  const environment = env(), calls = mockServices();
  await deliver(environment, message(1, 'BacklogBot: handle retries'));
  const first = environment.DB.sql.prepare('SELECT id FROM drafts').get().id;
  const cb = (n, verb) => ({ update_id: n, callback_query: { id: String(n), from: { id: 123 }, message: { chat: { id: 123, type: 'private' } }, data: `${verb}:${first}` } });
  await deliver(environment, cb(2, 'edit'));
  await deliver(environment, message(3, 'BacklogBot: handle retries carefully'));
  assert.equal(environment.DB.sql.prepare('SELECT state FROM drafts WHERE id = ?').get(first).state, 'cancelled');
  const second = environment.DB.sql.prepare("SELECT id FROM drafts WHERE state = 'pending'").get().id;
  const cancel = cb(4, 'cancel'); cancel.callback_query.data = `cancel:${second}`;
  await deliver(environment, cancel);
  await applyDraft(environment, second, '123');
  assert.equal(calls.filter(c => c.url.endsWith('/pages') && c.method === 'POST').length, 0);
});
test('malformed model JSON is a useful error, not a write', async () => {
  await assert.rejects(interpret({ AI_MODEL: 'test', AI: { run: async () => ({ response: 'not-json' }) } }, 'LIFE: test'), /could not interpret/);
});

test('captured live Workers AI outputs validate for creation, query and update', () => {
  const results = JSON.parse(readFileSync(new URL('./fixtures/live-ai.json', import.meta.url), 'utf8'));
  const validated = results.map(({ original, response }) => validateAction(response, original));
  assert.deepEqual(validated.map(a => a.kind), ['create', 'query', 'update']);
  assert.equal(validated[0].priority, undefined);
  assert.equal(validated[0].dueDate, undefined);
  assert.equal(validated[0].taskId, undefined);
  assert.equal(validated[2].status, 'In progress');
});
