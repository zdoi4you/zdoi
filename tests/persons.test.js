import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready, addUser } from './helpers.js';
import { pollMail } from '../worker/src/requests.js';
import { makeApp } from '../worker/src/core.js';

const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(200) + '\n%%EOF').toString('base64');
const Y = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' }).slice(0, 4);

function fakeMailbox() {
  const box = { sent: [], inbox: [] };
  box.send = async m => { box.sent.push(m); return {}; };
  box.fetchSince = async since => box.inbox.filter(m => m.at >= since);
  return box;
}

const reqData = (over = {}) => Object.assign({
  mode: 'Сдружението', kind: 'Достъп до обществена информация', title: 'Договори',
  entity: { name: 'Столична община', email: 'obshtina@example.org' }, points: ['Копия на договорите'], access: []
}, over);

async function world() {
  const r = await ready();
  r.boxes = { 'priemna@zdoi.eu': fakeMailbox(), 'abc@zdoi.eu': fakeMailbox() };
  r.env.__mailboxes = r.boxes;
  r.env.MAILBOX = 'priemna@zdoi.eu';
  const p = await r.admin.call('persons.save', { isNew: true, code: 'abc', name: 'Фондация „АБВ“', outPrefix: 'АБВ', mailbox: 'abc@zdoi.eu', regBasis: '', users: [] });
  assert.equal(p.ok, true, JSON.stringify(p));
  return r;
}

test('лица: суперадминистраторът добавя лице и дава достъп; номерацията е отделна', async () => {
  const { env, outbox, admin, boxes } = await world();
  const ivan = await addUser(env, outbox, admin, 'ivan', 'Служител');
  const maria = await addUser(env, outbox, admin, 'maria', 'Служител');

  // без достъп: не създава от името на лицето, не вижда го в bootstrap
  assert.equal((await ivan.call('req.create', reqData({ person: 'abc' }))).error, 'role');
  assert.deepEqual((await ivan.call('bootstrap')).persons.map(p => p.code), ['zdoi']);

  // достъп само за ivan
  const list = await admin.call('persons.list');
  assert.deepEqual(list.persons.map(p => p.code), ['zdoi', 'abc']);
  assert.equal((await admin.call('persons.save', Object.assign({}, list.persons[1], { users: ['ivan'] }))).ok, true);
  assert.deepEqual((await ivan.call('bootstrap')).persons.map(p => p.code), ['zdoi', 'abc']);

  const c = await ivan.call('req.create', reqData({ person: 'abc' }));
  assert.equal(c.regNo, 'П-ABC-' + Y + '-0001');
  // Сдружението продължава своята номерация
  assert.equal((await ivan.call('req.create', reqData())).regNo, 'П-' + Y + '-0001');

  const d = await ivan.call('doc.reserve', { regNo: c.regNo, kind: 'Заявление', payload: {} });
  assert.equal(d.outNo, 'АБВ-' + Y + '-0001');
  await ivan.call('doc.file', { outNo: d.outNo, pdf: PDF });
  const s = await ivan.call('mail.send', { regNo: c.regNo, to: 'obshtina@example.org', subject: '[' + c.regNo + '] Заявление', text: 'Приложено', docs: [d.outNo] });
  // вътрешен идентификатор на лицето, не кодът му
  assert.match(s.replyTo, new RegExp('^abc\\+[a-z][a-z0-9]{5}-' + Y + '-0001@zdoi\\.eu$'));
  assert.ok(!s.replyTo.includes('+abc-'));
  assert.equal(boxes['abc@zdoi.eu'].sent.length, 1);
  assert.equal(boxes['priemna@zdoi.eu'].sent.length, 0);

  const g = await ivan.call('req.get', { regNo: c.regNo });
  assert.equal(g.person.name, 'Фондация „АБВ“');
  assert.equal(g.mailbox, 'abc@zdoi.eu');
  assert.equal(g.request.applicantName, 'Фондация „АБВ“');

  // maria вижда всички преписки (право на ролята), но не и тези на лице без достъп
  assert.equal((await maria.call('req.get', { regNo: c.regNo })).error, 'notfound');
  assert.ok(!(await maria.call('req.list')).requests.some(r => r.regNo === c.regNo));
  assert.equal((await maria.call('register.list', { person: 'abc' })).error, 'role');

  // регистър на лицето
  const reg = await ivan.call('register.list', { person: 'abc' });
  assert.deepEqual(reg.docs.map(x => x.outNo), [d.outNo]);

  // отнемане на достъпа
  await admin.call('persons.save', Object.assign({}, list.persons[1], { users: [] }));
  assert.equal((await ivan.call('req.get', { regNo: c.regNo })).error, 'notfound');
});

test('лица: входящата поща от собствената кутия на лицето', async () => {
  const { env, admin, boxes } = await world();
  const c = await admin.call('req.create', reqData({ person: 'abc' }));
  const at = new Date(Date.now() - 60000).toISOString().slice(0, 19) + 'Z';
  const base = { cc: [], body: 'Отговор', fromName: '', attachments: [], at };
  boxes['abc@zdoi.eu'].inbox.push(Object.assign({}, base, { graphId: 'a1', messageId: '<a1@x>', from: 'obshtina@example.org', to: ['abc+pabc-' + Y + '-0001@zdoi.eu'], subject: 'Re: заявление' }));
  boxes['abc@zdoi.eu'].inbox.push(Object.assign({}, base, { graphId: 'a2', messageId: '<a2@x>', from: 'x@example.org', to: ['abc@zdoi.eu'], subject: 'Здравейте' }));
  boxes['priemna@zdoi.eu'].inbox.push(Object.assign({}, base, { graphId: 'p1', messageId: '<p1@x>', from: 'y@example.org', to: ['priemna@zdoi.eu'], subject: 'Въпрос' }));
  const run = await pollMail(makeApp(env, env.__store, env.__kv, null), { manual: true });
  assert.equal(run.saved, 3);
  assert.equal(run.matched, 1);
  assert.equal(run.boxes.length, 2);
  const g = await admin.call('req.get', { regNo: c.regNo });
  assert.equal(g.mail.length, 1);
  // неразпределената поща е с кутията си
  const inbox = await admin.call('mail.inbox');
  assert.deepEqual(inbox.mail.map(m => m.box).sort(), ['abc@zdoi.eu', 'priemna@zdoi.eu']);
});

test('роли: администраторът не управлява лица и не дава роля „Суперадминистратор“', async () => {
  const { env, outbox, admin } = await world();
  const boss = await addUser(env, outbox, admin, 'boss', 'Администратор');
  assert.equal((await boss.call('persons.list')).error, 'role');
  assert.equal((await boss.call('persons.save', { isNew: true, code: 'xyz', name: 'X' })).error, 'role');
  assert.ok(!(await boss.call('users.list')).roles.includes('Суперадминистратор'));
  assert.equal((await boss.call('users.save', { isNew: true, username: 'eve', name: 'Eve', email: 'eve@example.org', role: 'Суперадминистратор' })).error, 'role');
  assert.equal((await boss.call('users.save', { username: 'admin', name: 'Админ', email: 'admin@example.org', role: 'Служител' })).error, 'role');
  // администраторът вижда само Сдружението, докато суперадминистраторът не му даде достъп
  assert.deepEqual((await boss.call('bootstrap')).persons.map(p => p.code), ['zdoi']);
  // последният суперадминистратор не може да бъде понижен
  assert.equal((await admin.call('users.save', { username: 'admin', name: 'Админ', email: 'admin@example.org', role: 'Администратор' })).error, 'value');
  // кодът и префиксът са уникални
  assert.equal((await admin.call('persons.save', { isNew: true, code: 'abc', name: 'Y' })).error, 'duplicate');
  assert.equal((await admin.call('persons.save', { isNew: true, code: 'def', name: 'Y', outPrefix: 'ЗДОИ' })).error, 'duplicate');
  assert.equal((await admin.call('persons.save', { isNew: true, code: 'Д1', name: 'Y' })).error, 'value');
});

test('сесия: избор от 30 минути до 3 часа, по подразбиране 30', async () => {
  const { admin } = await world();
  const m = await admin.call('me');
  assert.equal(m.me.sessionMin, 30);
  assert.equal((await admin.call('session.save', { minutes: 20 })).error, 'value');
  assert.equal((await admin.call('session.save', { minutes: 240 })).error, 'value');
  const s = await admin.call('session.save', { minutes: 180 });
  assert.equal(s.sessionMin, 180);
  assert.ok(s.session - Date.now() > 179 * 60000);
  assert.equal((await admin.call('me')).me.sessionMin, 180);
  assert.equal((await admin.call('bootstrap')).sessionMin, 180);
});

test('адрес за отговор: с кода на лицето; смяна на стария адрес и разпознаване и по двата', async () => {
  const { env, admin, boxes } = await world();
  const c = await admin.call('req.create', reqData());
  const g = await admin.call('req.get', { regNo: c.regNo });
  const tagId = (await admin.call('persons.list')).persons.find(p => p.code === 'zdoi').tagId;
  assert.match(tagId, /^[a-z][a-z0-9]{5}$/);
  assert.equal(g.replyTo, 'priemna+' + tagId + '-' + Y + '-0001@zdoi.eu');
  // преписка със стар етикет (p2026-0001) получава нов адрес
  const rec = (await env.__store.list('requests', { regNo: c.regNo }))[0];
  await env.__store.patch('requests', rec._id, { tag: 'p' + Y + '-0001' });
  const t = await admin.call('req.retag', { regNo: c.regNo });
  assert.equal(t.oldReplyTo, 'priemna+p' + Y + '-0001@zdoi.eu');
  assert.equal(t.replyTo, 'priemna+' + tagId + '-' + Y + '-0001@zdoi.eu');
  assert.equal((await admin.call('req.retag', { regNo: c.regNo })).changed, false);
  // уведомлението за промяната е документ с Изх. №
  assert.equal((await admin.call('doc.reserve', { regNo: c.regNo, kind: 'Промяна на адрес', payload: { oldReplyTo: t.oldReplyTo, newReplyTo: t.replyTo } })).outNo, 'ЗДОИ-' + Y + '-0001');
  const at = new Date(Date.now() - 60000).toISOString().slice(0, 19) + 'Z';
  const base = { cc: [], body: 'Отговор', fromName: '', attachments: [], at, from: 'obshtina@example.org', subject: 'Re' };
  boxes['priemna@zdoi.eu'].inbox.push(Object.assign({}, base, { graphId: 'o1', messageId: '<o1@x>', to: [t.oldReplyTo] }), Object.assign({}, base, { graphId: 'n1', messageId: '<n1@x>', to: [t.replyTo] }));
  const run = await pollMail(makeApp(env, env.__store, env.__kv, null), { manual: true });
  assert.equal(run.matched, 2);
  // табло и списък само за избраното лице
  await admin.call('req.create', reqData({ person: 'abc' }));
  assert.equal((await admin.call('req.list', { person: 'abc' })).requests.length, 1);
  assert.equal((await admin.call('req.list', { person: 'zdoi' })).requests.length, 1);
  assert.equal((await admin.call('dashboard', { person: 'abc' })).reqTotal, 1);
  assert.equal((await admin.call('dashboard', {})).reqTotal, 2);
});
