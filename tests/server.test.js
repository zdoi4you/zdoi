import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { makeEnv, client, setup, pre, linkParts, ready, addUser, caseData, ORIGIN } from './helpers.js';
import { term, holidays, orthodoxEaster, termMonths } from '../site/js/calendar.js';
import { withDue } from '../worker/src/cases.js';

test('календар: Великден и празници', () => {
  assert.equal(orthodoxEaster(2026).toISOString().slice(0, 10), '2026-04-12');
  assert.equal(orthodoxEaster(2027).toISOString().slice(0, 10), '2027-05-02');
  const h = holidays(2026);
  ['2026-01-01', '2026-03-03', '2026-04-10', '2026-04-13', '2026-05-01', '2026-05-06', '2026-05-25', '2026-09-07', '2026-09-22', '2026-12-24'].forEach(d => assert.ok(h[d], d));
});

test('календар: срокът се мести на работен ден', () => {
  assert.equal(term('2026-11-02', 14), '2026-11-16'); // понеделник
  assert.equal(term('2026-12-10', 14), '2026-12-29'); // 24–26.12, а 26.12 (събота) се отработва на 28.12
  assert.equal(termMonths('2026-12-31', 2), '2027-03-01'); // 28.02 е неделя
});

test('срокове на преписка', () => {
  const c = withDue({ status: 'Нова', regDate: '2026-11-02', ext30: '10' }, '2026-11-10');
  assert.equal(c.due, '2026-11-26');
  assert.equal(c.daysLeft, 16);
  const clar = withDue({ status: 'Чака уточняване', regDate: '2026-11-02', clarifyAsked: '2026-11-05' }, '2026-11-10');
  assert.equal(clar.due, '2026-12-07'); // 05.12 е събота
  const appeal = withDue({ status: 'Решение издадено', regDate: '2026-11-02', decisionDate: '2026-11-10', served: '2026-11-12' }, '2026-11-13');
  assert.equal(appeal.appealBy, '2026-11-26');
  assert.equal(appeal.due, '');
});

test('настройка: само с ключ, създава администратор веднъж', async () => {
  const { env, outbox } = makeEnv();
  const bad = await worker.fetch(new Request(ORIGIN + '/api/setup', { method: 'POST', headers: { 'X-Setup-Key': 'wrong' } }), env);
  assert.equal(bad.status, 403);
  const s = await setup(env);
  assert.equal(s.ok, true);
  assert.ok(linkParts(s.link));
  assert.equal(outbox.length, 1);
  const again = await setup(env);
  assert.equal(again.admin, 'вече има администратор');
  assert.equal(again.link, undefined);
});

test('вход: еднократна връзка, бисквитка, изход', async () => {
  const { env } = makeEnv();
  const s = await setup(env);
  const c = client(env);
  const p = linkParts(s.link);
  assert.deepEqual((await c.call('link.check', p)).valid, true);
  assert.equal((await c.call('activate', Object.assign({ hash: pre('x') }, p))).ok, true);
  assert.equal((await c.call('activate', Object.assign({ hash: pre('y') }, p))).error, 'invite'); // връзката е еднократна
  const l = await c.call('login', { username: 'admin', hash: pre('x') });
  assert.equal(l.ok, true);
  assert.equal(l.me.role, 'Суперадминистратор');
  assert.equal(l.token, undefined); // ключът на сесията е само в бисквитката
  assert.ok(c.cookie.startsWith('adm_s='));
  assert.equal((await c.call('me')).me.username, 'admin');
  await c.call('logout');
  assert.equal((await c.call('me')).error, 'session');
});

test('вход: заявки от чужд адрес се отказват', async () => {
  const { env } = await ready();
  const r = await worker.fetch(new Request(ORIGIN + '/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ action: 'me' })
  }), env);
  assert.equal(r.status, 403);
});

test('вход: заключване след 5 грешни опита', async () => {
  const { env, outbox } = await ready();
  const c = client(env);
  for (let i = 0; i < 4; i++) assert.equal((await c.call('login', { username: 'admin', hash: pre('bad') })).error, 'login');
  assert.equal((await c.call('login', { username: 'admin', hash: pre('bad') })).error, 'locked');
  assert.equal((await c.call('login', { username: 'admin', hash: pre('admin-pass') })).error, 'locked');
  assert.ok(outbox.some(m => /спрян вход/.test(m.subject)));
});

test('двуфакторен вход с код по имейл', async () => {
  const { env, outbox, admin } = await ready();
  const st = await admin.call('twofa.start', { hash: pre('admin-pass') });
  assert.equal(st.twofa, true);
  const code = /Код: (\d{8})/.exec(outbox.pop().text)[1];
  assert.equal((await admin.call('twofa.confirm', { ticket: st.ticket, code })).twofa, true);
  const c = client(env);
  const l = await c.call('login', { username: 'admin', hash: pre('admin-pass') });
  assert.equal(l.twofa, true);
  assert.equal(c.cookie, '');
  assert.equal((await c.call('login.code', { ticket: l.ticket, code: '00000000' })).error, 'code');
  const code2 = /Код: (\d{8})/.exec(outbox.pop().text)[1];
  const ok = await c.call('login.code', { ticket: l.ticket, code: code2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.me.username, 'admin');
});

test('потребители: само администратор; поне един администратор', async () => {
  const { env, outbox, admin } = await ready();
  const staff = await addUser(env, outbox, admin, 'maria', 'Служител');
  assert.equal((await staff.call('users.list')).error, 'role');
  assert.equal((await admin.call('users.save', { username: 'admin', name: 'A', email: 'admin@example.org', role: 'Служител' })).error, 'value');
  const list = await admin.call('users.list');
  assert.equal(list.users.length, 2);
  assert.ok(list.users.every(u => u.hash === undefined && u.salt === undefined));
  // спрян потребител губи сесията
  await admin.call('users.save', { username: 'maria', name: 'M', email: 'maria@example.org', role: 'Служител', active: false });
  assert.equal((await staff.call('me')).error, 'session');
});

test('преписки: номер, срок, промяна, история', async () => {
  const { admin } = await ready();
  const r = await admin.call('case.create', caseData());
  assert.equal(r.regNo, 'ВХ-2026-0001');
  assert.equal((await admin.call('case.create', caseData())).regNo, 'ВХ-2026-0002');
  assert.equal((await admin.call('case.create', caseData({ regNo: 'ВХ-2026-0001' }))).error, 'duplicate');
  assert.equal((await admin.call('case.create', caseData({ subject: '' }))).error, 'required');
  const got = await admin.call('case.get', { regNo: r.regNo });
  assert.equal(got.case.due, '2026-11-16');
  const upd = await admin.call('case.update', Object.assign(caseData(), got.case, { status: 'Решение издадено', outcome: 'Отказ', decisionNo: '15', decisionDate: '2026-11-10', grounds: '' }));
  assert.equal(upd.error, 'required'); // основание при отказ
  const ok = await admin.call('case.update', Object.assign(caseData(), got.case, { status: 'Решение издадено', outcome: 'Отказ', decisionNo: '15', decisionDate: '2026-11-10', served: '2026-11-12', grounds: 'чл. 37, ал. 1, т. 2 ЗДОИ' }));
  assert.equal(ok.ok, true);
  const after = await admin.call('case.get', { regNo: r.regNo });
  assert.equal(after.case.appealBy, '2026-11-26');
  assert.ok(after.events.some(e => e.kind === 'Промяна' && /Статус: Решение издадено/.test(e.text)));
});

test('преписки: видимост, наблюдател, заключване', async () => {
  const { env, outbox, admin } = await ready();
  const staff = await addUser(env, outbox, admin, 'petar', 'Служител', { perms: ['inReg', 'inRegEdit', 'lock', 'comment'] });
  const viewer = await addUser(env, outbox, admin, 'nabl', 'Наблюдател');
  const { regNo } = await admin.call('case.create', caseData());
  assert.equal((await staff.call('case.get', { regNo })).error, 'notfound');
  assert.equal((await staff.call('case.list')).cases.length, 0);
  await admin.call('case.assign', { regNo, owner: 'petar' });
  assert.ok(outbox.some(m => m.to === 'petar@example.org' && /отговорник/.test(m.subject)));
  assert.equal((await staff.call('case.get', { regNo })).case.owner, 'petar');
  assert.equal((await viewer.call('case.get', { regNo })).case.regNo, regNo);
  assert.equal((await viewer.call('case.comment', { regNo, text: 'x' })).error, 'role');
  assert.equal((await staff.call('case.lock', { regNo, locked: true })).locked, true);
  assert.equal((await admin.call('case.comment', { regNo, text: 'x' })).error, 'caselocked');
  assert.equal((await admin.call('case.lock', { regNo, locked: false })).locked, false);
  assert.equal((await admin.call('case.comment', { regNo, text: 'бележка' })).ok, true);
});

test('дела и адресати', async () => {
  const { admin } = await ready();
  const { regNo } = await admin.call('case.create', caseData({ saveAddressee: true }));
  assert.equal((await admin.call('addressee.list')).addressees.length, 1);
  const c = await admin.call('court.save', { regNo, court: 'Административен съд – София-град', caseNo: '1234', year: '2026', kind: 'Жалба срещу решение', instance: 'Административен съд', status: 'Образувано', nextHearing: '2026-12-01' });
  assert.equal(c.ok, true);
  const got = await admin.call('case.get', { regNo });
  assert.equal(got.courts.length, 1);
  assert.equal(got.case.appealed, 'Да');
  assert.equal((await admin.call('court.save', { regNo, court: 'Административен съд – София-град', caseNo: '1234', year: '2026', kind: 'Жалба срещу решение', instance: 'Административен съд', status: 'Образувано' })).error, 'duplicate');
  const dash = await admin.call('dashboard');
  assert.equal(dash.total, 1);
  assert.equal((await admin.call('court.delete', { id: c.id })).ok, true);
});

test('напомняния за срокове – веднъж на ден', async () => {
  const { env, outbox, admin } = await ready();
  await admin.call('case.create', caseData({ regDate: '2026-11-02', owner: 'admin' }));
  const { remindDeadlines } = await import('../worker/src/cases.js');
  const { makeApp } = await import('../worker/src/core.js');
  const app = makeApp(env, env.__store, env.__kv, null);
  const r = await remindDeadlines(app, new Date('2026-11-13T09:00:00+02:00')); // 3 дни до 16.11
  assert.equal(r.sent, 1);
  assert.ok(/ВХ-2026-0001/.test(outbox.pop().text));
  assert.equal((await remindDeadlines(app, new Date('2026-11-13T10:00:00+02:00'))).skipped, 'вече изпратено');
});
