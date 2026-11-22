import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready, addUser } from './helpers.js';
import { parseManual } from '../worker/src/help.js';

const MD = `# Ръководство

## Вход и профил
Как се влиза.

- стъпка

## Заявления
За: Служител, Администратор
Право: reqCreate

### Ново заявление
1. Отворете „Ново заявление“.

## Администрация
За: Администратор, Суперадминистратор
Само за администратори.
`;

test('ръководство: импорт от Markdown, раздели според ролята и правата, редакция само с право', async () => {
  const parsed = parseManual(MD);
  assert.deepEqual(parsed.map(s => [s.title, s.audience, s.perm]), [['Вход и профил', '', ''], ['Заявления', 'Служител, Администратор', 'reqCreate'], ['Администрация', 'Администратор, Суперадминистратор', '']]);
  assert.match(parsed[1].body, /^### Ново заявление/);

  const { env, outbox, admin } = await ready();
  const imp = await admin.call('help.import', { markdown: MD });
  assert.equal(imp.ok, true, JSON.stringify(imp));
  assert.equal(imp.added, 3);
  // повторният импорт обновява по заглавие
  assert.equal((await admin.call('help.import', { markdown: MD })).updated, 3);

  const all = await admin.call('help.list');
  assert.equal(all.editor, true);
  assert.equal(all.sections.length, 3);
  assert.deepEqual(all.sections[1].audience, ['Служител', 'Администратор']);
  // „както го вижда“ наблюдател
  assert.deepEqual((await admin.call('help.list', { as: 'Наблюдател' })).sections.map(s => s.title), ['Вход и профил']);

  const staff = await addUser(env, outbox, admin, 'staff1', 'Служител');
  const s = await staff.call('help.list');
  assert.equal(s.editor, false);
  assert.deepEqual(s.sections.map(x => x.title), ['Вход и профил', 'Заявления']);
  const viewer = await addUser(env, outbox, admin, 'view1', 'Наблюдател');
  assert.deepEqual((await viewer.call('help.list')).sections.map(x => x.title), ['Вход и профил']);
  // служител без право „reqCreate“ не вижда раздела за заявленията
  await admin.call('users.save', { username: 'staff1', name: 'STAFF1', email: 'staff1@example.org', role: 'Служител', active: 'Да', customPerms: true, perms: ['inReg'] });
  await env.__kv.delete('c:usr:staff1');
  assert.deepEqual((await staff.call('help.list')).sections.map(x => x.title), ['Вход и профил']);

  assert.equal((await staff.call('help.save', { title: 'X', body: 'y' })).error, 'role');
  const n = await admin.call('help.save', { title: 'Нов раздел', body: '**текст**', audience: ['Наблюдател', 'нещо'], order: 5 });
  assert.equal(n.ok, true);
  const sec = (await admin.call('help.list')).sections.find(x => x.title === 'Нов раздел');
  assert.deepEqual(sec.audience, ['Наблюдател']);
  assert.equal(sec.order, 5);
  assert.equal((await admin.call('help.delete', { id: sec._id })).ok, true);
  assert.equal((await admin.call('help.import', { markdown: 'без раздели' })).error, 'value');
});

test('тикети: подаване, видимост, отговори, вътрешни бележки, статус и известия', async () => {
  const { env, outbox, admin } = await ready();
  const staff = await addUser(env, outbox, admin, 'staff1', 'Служител');
  const other = await addUser(env, outbox, admin, 'staff2', 'Служител');
  outbox.length = 0;

  assert.equal((await staff.call('ticket.create', { category: 'Отворени данни', title: '', body: 'x' })).error, 'required');
  assert.equal((await staff.call('ticket.create', { category: 'Нещо', title: 'a', body: 'x' })).error, 'value');
  const c = await staff.call('ticket.create', { category: 'Отворени данни', priority: 'Висок', title: 'Не се зарежда регистърът', body: 'Грешка 403', page: '#/addressees' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.match(c.no, /^T-\d{4}-0001$/);
  assert.ok(outbox.some(m => m.to === 'admin@example.org' && m.subject.includes(c.no)));
  assert.equal((await staff.call('ticket.create', { category: 'Въпрос как се работи', title: 'Втори', body: 'y' })).no.slice(-4), '0002');

  // видимост: подателят и обработващите; другият служител – не
  assert.equal((await staff.call('ticket.list')).tickets.length, 2);
  assert.equal((await other.call('ticket.list')).tickets.length, 0);
  assert.equal((await other.call('ticket.get', { no: c.no })).error, 'role');
  assert.equal((await admin.call('ticket.list')).tickets.length, 2);
  assert.equal((await admin.call('ticket.list')).handler, true);
  assert.equal((await admin.call('ticket.count')).count, 2);

  // вътрешна бележка – подателят не я вижда и не получава писмо
  outbox.length = 0;
  await admin.call('ticket.reply', { no: c.no, text: 'проверявам логовете', internal: true });
  assert.equal(outbox.length, 0);
  assert.equal((await staff.call('ticket.get', { no: c.no })).messages.length, 0);
  // отговор с „Чака отговор“ – писмо до подателя, отговорник – който отговаря
  await admin.call('ticket.reply', { no: c.no, text: 'Кой ресурс?', status: 'Чака отговор' });
  assert.ok(outbox.some(m => m.to === 'staff1@example.org' && m.text.includes('Кой ресурс?')));
  let g = await staff.call('ticket.get', { no: c.no });
  assert.equal(g.ticket.status, 'Чака отговор');
  assert.equal(g.ticket.assignee, 'admin');
  assert.equal((await staff.call('ticket.count')).count, 1);
  // отговор на подателя връща в работа и известява отговорника
  outbox.length = 0;
  await staff.call('ticket.reply', { no: c.no, text: 'Училищата' });
  assert.equal((await staff.call('ticket.get', { no: c.no })).ticket.status, 'В работа');
  assert.ok(outbox.some(m => m.to === 'admin@example.org'));

  // служителят не може да сменя статус, приоритет или отговорник – само да затвори
  assert.equal((await staff.call('ticket.update', { no: c.no, status: 'Решен' })).error, 'role');
  assert.equal((await staff.call('ticket.update', { no: c.no, priority: 'Спешен' })).error, 'role');
  assert.equal((await admin.call('ticket.update', { no: c.no, assignee: 'staff2' })).error, 'value');
  outbox.length = 0;
  const u = await admin.call('ticket.update', { no: c.no, status: 'Решен', priority: 'Нормален' });
  assert.deepEqual(u.changed.sort(), ['priority', 'status']);
  assert.ok(outbox.some(m => m.to === 'staff1@example.org' && /Решен/.test(m.subject)));
  g = await staff.call('ticket.get', { no: c.no });
  assert.ok(g.ticket.closedAt);
  assert.ok(g.messages.some(m => m.kind === 'Промяна' && /Статус: Решен/.test(m.text)));
  // ново съобщение отваря решения тикет наново; подателят може да го затвори
  await staff.call('ticket.reply', { no: c.no, text: 'Пак се появи' });
  assert.equal((await staff.call('ticket.get', { no: c.no })).ticket.status, 'В работа');
  assert.equal((await staff.call('ticket.update', { no: c.no, status: 'Затворен' })).ok, true);
  assert.equal((await staff.call('ticket.get', { no: c.no })).ticket.status, 'Затворен');
  const log = (await admin.call('log.list')).log;
  assert.ok(log.some(l => l.action === 'Нов тикет' && l.ref === c.no));
});

test('опити за печат и снимка на екрана се записват в дневника; ограничение на записите', async () => {
  const { admin } = await ready();
  const r = await admin.call('guard.report', { kind: 'печат', page: 'Заявление П-2026-0001 · #/request/П-2026-0001', how: 'Ctrl+P' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.logged, true);
  await admin.call('guard.report', { kind: 'снимка на екрана', page: 'Табло · #/dashboard', how: 'PrintScreen' });
  const log = (await admin.call('log.list')).log;
  const p = log.find(l => l.action === 'Опит за печат');
  assert.ok(p && /П-2026-0001/.test(p.ref) && p.details === 'Ctrl+P' && p.actor === 'admin' && p.ip === '203.0.113.5');
  assert.ok(log.some(l => l.action === 'Опит за снимка на екрана'));
  assert.equal((await admin.call('guard.report', { kind: 'друго' })).error, 'value');
  for (let i = 0; i < 30; i++) await admin.call('guard.report', { kind: 'печат' });
  assert.equal((await admin.call('guard.report', { kind: 'печат' })).logged, false);
});
