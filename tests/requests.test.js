import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready } from './helpers.js';
import { withReqDue, pollMail, tagOf } from '../worker/src/requests.js';
import { makeApp } from '../worker/src/core.js';

const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(200) + '\n%%EOF').toString('base64');

function fakeMailbox() {
  const box = { sent: [], inbox: [] };
  box.send = async m => { box.sent.push(m); return {}; };
  box.fetchSince = async since => box.inbox.filter(m => m.at >= since);
  return box;
}

const reqData = (over = {}) => Object.assign({
  mode: 'Клиент', kind: 'Достъп до обществена информация', title: 'Договори за почистване',
  applicant: { type: 'Гражданин', name: 'Иван Иванов', address: 'п.к. 1000, гр. София', email: 'ivan@example.org' },
  entity: { name: 'Столична община', regBasis: 'Код по БУЛСТАТ (Закон за регистър БУЛСТАТ)', eik: '000696327', email: 'obshtina@example.org', address: 'гр. София, ул. Московска 33' },
  points: ['Копия на договорите за 2025 г.', 'Анексите към тях'], motives: 'Обществен интерес.',
  access: ['Копия, предоставени по електронен път, или интернет адрес, на който се съхраняват или са публикувани данните (чл. 26, ал. 1, т. 4)'], noPublish: false
}, over);

async function setupReq() {
  const r = await ready();
  r.box = fakeMailbox();
  r.env.__mailbox = r.box;
  r.env.MAILBOX = 'priemna@zdoi.eu';
  return r;
}

test('заявление: чернова → Изх. № → PDF → изпращане с етикет за отговор', async () => {
  const { admin, box } = await setupReq();
  const c = await admin.call('req.create', reqData());
  assert.equal(c.regNo, 'П-2026-0001');
  assert.equal((await admin.call('req.create', reqData({ entity: { name: 'X', eik: '123' } }))).error, 'eik');

  const d1 = await admin.call('doc.reserve', { regNo: c.regNo, kind: 'Заявление', payload: { points: ['a'] } });
  assert.equal(d1.outNo, 'ЗДОИ-2026-0001');
  // редакция на неизпратен документ пази номера
  assert.equal((await admin.call('doc.reserve', { regNo: c.regNo, kind: 'Заявление', outNo: d1.outNo, payload: { points: ['b'] } })).outNo, 'ЗДОИ-2026-0001');
  assert.equal((await admin.call('doc.file', { outNo: d1.outNo, pdf: Buffer.from('not a pdf').toString('base64') })).error, 'value');
  assert.equal((await admin.call('doc.file', { outNo: d1.outNo, pdf: PDF })).ok, true);

  const s = await admin.call('mail.send', { regNo: c.regNo, to: 'obshtina@example.org', subject: '[П-2026-0001] Заявление', text: 'Приложено…', docs: [d1.outNo] });
  assert.equal(s.ok, true);
  assert.match(s.replyTo, /^priemna\+[a-z][a-z0-9]{5}-2026-0001@zdoi\.eu$/);
  assert.equal(box.sent[0].replyTo, s.replyTo);
  assert.equal(box.sent[0].attachments[0].name, 'ЗДОИ-2026-0001 Заявление.pdf');

  const g = await admin.call('req.get', { regNo: c.regNo });
  assert.equal(g.request.status, 'Изпратено');
  assert.equal(g.request.outNo, 'ЗДОИ-2026-0001');
  assert.ok(g.request.due);
  assert.equal(g.mail.length, 1);
  // изпратеният документ не се редактира
  assert.equal((await admin.call('doc.reserve', { regNo: c.regNo, kind: 'Заявление', outNo: d1.outNo, payload: {} })).error, 'value');
  // второ заявление през годината взема следващия номер
  assert.equal((await admin.call('doc.reserve', { regNo: c.regNo, kind: 'Уточнение', payload: {} })).outNo, 'ЗДОИ-2026-0002');
});

test('входяща поща: етикет след „+“, номер в темата, неразпределени', async () => {
  const { env, admin, box, outbox } = await setupReq();
  const { regNo } = await admin.call('req.create', reqData({ owner: 'admin' }));
  const { regNo: second } = await admin.call('req.create', reqData());
  await admin.call('req.assign', { regNo: second, owner: 'admin' });
  const base = { cc: [], body: 'Отговор', fromName: 'Деловодство', attachments: [] };
  const ago = m => new Date(Date.now() - m * 60000).toISOString().slice(0, 19) + 'Z';
  box.inbox.push(
    Object.assign({}, base, { graphId: 'g1', messageId: '<1@x>', at: ago(30), from: 'obshtina@example.org', to: ['priemna+' + tagOf(regNo) + '@zdoi.eu'], subject: 'Re: заявление',
      attachments: [{ name: 'решение.pdf', contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) }] }),
    Object.assign({}, base, { graphId: 'g2', messageId: '<2@x>', at: ago(25), from: 'other@example.org', to: ['priemna@zdoi.eu'], subject: 'Относно ' + second }),
    Object.assign({}, base, { graphId: 'g3', messageId: '<3@x>', at: ago(24), from: 'spam@example.org', to: ['priemna@zdoi.eu'], subject: 'Здравейте' })
  );
  const app = makeApp(env, env.__store, env.__kv, null);
  const run = await pollMail(app, { manual: true });
  assert.equal(run.saved, 3);
  assert.equal(run.matched, 2);
  // повторното четене не дублира писмата
  assert.equal((await pollMail(app, { manual: true })).saved, 0);

  const g = await admin.call('req.get', { regNo });
  assert.equal(g.mail.length, 1);
  assert.match(g.mail[0].matched, /етикет/);
  assert.equal(g.mail[0].attachments[0].name, 'решение.pdf');
  const att = await admin.call('mail.attachment', { id: g.mail[0]._id, index: 0 });
  assert.equal(Buffer.from(att.data, 'base64').toString(), '%PDF');
  assert.equal((await admin.call('req.get', { regNo: second })).mail[0].matched, 'номер в темата');

  const inbox = await admin.call('mail.inbox');
  assert.equal(inbox.mail.length, 1);
  assert.equal((await admin.call('mail.assign', { id: inbox.mail[0]._id, regNo })).ok, true);
  assert.equal((await admin.call('mail.inbox')).mail.length, 0);
  assert.ok(outbox.some(m => /Получено писмо/.test(m.text)));
});

test('срокове от страната на заявителя', () => {
  const sent = withReqDue({ status: 'Изпратено', sentAt: '2026-11-02', entityRegDate: '2026-11-03' }, '2026-11-10');
  assert.equal(sent.due, '2026-11-17');
  assert.equal(sent.silentBy, '2026-12-17');
  const clar = withReqDue({ status: 'Чака уточняване', sentAt: '2026-11-02', clarifyAskedAt: '2026-11-05' }, '2026-11-10');
  assert.equal(clar.ours, true);
  assert.equal(clar.due, '2026-12-07');
  const after = withReqDue({ status: 'Уточнено', sentAt: '2026-11-02', clarifyAskedAt: '2026-11-05', clarifySentAt: '2026-11-09' }, '2026-11-10');
  assert.equal(after.due, '2026-11-23');
  const refused = withReqDue({ status: 'Отказ', sentAt: '2026-11-02', outcome: 'Отказ', servedAt: '2026-11-20' }, '2026-11-21');
  assert.equal(refused.appealBy, '2026-12-04');
  assert.equal(refused.due, '');
});

test('системни процеси: само администратор, профил на Сдружението', async () => {
  const { admin } = await setupReq();
  const g = await admin.call('system.get');
  assert.equal(g.nextOutNo, 'ЗДОИ-2026-0001');
  assert.match(g.sampleReplyTo, /^priemna\+[a-z][a-z0-9]{5}-2026-0001@zdoi\.eu$/);
  const s = await admin.call('system.save', { org: Object.assign({}, g.org, { eik: '175074752' }), mailPoll: false });
  assert.equal(s.org.eik, '175074752');
  assert.equal(s.mailPoll, false);
  assert.equal((await admin.call('system.save', { org: Object.assign({}, g.org, { eik: '123456789' }) })).error, 'eik');
});

test('изпращане извън имейла: ССЕВ, поща, лично в деловодството; получено по пощата', async () => {
  const { admin, box } = await setupReq();
  const { regNo } = await admin.call('req.create', reqData());
  const d1 = await admin.call('doc.reserve', { regNo, kind: 'Заявление', payload: { points: ['a'] } });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
  const past = new Date(Date.now() - 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
  // проверки
  assert.equal((await admin.call('mail.record', { regNo, channel: 'Гълъб', date: today, docs: [d1.outNo] })).error, 'value');
  assert.equal((await admin.call('mail.record', { regNo, channel: 'Поща', date: '2999-01-01', docs: [d1.outNo] })).error, 'date');
  assert.equal((await admin.call('mail.record', { regNo, channel: 'Поща', date: today })).error, 'required');
  assert.equal((await admin.call('mail.record', { regNo, channel: 'Поща', date: today, docs: [d1.outNo], file: { name: 'x.exe', contentType: 'application/x-msdownload', data: PDF } })).error, 'value');

  // подадено лично в деловодството преди 3 дни, с вх. № и копие с печат
  const rec = await admin.call('mail.record', { regNo, channel: 'На място', date: past, docs: [d1.outNo], entityRegNo: 'СОА26-ГР94-77', entityRegDate: past,
    file: { name: 'копие с печат.pdf', contentType: 'application/pdf', data: PDF } });
  assert.equal(rec.ok, true);
  let g = await admin.call('req.get', { regNo });
  assert.equal(g.request.status, 'Изпратено');
  assert.equal(g.request.sentAt, past);
  assert.equal(g.request.sentHow, 'На място');
  assert.equal(g.request.entityRegNo, 'СОА26-ГР94-77');
  assert.equal(g.request.entityRegDate, past);
  assert.ok(g.request.due);
  assert.equal(g.docs[0].sentHow, 'На място');
  assert.equal(g.mail[0].channel, 'На място');
  assert.equal(g.mail[0].attachments[0].name, 'копие с печат.pdf');
  assert.equal(box.sent.length, 0);
  // доказателството се сваля
  const f = await admin.call('mail.attachment', { id: g.mail[0]._id, index: 0 });
  assert.equal(f.data, PDF);
  // изпратено и през ССЕВ днес: сроковете не се местят
  await admin.call('mail.record', { regNo, channel: 'Сигурно електронно връчване', date: today, docs: [d1.outNo], ref: 'a1b2c3' });
  g = await admin.call('req.get', { regNo });
  assert.equal(g.request.sentAt, past);
  assert.match(g.docs[0].sentTo, /На място.*; Сигурно електронно връчване: a1b2c3/);
  // уточнение по пощата
  await admin.call('req.update', Object.assign(reqData(), { regNo, status: 'Чака уточняване', sentAt: past, sentHow: 'На място', entityRegNo: 'СОА26-ГР94-77', entityRegDate: past, clarifyAskedAt: today }));
  const d2 = await admin.call('doc.reserve', { regNo, kind: 'Уточнение', payload: { points: ['b'] } });
  await admin.call('mail.record', { regNo, channel: 'Поща', postKind: 'Препоръчано с обратна разписка', date: today, docs: [d2.outNo], ref: 'RR123456789BG' });
  g = await admin.call('req.get', { regNo });
  assert.equal(g.request.status, 'Уточнено');
  assert.equal(g.request.clarifySentAt, today);
  assert.match(g.mail.find(m => m.channel === 'Поща').body, /обратна разписка[\s\S]*RR123456789BG/);
  // получено решение по пощата
  const inc = await admin.call('mail.record', { regNo, direction: 'Входяща', channel: 'Поща', date: today, subject: 'Решение № 12', ref: '94-00-1/2026' });
  assert.equal(inc.ok, true);
  g = await admin.call('req.get', { regNo });
  assert.equal(g.mail.find(m => m.direction === 'Входяща').from, 'Столична община');
  assert.ok(g.events.some(e => e.kind === 'Входящо писмо' && /Решение № 12/.test(e.text)));
});

test('уточнение по инициатива на заявителя не мести сроковете; по искане на органа – мести', async () => {
  const { admin } = await setupReq();
  const { regNo } = await admin.call('req.create', reqData());
  const past = new Date(Date.now() - 5 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
  await admin.call('req.update', Object.assign(reqData(), { regNo, status: 'Изпратено', sentAt: past, sentHow: 'Имейл' }));
  const own = await admin.call('doc.reserve', { regNo, kind: 'Уточнение', payload: { clarifyBy: 'Инициатива на заявителя', points: ['x'] } });
  await admin.call('mail.record', { regNo, channel: 'Поща', date: today, docs: [own.outNo] });
  let g = await admin.call('req.get', { regNo });
  assert.equal(g.request.status, 'Изпратено');
  assert.equal(g.request.clarifySentAt, '');
  await admin.call('req.update', Object.assign(reqData(), { regNo, status: 'Чака уточняване', sentAt: past, sentHow: 'Имейл', clarifyAskedAt: past }));
  const byOrgan = await admin.call('doc.reserve', { regNo, kind: 'Уточнение', payload: { clarifyBy: 'Искане на органа', points: ['y'] } });
  await admin.call('mail.record', { regNo, channel: 'Поща', date: today, docs: [byOrgan.outNo] });
  g = await admin.call('req.get', { regNo });
  assert.equal(g.request.status, 'Уточнено');
  assert.equal(g.request.clarifySentAt, today);
});

test('известие от ССЕВ по имейл се разпределя по институцията; чужд подател – не', async () => {
  const { env, admin, box } = await setupReq();
  const { regNo } = await admin.call('req.create', reqData());
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
  const d1 = await admin.call('doc.reserve', { regNo, kind: 'Заявление', payload: { points: ['a'] } });
  await admin.call('mail.record', { regNo, channel: 'Сигурно електронно връчване', date: today, docs: [d1.outNo], ref: 'ССЕВ-123' });
  const ago = m => new Date(Date.now() - m * 60000).toISOString().slice(0, 19) + 'Z';
  box.inbox.push(
    { graphId: 's1', messageId: '<s1@x>', at: ago(10), from: 'noreply@edelivery.egov.bg', fromName: 'ССЕВ', to: ['priemna@zdoi.eu'], cc: [], attachments: [],
      subject: 'Ново съобщение в Системата за сигурно електронно връчване', body: 'Получихте ново съобщение от СТОЛИЧНА ОБЩИНА. Влезте в профила си, за да го прочетете.' },
    { graphId: 's2', messageId: '<s2@x>', at: ago(9), from: 'spam@example.org', fromName: '', to: ['priemna@zdoi.eu'], cc: [], attachments: [],
      subject: 'ССЕВ: Столична община', body: 'фалшиво' });
  const run = await pollMail(makeApp(env, env.__store, env.__kv, null), { manual: true });
  assert.equal(run.saved, 2);
  assert.equal(run.matched, 1);
  const g = await admin.call('req.get', { regNo });
  const m = g.mail.find(x => x.direction === 'Входяща');
  assert.equal(m.channel, 'Сигурно електронно връчване');
  assert.match(m.matched, /ССЕВ: Столична община/);
  assert.ok(g.events.some(e => e.kind === 'Съобщение в ССЕВ'));
  const inbox = await admin.call('mail.inbox');
  assert.equal(inbox.mail.length, 1);
  assert.equal(inbox.mail[0].channel, 'Имейл');
});
