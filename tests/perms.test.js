import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready, addUser, caseData, client, pre } from './helpers.js';
import { permsOf } from '../worker/src/auth.js';

const reqData = (over = {}) => Object.assign({
  mode: 'Сдружението', kind: 'Достъп до обществена информация', title: 'Договори',
  entity: { name: 'Столична община', email: 'obshtina@example.org' }, points: ['Копия на договорите'], access: []
}, over);

test('права: старите записи се разгръщат, наблюдателят само преглежда, админ. права само за администратор', () => {
  const legacy = permsOf({ role: 'Служител', perms: JSON.stringify(['casesAll', 'casesEdit']) });
  ['casesAll', 'reqCreate', 'docs', 'sign', 'mailSend', 'inReg', 'inRegEdit', 'outReg'].forEach(k => assert.ok(legacy[k], k));
  assert.ok(!legacy.courts && !legacy.assign);
  const legacyAdmin = permsOf({ role: 'Администратор', perms: JSON.stringify(['casesAll']) });
  assert.ok(legacyAdmin.users && legacyAdmin.system && legacyAdmin.assign);
  const viewer = permsOf({ role: 'Наблюдател', perms: JSON.stringify({ v: 2, p: ['casesAll', 'reqCreate', 'inReg'] }) });
  assert.deepEqual(Object.keys(viewer).sort(), ['casesAll', 'inReg']);
  const staff = permsOf({ role: 'Служител', perms: JSON.stringify({ v: 2, p: ['reqCreate', 'users', 'assign'] }) });
  assert.deepEqual(Object.keys(staff), ['reqCreate']);
  assert.ok(permsOf({ role: 'Суперадминистратор', perms: JSON.stringify({ v: 2, p: [] }) }).system);
});

test('права по операции: без право действието и формулярът не са достъпни', async () => {
  const { env, outbox, admin } = await ready();
  const ivan = await addUser(env, outbox, admin, 'ivan', 'Служител', { perms: ['reqCreate', 'reqEdit'] });
  const r = await ivan.call('req.create', reqData());
  assert.equal(r.ok, true);
  assert.equal((await ivan.call('doc.reserve', { regNo: r.regNo, kind: 'Заявление', payload: {} })).error, 'role');
  assert.equal((await ivan.call('mail.send', { regNo: r.regNo, to: 'a@example.org', subject: 'x', text: 'y' })).error, 'role');
  assert.equal((await ivan.call('req.comment', { regNo: r.regNo, text: 'x' })).error, 'role');
  // входящият регистър и изходящият регистър – само с право
  assert.equal((await ivan.call('case.list')).error, 'role');
  assert.equal((await ivan.call('register.list')).error, 'role');
  assert.equal((await ivan.call('mail.inbox')).error, 'role');
  assert.equal((await ivan.call('users.list')).error, 'role');
  const me = await ivan.call('me');
  assert.deepEqual(Object.keys(me.me.perms).sort(), ['reqCreate', 'reqEdit']);
});

test('отговорник: въвелият назначава само себе си; веднъж определен – сменя го администратор', async () => {
  const { env, outbox, admin } = await ready();
  const ivan = await addUser(env, outbox, admin, 'ivan', 'Служител');
  await addUser(env, outbox, admin, 'maria', 'Служител');
  assert.equal((await ivan.call('req.create', reqData({ owner: 'maria' }))).error, 'role');
  const free = await ivan.call('req.create', reqData());
  assert.equal((await ivan.call('req.assign', { regNo: free.regNo, owner: 'maria' })).error, 'role');
  assert.equal((await ivan.call('req.assign', { regNo: free.regNo, owner: 'ivan' })).owner, 'ivan');
  // веднъж назначена: нито предаване, нито освобождаване
  assert.equal((await ivan.call('req.assign', { regNo: free.regNo, owner: 'maria' })).error, 'role');
  assert.equal((await ivan.call('req.assign', { regNo: free.regNo, owner: '' })).error, 'role');
  assert.equal((await admin.call('req.assign', { regNo: free.regNo, owner: 'maria' })).owner, 'maria');
  // входящ регистър – същото правило
  assert.equal((await ivan.call('case.create', caseData({ owner: 'maria' }))).error, 'role');
  const c = await ivan.call('case.create', caseData({ owner: 'ivan' }));
  assert.equal(c.ok, true);
  assert.equal((await ivan.call('case.assign', { regNo: c.regNo, owner: '' })).error, 'role');
  assert.equal((await admin.call('case.assign', { regNo: c.regNo, owner: 'maria' })).owner, 'maria');
});

test('права на администраторите: дава ги суперадминистраторът; администраторът – само от своите и само на служители', async () => {
  const { env, outbox, admin } = await ready(); // admin е суперадминистратор
  const boss = await addUser(env, outbox, admin, 'boss', 'Администратор', { perms: ['users', 'usersPerms', 'casesAll', 'reqCreate', 'inReg'] });
  await addUser(env, outbox, admin, 'other', 'Администратор');
  await addUser(env, outbox, admin, 'ivan', 'Служител');
  // без „system“ – няма системни настройки
  assert.equal((await boss.call('system.get')).error, 'role');
  const list = await boss.call('users.list');
  assert.equal(list.ok, true);
  assert.equal(list.users.find(u => u.username === 'other').canEdit, false);
  assert.equal(list.users.find(u => u.username === 'ivan').canPerms, true);
  assert.ok(!list.roles.includes('Администратор'));
  // друг администратор не се променя от администратор
  assert.equal((await boss.call('users.save', { username: 'other', name: 'O', email: 'other@example.org', role: 'Администратор' })).error, 'role');
  // служител не се прави администратор от администратор
  assert.equal((await boss.call('users.save', { username: 'ivan', name: 'I', email: 'ivan@example.org', role: 'Администратор' })).error, 'role');
  // дава само права, които има
  assert.equal((await boss.call('users.save', { username: 'ivan', name: 'I', email: 'ivan@example.org', role: 'Служител', perms: ['reqCreate', 'sign'] })).error, 'role');
  assert.equal((await boss.call('users.save', { username: 'ivan', name: 'I', email: 'ivan@example.org', role: 'Служител', perms: ['reqCreate', 'inReg'] })).ok, true);
  // собствените права не се променят
  assert.equal((await boss.call('users.save', { username: 'boss', name: 'B', email: 'boss@example.org', role: 'Администратор', perms: ['users'] })).error, 'role');
  // суперадминистраторът дава „system“
  assert.equal((await admin.call('users.save', { username: 'boss', name: 'B', email: 'boss@example.org', role: 'Администратор', perms: ['users', 'usersPerms', 'system'] })).ok, true);
  assert.equal((await boss.call('system.get')).ok, true);
});

test('администратор без „Задава роли и права“ не променя роли и права', async () => {
  const { env, outbox, admin } = await ready();
  const hrm = await addUser(env, outbox, admin, 'hrm', 'Администратор', { perms: ['users'] });
  await addUser(env, outbox, admin, 'ivan', 'Служител');
  assert.equal((await hrm.call('users.save', { username: 'ivan', name: 'Иван', email: 'ivan@example.org', role: 'Наблюдател' })).error, 'role');
  assert.equal((await hrm.call('users.save', { username: 'ivan', name: 'Иван', email: 'ivan@example.org', role: 'Служител', perms: ['reqCreate'] })).error, 'role');
  assert.equal((await hrm.call('users.save', { username: 'ivan', name: 'Иван Петров', email: 'ivan@example.org', role: 'Служител' })).ok, true);
  assert.equal((await hrm.call('users.save', { isNew: true, username: 'nov', name: 'Нов', email: 'nov@example.org', role: 'Наблюдател' })).ok, true);
});

test('входове и сесии: IP с място, активни сесии, прекратяване; основно лице в профила', async () => {
  const { env, outbox, admin } = await ready();
  const ivan = await addUser(env, outbox, admin, 'ivan', 'Служител');
  const second = client(env);
  await second.call('login', { username: 'ivan', hash: pre('ivan-pass') });
  const s = await ivan.call('sessions.list');
  assert.equal(s.sessions.length, 2);
  assert.equal(s.sessions.filter(x => x.current).length, 1);
  assert.equal(s.sessions[0].ip, '203.0.113.5');
  // чужди сесии – само с право „Управлява потребителите“
  assert.equal((await ivan.call('sessions.list', { username: 'admin' })).error, 'role');
  const other = s.sessions.find(x => !x.current);
  assert.equal((await ivan.call('sessions.end', { id: other.id })).ended, 1);
  assert.equal((await second.call('me')).error, 'session');
  assert.equal((await admin.call('sessions.end', { username: 'ivan', all: true })).ended, 1);
  assert.equal((await ivan.call('me')).error, 'session');
  // входовете: служителят вижда своите, администраторът – всички
  const ivan2 = client(env);
  await ivan2.call('login', { username: 'ivan', hash: pre('ivan-pass') });
  const mine = await ivan2.call('logins.list');
  assert.ok(mine.logins.every(l => l.username === 'ivan') && !mine.all);
  assert.ok((await admin.call('logins.list')).logins.some(l => l.username === 'admin'));
  // нов IP адрес – писмо до потребителя
  const fromNew = client(env);
  await fromNew.call('login', { username: 'ivan', hash: pre('ivan-pass') }, { 'CF-Connecting-IP': '198.51.100.7' });
  assert.ok(outbox.some(m => m.to === 'ivan@example.org' && /нов IP/.test(m.subject) && /198\.51\.100\.7/.test(m.text)));
  // основно лице
  assert.equal((await ivan2.call('profile.person', { code: 'zdoi' })).defaultPerson, 'zdoi');
  assert.equal((await ivan2.call('bootstrap')).defaultPerson, 'zdoi');
  assert.equal((await ivan2.call('profile.person', { code: 'nqma' })).error, 'role');
});

test('календар: срокове, заседания и насрочени писма', async () => {
  const { admin } = await ready();
  const { regNo } = await admin.call('case.create', caseData());
  await admin.call('court.save', { regNo, court: 'Административен съд – София-град', caseNo: '77', year: '2026', kind: 'Жалба срещу решение', instance: 'Административен съд', status: 'Образувано', nextHearing: '2026-12-01' });
  const cal = await admin.call('calendar', { person: 'zdoi' });
  assert.ok(cal.events.some(e => e.ref === regNo && e.date === '2026-11-16'));
  assert.ok(cal.events.some(e => e.kind === 'Съдебно заседание' && e.date === '2026-12-01'));
});
