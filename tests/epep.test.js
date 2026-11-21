import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready, addUser, caseData } from './helpers.js';
import { courtKey, gidOf } from '../worker/src/epep.js';
import { epepDaily } from '../worker/src/courts.js';
import { makeApp } from '../worker/src/core.js';

const GID = '226c7704-41f9-4fb6-be1b-b0a33c6db050';

/* ЕПЕП в паметта – отговори във формата на истинския портал */
function fakeEpep(state) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body), data = JSON.parse(body.data);
    calls.push({ path, data });
    const out = rows => new Response(JSON.stringify({ page: 1, size: body.size, total_rows: rows.length, data: rows }), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/Case/LoadData') return out(state.cases.filter(c => String(c.regNumber) === data.RegNumber && String(c.regYear) === data.RegYear));
    if (data.gid !== GID) return out([]);
    return out({ '/Case/HearingsLoadData': state.hearings, '/Case/ActsLoadData': state.acts, '/Case/SidesLoadData': state.sides, '/Case/AssignmentsLoadData': state.assignments, '/Case/ConnectedCaseLoadData': [] }[path] || []);
  };
  fn.calls = calls;
  return fn;
}
const baseState = () => ({
  cases: [
    { gid: GID, courtName: 'Административен съд - София-град', caseKindName: 'Административно дело', incommingNumber: 2623, regNumber: 1200, regYear: 2026, formationDate: '2026-02-05T12:00:00', judgeReporter: 'Мария Бойкинова', departmentName: 'II Отделение', panelName: '50 състав', sideLeft: 'Сдружение', sideRight: 'Столична община' },
    { gid: '11111111-2222-3333-4444-555555555555', courtName: 'Районен съд - Трявна', caseKindName: 'Гражданско дело', regNumber: 1200, regYear: 2026, formationDate: '2026-01-01T00:00:00' }
  ],
  hearings: [{ gid: 'h1', date: '2099-05-27T10:30:00', hearingType: 'Открито', hearingResult: '', isCanceled: false, secretaryName: 'Ива Лещарова', prosecutorName: null, courtRoom: '12', videoUrl: null }],
  acts: [{ gid: 'a1', actKindName: 'Разпореждане', number: 17871, dateSigned: '2026-02-06T11:15:34', dateInPower: null, preparators: [{ judgeName: 'Мария Бойкинова', judgeRole: 'Докладчик' }] }],
  sides: [{ gid: 's1', subjectName: 'Сдружение „Просвета“', sideInvolvementKindName: 'Жалбоподател', lawyers: [] }, { gid: 's2', subjectName: 'Кмет на Столична община', sideInvolvementKindName: 'Ответник', lawyers: [] }],
  assignments: [{ gid: 'x1', judgeName: 'Мария Бойкинова', date: '2026-02-05T09:09:10', type: 'Автоматично', assignor: 'Зорница Дойчинова' }]
});

test('ЕПЕП: имената на съдилищата и идентификаторът от връзка', () => {
  assert.equal(courtKey('Административен съд - София-град'), courtKey('Административен съд – София-град'));
  assert.equal(gidOf('https://ecase.justice.bg/Case/CaseDetail/' + GID.toUpperCase()), GID);
});

test('ЕПЕП: автоматично свързване, състав, заседания, актове, страни; промени и известие до отговорника', async () => {
  const { env, outbox, admin } = await ready();
  const state = baseState();
  env.__epep = fakeEpep(state);
  const ivan = await addUser(env, outbox, admin, 'ivan', 'Служител', { perms: ['inReg', 'courts', 'casesAll'] });
  const { regNo } = await admin.call('case.create', caseData());
  // при създаване делото се намира в ЕПЕП по съд, номер и година (другият съд със същия номер се пропуска)
  const c = await admin.call('court.save', { regNo, court: 'Административен съд – София-град', caseNo: '1200', year: '2026', kind: 'Жалба срещу решение', instance: 'Първа инстанция', status: 'Образувано', owner: 'ivan' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.ok(outbox.some(m => m.to === 'ivan@example.org' && /отговорник по делото/.test(m.text)));
  let g = await ivan.call('court.get', { id: c.id });
  assert.equal(g.court.owner, 'ivan');
  assert.equal(g.court.epep.gid, GID);
  assert.equal(g.details.panel.reporter, 'Мария Бойкинова');
  assert.equal(g.details.panel.division, 'II Отделение, 50 състав');
  assert.equal(g.details.instituted, '2026-02-05');
  assert.equal(g.details.hearings[0].time, '10:30');
  assert.equal(g.court.nextHearing, '2099-05-27');
  assert.equal(g.court.status, 'Насрочено');
  assert.equal(g.details.acts[0].kind, 'Разпореждане');
  assert.equal(g.details.parties.length, 2);
  assert.equal(g.court.respondent, 'Кмет на Столична община');

  // ново решение и влизане в сила: окончателно по чл. 40, ал. 3 ЗДОИ; срок за ново произнасяне на органа
  await ivan.call('court.part', { id: c.id, part: 'acts', item: Object.assign({}, g.details.acts[0], { served: '2026-02-09' }) });
  state.acts.push({ gid: 'a2', actKindName: 'Решение', number: 555, dateSigned: '2026-06-10T10:00:00', dateInPower: '2026-06-10T10:00:00', preparators: [{ judgeName: 'Мария Бойкинова', judgeRole: 'Докладчик' }] });
  state.hearings[0].hearingResult = 'Обявено за решаване';
  outbox.length = 0;
  const r = await admin.call('court.epep', { id: c.id });
  assert.ok(r.changes.some(t => /Нов акт: решение № 555/.test(t)), JSON.stringify(r));
  assert.ok(outbox.some(m => m.to === 'ivan@example.org' && /решение № 555/.test(m.text)));
  g = await ivan.call('court.get', { id: c.id });
  const dec = g.details.acts.find(a => a.kind === 'Решение');
  assert.equal(dec.remedy, 'Окончателно (чл. 40, ал. 3 ЗДОИ)');
  assert.equal(dec.finalOn, '2026-06-10');
  assert.equal(g.court.status, 'Влязло в сила');
  assert.equal(g.details.acts.find(a => a.kind === 'Разпореждане').served, '2026-02-09'); // нашите полета остават
  // отменен отказ → срок за органа
  await ivan.call('court.part', { id: c.id, part: 'acts', item: Object.assign({}, dec, { outcome: 'Отменя и връща преписката на органа' }) });
  g = await ivan.call('court.get', { id: c.id });
  assert.ok(g.deadlines.some(dl => dl.kind === 'Изпълнение' && dl.date === '2026-06-24'));
  // без промени – няма ново известие и няма дублиране
  outbox.length = 0;
  const again = await admin.call('court.epep', { id: c.id });
  assert.deepEqual(again.changes, []);
  assert.equal(outbox.length, 0);
  assert.equal((await ivan.call('court.get', { id: c.id })).details.acts.length, 2);
});

test('отговорник по делото: въвелият е отговорник; смяна – само с право „Разпределя преписки“', async () => {
  const { env, outbox, admin } = await ready();
  const ivan = await addUser(env, outbox, admin, 'ivan', 'Служител', { perms: ['inReg', 'courts', 'casesAll'] });
  await addUser(env, outbox, admin, 'maria', 'Служител');
  const { regNo } = await admin.call('case.create', caseData());
  const c = await ivan.call('court.save', { regNo, court: 'Административен съд – Варна', caseNo: '9', year: '2026', kind: 'Жалба срещу мълчалив отказ', instance: 'Първа инстанция', status: 'Образувано' });
  assert.equal((await ivan.call('court.get', { id: c.id })).court.owner, 'ivan');
  assert.equal((await ivan.call('court.assign', { id: c.id, owner: 'maria' })).error, 'role');
  assert.equal((await ivan.call('court.save', { regNo, court: 'Административен съд – Варна', caseNo: '10', year: '2026', kind: 'Жалба срещу решение', instance: 'Първа инстанция', status: 'Образувано', owner: 'maria' })).error, 'role');
  assert.equal((await admin.call('court.assign', { id: c.id, owner: 'maria' })).owner, 'maria');
});

test('жалба чрез органа: срок по чл. 152, ал. 2 АПК; ЕПЕП – няколко дела или нито едно', async () => {
  const { env, admin } = await ready();
  env.__epep = fakeEpep(baseState());
  const { regNo } = await admin.call('case.create', caseData());
  const c = await admin.call('court.save', { regNo, court: 'Административен съд – Пловдив', caseNo: '77', year: '2026', kind: 'Жалба срещу решение', instance: 'Първа инстанция', status: 'Образувано', appealBy: '2026-11-20' });
  await admin.call('court.part', { id: c.id, part: 'filings', item: { date: '2026-11-18', kind: 'Жалба', dir: 'Подадено от нас', via: 'Чрез органа (чл. 152 АПК)' } });
  const g = await admin.call('court.get', { id: c.id });
  assert.ok(g.deadlines.some(dl => dl.kind === 'Срок на органа' && dl.date === '2026-11-23'), JSON.stringify(g.deadlines)); // 20.11 + 3 = 23.11 (понеделник)
  const r = await admin.call('court.epep', { id: c.id });
  assert.equal(r.found, 0);
});

test('ЕПЕП: ежедневна проверка по няколко дела на пускане', async () => {
  const { env, admin } = await ready();
  env.__epep = fakeEpep(baseState());
  const { regNo } = await admin.call('case.create', caseData());
  for (const n of ['1', '2', '3', '4']) await admin.call('court.save', { regNo, court: 'Административен съд – Русе', caseNo: n, year: '2026', kind: 'Жалба срещу решение', instance: 'Първа инстанция', status: 'Образувано', epep: false });
  const app = makeApp(env, env.__store, env.__kv, null);
  const at = new Date('2026-11-23T08:00:00+02:00');
  assert.equal((await epepDaily(app, new Date('2026-11-23T05:00:00+02:00'))).skipped, 'рано');
  const a = await epepDaily(app, at, 3);
  assert.equal(a.checked, 3);
  const b = await epepDaily(app, at, 3);
  assert.equal(b.checked, 1);
  assert.equal((await epepDaily(app, at, 3)).checked, 0);
});
