import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready, addUser, caseData } from './helpers.js';
import { remedyDue, detailsOf, courtView } from '../worker/src/courts.js';

test('процесуални срокове по АПК и ГПК (от съобщаването, с местене на работен ден)', () => {
  // АПК: касационна жалба 14 дни; 05.11.2026 + 14 = 19.11.2026 (четвъртък)
  assert.equal(remedyDue('АПК', 'Касационна жалба', '2026-11-05').due, '2026-11-19');
  // АПК: частна жалба 7 дни; 07.11.2026 + 7 = 14.11.2026 (събота) → 16.11.2026
  assert.equal(remedyDue('АПК', 'Частна жалба', '2026-11-07').due, '2026-11-16');
  // ГПК: въззивна жалба 2 седмици; касационна 1 месец; частна 1 седмица
  assert.equal(remedyDue('ГПК', 'Въззивна жалба', '2026-11-04').due, '2026-11-18');
  assert.equal(remedyDue('ГПК', 'Касационна жалба', '2026-10-15').due, '2026-11-16'); // 15.11 е неделя
  assert.equal(remedyDue('ГПК', 'Частна жалба', '2026-12-17').due, '2026-12-29'); // 24–26.12, неделя и 28.12 (26.12 е събота – почива се в понеделник)
  assert.match(remedyDue('ГПК', 'Отговор на искова молба', '2026-11-02').label, /чл\. 131/);
  assert.equal(remedyDue('АПК', 'Касационна жалба', ''), null);
});

test('стари бележки по делото се пазят като текст', () => {
  const det = detailsOf({ note: 'Стара бележка' });
  assert.equal(det.text, 'Стара бележка');
  assert.deepEqual(det.hearings, []);
  assert.equal(courtView({ _id: '1', note: 'Стара бележка', instance: 'Върховен административен съд' }).instance, 'Касационна инстанция');
});

test('дело: състав, ЕПЕП, заседания, актове със срок, такси, срокове, календар и история', async () => {
  const { env, outbox, admin } = await ready();
  const { regNo } = await admin.call('case.create', caseData());
  const c = await admin.call('court.save', { regNo, court: 'Административен съд – София-град', caseNo: '1234', year: '2026', kind: 'Жалба срещу решение', instance: 'Първа инстанция', status: 'Образувано', procedure: 'АПК', instituted: '2026-11-03', note: 'бележка' });
  assert.equal(c.ok, true, JSON.stringify(c));
  const id = c.id;
  assert.equal((await admin.call('court.part', { id, part: 'panel', item: { formation: 'Едноличен', division: 'II отделение, 25 състав', reporter: 'Иванова' } })).ok, true);
  assert.equal((await admin.call('court.part', { id, part: 'epep', item: { url: 'https://evil.example.org/x' } })).error, 'value');
  assert.equal((await admin.call('court.part', { id, part: 'epep', item: { url: 'https://ecase.justice.bg/case/123', access: 'Предоставен', eserve: true } })).ok, true);
  assert.equal((await admin.call('court.part', { id, part: 'parties', item: { role: 'Жалбоподател', name: 'Иван Иванов' } })).ok, true);
  // заседанията обновяват „следващо заседание“
  await admin.call('court.part', { id, part: 'hearings', items: [{ date: '2099-01-15', time: '10:30', kind: 'Открито заседание', room: '5' }, { date: '2099-02-20', time: '09:00' }] });
  let g = await admin.call('court.get', { id });
  assert.equal(g.court.nextHearing, '2099-01-15');
  assert.equal(g.details.hearings.length, 2);
  assert.equal(g.details.panel.reporter, 'Иванова');
  assert.equal(g.court.note, 'бележка');
  // акт с касационна жалба: срок от съобщаването
  assert.equal((await admin.call('court.part', { id, part: 'acts', item: { kind: 'Решение', no: '77', date: '2026-11-02', served: '2026-11-05', outcome: 'Отменя и връща преписката на органа', remedy: 'Касационна жалба' } })).ok, true);
  g = await admin.call('court.get', { id });
  assert.equal(g.details.acts[0].deadline.due, '2026-11-19');
  assert.equal(g.court.status, 'Решено');
  assert.ok(g.deadlines.some(dl => dl.date === '2026-11-19' && /Касационна жалба/.test(dl.label)));
  // такси
  await admin.call('court.part', { id, part: 'fees', item: { kind: 'Държавна такса', amount: '25,56', status: 'Платена', date: '2026-11-03' } });
  await admin.call('court.part', { id, part: 'fees', item: { kind: 'Присъдени разноски', amount: '100', status: 'Присъдена в наша полза' } });
  assert.equal((await admin.call('court.part', { id, part: 'fees', item: { kind: 'Държавна такса', amount: '12,345', status: 'Платена' } })).error, 'value');
  g = await admin.call('court.get', { id });
  assert.equal(g.totals.paid, 25.56);
  assert.equal(g.totals.awardedFor, 100);
  // срок, определен от съда, и изпълнение
  await admin.call('court.part', { id, part: 'deadlines', item: { label: 'Писмени бележки', due: '2099-03-01', basis: 'указание на съда' } });
  g = await admin.call('court.get', { id });
  const dl = g.details.deadlines[0];
  await admin.call('court.part', { id, part: 'deadlines', item: Object.assign({}, dl, { done: true }) });
  g = await admin.call('court.get', { id });
  assert.equal(g.details.deadlines[0].done, true);
  // премахване
  assert.equal((await admin.call('court.part', { id, part: 'hearings', remove: g.details.hearings[1].id })).ok, true);
  // история на делото и на преписката
  g = await admin.call('court.get', { id });
  assert.ok(g.events.length >= 8);
  const cg = await admin.call('case.get', { regNo });
  assert.ok(cg.events.some(e => e.kind === 'Дело' && /решение № 77/.test(e.text)));
  assert.equal(cg.courts[0].note, 'бележка');
  // календар: заседание с час и срокът за касационна жалба
  const cal = await admin.call('calendar', { person: 'zdoi' });
  assert.ok(cal.events.some(e => e.kind === 'Съдебно заседание' && e.date === '2099-01-15' && e.time === '10:30'));
  assert.ok(cal.events.some(e => e.kind === 'Процесуален срок' && e.date === '2026-11-19'));
  // основните данни не изтриват подробностите
  await admin.call('court.save', { id, regNo, court: 'Административен съд – София-град', caseNo: '1234', year: '2026', kind: 'Жалба срещу решение', instance: 'Първа инстанция', status: 'Обжалвано' });
  g = await admin.call('court.get', { id });
  assert.equal(g.details.acts.length, 1);
  assert.equal(g.details.fees.length, 2);
  // без право „Води съдебни дела“ – само преглед
  const nabl = await addUser(env, outbox, admin, 'nabl', 'Наблюдател');
  assert.equal((await nabl.call('court.get', { id })).ok, true);
  assert.equal((await nabl.call('court.part', { id, part: 'parties', item: { role: 'Ответник', name: 'X' } })).error, 'role');
});

test('bootstrap: всички списъци за формулярите (вид адресат, статуси, дела)', async () => {
  const { admin } = await ready();
  const b = await admin.call('bootstrap');
  ['addresseeTypes', 'applicantTypes', 'statuses', 'kinds', 'channels', 'outcomes', 'servedHow', 'courtKinds', 'courts', 'reqStatuses', 'docKinds'].forEach(k => assert.ok(Array.isArray(b.lists[k]) && b.lists[k].length, k));
});
